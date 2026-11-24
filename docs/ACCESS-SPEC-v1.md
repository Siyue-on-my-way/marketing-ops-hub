# Maitian-Hub · 多租户与访问体系实施规格 v1.0（D5 v2，交实现 LLM 直接执行）

> 文档性质：自包含规格，实现 LLM 零背景可开工。基线：仓库 main（含自进化四回路 `688d827`）。动手前通读 `README.md`、`backend/cloud/server.mjs`、`backend/cloud/store.mjs`、`test/smoke.mjs`。

## 1. 前因

### 1.1 现状与痛点（为什么改）

需求决策 D5 原文：「鉴权 = 共享 workspace_key（一个 key 找到 workspace），不做用户注册/管理后台」。该决策在单团队自用阶段是对的（最简、零管理成本），但现在暴露三个痛点：

1. **一把钥匙全家共用**：所有人共享同一个 workspace_key——无法区分谁做了什么（审计只有 device 字段）、无法单独吊销某个人（有人离开只能全员换钥+重启）。
2. **加人/换钥要登服务器改 .env**：keys 是环境变量，改动需要 SSH + 重启容器，谈不上「智能」。
3. **无法开放给第二个团队**：只有一个 workspace，数据没有租户边界；想把这套能力开放给其他团队用，必须先有租户隔离。

### 1.2 方案对比与定案

| 方案 | 内容 | 判决 |
| --- | --- | --- |
| A. 完整用户系统 | 注册/登录/密码/JWT/找回 | **否决**。需要密码基础设施与 Web 登录 UX，与产品形态（agent 驱动、无 Web 登录场景）不符；运维负担（找回密码）远超收益；违背零依赖哲学 |
| B. 每人独立 API Key + 管理端点 | 不做用户账号，人=一把命名密钥，管理走 API | **定案主体**。密钥即身份，零密码基础设施；吊销/轮换按人粒度 |
| C. B + 多租户 + 单次邀请码入职 | 在 B 上加租户边界与「不登服务器也能加人」 | **定案全量（本规格）**。租户=workspace 数据边界；邀请码让加人变成「发个码」而不是「发 env 文件」 |

保留 D5 的精神：**仍然没有密码、没有注册页、没有会话/JWT**——密钥（Bearer）仍是唯一凭证，符合零依赖与 agent 驱动的用法。本规格是 D5 的 v2 演进，不是推翻。

### 1.3 术语

- **租户（tenant）**：一个 workspace = 一个团队的数据边界（素材、台账、密钥互相不可见）。
- **成员密钥（api_key）**：发给某台设备/某个人的 Bearer 密钥，带角色与人可读名，可单独吊销。
- **邀请码（invite）**：单次有效、限时的入职凭证；运营者在本机一条命令兑换成设备密钥。
- **ADMIN_KEY**：服务器 .env 里的引导密钥（部署时人工生成），仅用于创建租户/邀请/吊销——服务器上唯一的 env 秘密。

## 2. 数据模型（maitian-cloud，轻量迁移同 auto_publish 先例）

```sql
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY,            -- 't' + 8hex
  name TEXT NOT NULL,             -- 人可读：如 '主团队'
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys(
  id TEXT PRIMARY KEY,            -- 'k' + 8hex
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- admin|operator|viewer
  name TEXT,                      -- 人可读：'张三-笔记本' / '服务器hub'
  key_hash TEXT UNIQUE NOT NULL,  -- sha256(key)，明文只显示一次
  created_at TEXT NOT NULL, last_used_at TEXT,
  expires_at TEXT,                -- 可选
  revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,          -- 'inv-' + 10hex，单次兑换
  tenant_id TEXT NOT NULL, role TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- 默认 7 天
  redeemed_at TEXT, redeemed_key_id TEXT
);
-- materials / journals 加列 tenant_id（迁移：既有行归入启动时自动建的默认租户 'default'）
```

## 3. API 契约（全部沿用 Bearer 鉴权；新增端点）

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /v1/admin/tenants` | ADMIN_KEY | `{name}` → `{tenant_id}`；部署首启自动建 `default` 租户并把 `MAITIAN_WORKSPACE_KEY`（若设置）映射为其 admin 密钥（**向后兼容**） |
| `POST /v1/admin/invites` | ADMIN_KEY 或租户 admin key | `{tenant_id?, role, note?, expires_in_days?}` → `{code}`（明文只显示一次） |
| `GET /v1/admin/keys?tenant_id=` | ADMIN_KEY 或本租户 admin | 密钥列表（哈希不回显，只回显 id/name/role/last_used/revoked） |
| `DELETE /v1/admin/keys/:id` | ADMIN_KEY 或本租户 admin | `{reason}` 即时吊销（该设备立即 401，他人不受影响） |
| `POST /v1/keys/redeem` | **免鉴权（邀请码即凭证）** | `{code, device_name}` 单次兑换 → `{api_key(明文仅此一次), tenant_id, role}`；过期/已兑/不存在均统一 400（不泄露存在性） |
| `GET /v1/whoami` | 任意有效 key | `{tenant_id, role, name, key_id}`——自检与排障 |

**既有端点的租户化改造**：materials/claim/release/used/download、journals 全部按 `key.tenant_id` 过滤与归属（上传时写入 tenant_id）；跨租户不可见。角色规则：`viewer` 只读；`operator` = 现 workspace_key 全部能力；`admin` = operator + 本租户密钥/邀请管理。redeem 端点做简单限流（同 IP 每分钟 ≤10 次）。

## 4. 客户端（hub 侧）改造

1. **入职命令**（替代改 env）：
   ```
   node src/hub.mjs join <邀请码> [--name "张三-笔记本"]
   # → POST /v1/keys/redeem → 明文 key 写入 <dataDir>/credentials.json（权限 0600，不入 git）
   # → config.json 的 cloud.base_url 已在；join 后输出 whoami 确认
   ```
2. **凭证解析顺序**：`credentials.json` → 旧 `MAITIAN_WORKSPACE_KEY` 环境变量（兼容期保留）→ 无凭证时 doctor 报 `actions[]` 提示找管理员要邀请码。
3. **`hub doctor`** 增加：whoami 自检（租户/角色/密钥名）与凭证文件权限检查（0600）。
4. 大屏 SERVER_TOKEN 保持不变（它保护的是本机/网关的大屏 API，与云租户体系是两个面；后续如需合并另行规格）。

## 5. 里程碑与验收

| M | 内容 | 验收 |
| --- | --- | --- |
| A1（1d） | cloud：三表+迁移+admin 端点+redeem+whoami+既有端点租户化 | smoke：双租户数据互不可见；吊销后该 key 立即 401；viewer 写操作 403；旧 workspace_key 仍工作（默认租户） |
| A2（1d） | hub：`join` 命令+credentials.json(0600)+doctor whoami+凭证解析顺序 | 全流程：admin 发邀请 → 新机 join → 上传素材 → admin 吊销 → 该机 401 他人无感；冒烟全绿 |
| A3（0.5d） | docker/README 与 agent-install.md 更新入职流程；.env 仅剩 ADMIN_KEY+SERVER_TOKEN | 文档与实现一致；doctor 输出的 actions[] 指引正确 |

按 A1→A2→A3；每步验收后再进下一步。现有部署零破坏升级：重启后旧 key 自动映射 default 租户 admin。

## 6. 执行纪律

1. 零第三方依赖；`bash test/redline-check.sh` 三关保持全过；新功能全部带 smoke 测试。
2. 明文密钥只在两个时刻出现：创建时（响应体）与兑换时（响应体）——存储一律 sha256；日志/审计禁止打印明文 key 或邀请码全文（脱敏前 6 字符）。
3. `/v1/admin/*` 仅 ADMIN_KEY 或租户 admin 可调；`redeem` 限流 + 统一错误防枚举。
4. 部署文档安全边界同步更新：公网暴露仍建议 HTTPS + IP 白名单；密钥泄露影响半径从「全网」缩小到「单设备」。
5. 未实现 ≠ 假装实现；不卡住原则同主规格。
6. 越界信号：如果发现「没有密码体系就做不了」的需求（如找回密钥自助、Web 登录）→ 停，报告，等人类决策——那是方案 A，本规格明确不做。
