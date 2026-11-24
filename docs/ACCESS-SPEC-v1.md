# Maitian-Hub · 多租户与访问体系实施规格 v1.1（D5 v3，交实现 LLM 直接执行）

> 文档性质：自包含规格，实现 LLM 零背景可开工。基线：仓库 main（≥ `50768ea`，含自进化四回路）。
> **v1.1 变更（2026-11-24 用户拍板 D5 v3）**：推翻 v1.0「不做密码」的结论——新增 **Web 素材台（密码登录，人看）**；CLI 通道保持**设备密钥**（agent 用）不变。密码面刻意收窄为「Web 只读浏览 + 账号管理」，写操作仍走密钥。动手前通读 `README.md`、`backend/cloud/server.mjs`、`backend/cloud/store.mjs`、`test/smoke.mjs`。

## 1. 前因

### 1.1 现状与痛点（为什么改）

D5 原文：「鉴权 = 共享 workspace_key，不做用户注册/管理后台」。单团队自用期正确，现在三个痛点：

1. **一把钥匙全家共用**：无法区分谁做了什么，无法单独吊销某个人（走人=全员换钥+重启）。
2. **加人要登服务器改 .env**：密钥是环境变量，改起来既不安全也不智能。
3. **无法开放给第二个团队**：没有租户边界；且非技术成员没有顺手的查看入口（curl 不现实）。

### 1.2 用户拍板的混合模型（D5 v3，2026-11-24）

```
人（浏览器） ──密码登录──▶ Web 素材台（只读浏览：素材列表/使用记录/占用状态）
agent（CLI/hub）─ 设备密钥 ─▶ /v1 API（上传/拉取/claim/used/journal，读写）
管理员 ──ADMIN_KEY──▶ 密钥/租户/账号管理 API
```

设计边界：**密码只存在于 Web 只读面**。所有写操作（上传/claim/发布回写）仍必须持设备密钥——密码泄露的最坏后果是「看到素材列表」，而非「能写入/操作」。若未来需要 Web 写操作，另行评审，不在本规格。

### 1.3 保留 v1.0 的判定

- 不做注册页/找回密码/邮件体系：账号由 admin 开通（邀请兑换时自设密码，或 admin 直接建号+发首登密码）。
- 不做 JWT/会话服务端存储：会话=HMAC 签名 cookie（无状态，零依赖）。
- 零第三方依赖：密码哈希用 `node:crypto` 的 `scrypt` + `timingSafeEqual`；cookie 解析手写。

## 2. 数据模型（maitian-cloud，轻量迁移）

```sql
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- admin|operator|viewer
  name TEXT, key_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT,
  expires_at TEXT, revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  redeemed_at TEXT, redeemed_key_id TEXT
);
CREATE TABLE IF NOT EXISTS web_accounts(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,   -- 3-32 字符
  password_hash TEXT NOT NULL,     -- scrypt: salt$hash（hex）
  display_name TEXT, role TEXT DEFAULT 'viewer',
  created_at TEXT NOT NULL, last_login_at TEXT, revoked_at TEXT
);
-- materials / journals 加列 tenant_id（迁移：既有行归入默认租户 'default'）
```

## 3. API 契约

### 3.1 密钥体系（v1.0 原文保留）

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /v1/admin/tenants` | ADMIN_KEY | `{name}` → `{tenant_id}`；首启自动建 `default` 租户并把 `MAITIAN_WORKSPACE_KEY`（若设置）映射为其 admin 密钥（向后兼容） |
| `POST /v1/admin/invites` | ADMIN_KEY 或租户 admin | `{tenant_id?, role, note?, expires_in_days?, web_account?}` → `{code}`；`web_account:true` 时兑换同时开通同名 Web 账号 |
| `GET /v1/admin/keys?tenant_id=` | ADMIN_KEY 或本租户 admin | 密钥列表（只回显 id/name/role/last_used/revoked） |
| `DELETE /v1/admin/keys/:id` | ADMIN_KEY 或本租户 admin | 即时吊销 |
| `POST /v1/keys/redeem` | 免鉴权（邀请码即凭证） | `{code, device_name}` → `{api_key(仅此一次), tenant_id, role}`；统一 400 防枚举；限流 同IP ≤10/分 |
| `GET /v1/whoami` | 任意有效 key | `{tenant_id, role, name, key_id}` |

既有端点（materials/claim/release/used/download/journals）按 `key.tenant_id` 过滤与归属。角色：viewer 只读；operator 读写；admin = operator + 本租户管理。

### 3.2 Web 素材台（新增，密码面）

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /web/login` | 用户名+密码 | `{username,password}` → `Set-Cookie: mt_session=<payload>.<hmac>`；HttpOnly; SameSite=Lax; Secure；7 天有效；失败限流（同 username+IP 5 次失败锁 10 分钟，超限统一 429） |
| `POST /web/logout` | cookie | 使该会话 token 失效（内存黑名单即可，重启即清） |
| `POST /web/password` | cookie | `{old,new}` 改密（新密码 ≥8 位） |
| `GET /web` | cookie | 零依赖单页：未登录=登录页；已登录=素材台 |
| `GET /web/api/materials?platform=&q=&limit=&offset=` | cookie | 本租户素材列表：title/type/tags/size/created_at/used_on 历史/claim 状态；支持标题搜索与平台标签过滤 |
| `GET /web/api/materials/:id/file` | cookie | 302 → 复用 `/v1/files` 签名机制下载 |

实现要点：
- 密码哈希：`scrypt(password, salt, 16384)` 存 `salt$hash`；校验用 `timingSafeEqual`。
- 会话 token：`base64url(JSON{aid,tenant,exp,nonce})` + `HMAC-SHA256(secret)`（secret 沿用 signSecret 或独立 `MAITIAN_WEB_SECRET`）；校验签名+过期；服务端不做会话存储（logout 用内存黑名单兜底）。
- Cookie 属性：HttpOnly + SameSite=Lax + Path=/web；经 HTTPS 时加 Secure。
- CSRF 面：cookie 仅用于 `/web/api/*` 只读 GET 与页面本身，SameSite=Lax 已挡跨站 POST；写操作全在 `/v1/*`（密钥头，不走 cookie）。
- 前端单页零框架（与 hub 大屏同风格），nginx 加路由：`location /web/ { proxy_pass http://maitian-cloud:8788; }`。

### 3.3 账号开通两条路

1. admin：`POST /v1/admin/web-accounts {tenant_id, username, display_name?}` → 返回一次性初始密码（仅此一次）。
2. 邀请兑换带 `web_account:true` → `/v1/keys/redeem` 响应含 `web_setup_code` → 兑换者在 `/web/setup` 用它自设用户名密码（单次，7 天有效）。

## 4. 客户端（hub 侧，CLI 通道不变）

1. `node src/hub.mjs join <邀请码> [--name "张三-笔记本"]`：兑换设备密钥 → 写 `<dataDir>/credentials.json`（0600，不入 git）——CLI/agent 从此不再碰 env。
2. 凭证解析顺序：`credentials.json` → 旧 `MAITIAN_WORKSPACE_KEY` 环境变量（兼容期）→ 无则 doctor `actions[]` 提示要邀请码。
3. `hub doctor` 增加 whoami 自检（租户/角色/密钥名）+ credentials.json 权限检查。
4. 大屏 SERVER_TOKEN 不变（保护本机/网关大屏，与云访问体系两个面）。

## 5. 里程碑与验收

| M | 内容 | 验收 |
| --- | --- | --- |
| A1（1.5d） | cloud：五表迁移 + admin/redeem/whoami + 既有端点租户化 + scrypt 密码 | smoke：双租户互不可见；吊销即 401；viewer 写 403；旧 key 兼容；错密码限流 429；scrypt 校验过 |
| A2（1d） | Web 素材台：登录/会话/列表/搜索/下载 + `/web/setup` + 改密 | 浏览器流程手测 + smoke（login→列表→下载 302→改密→旧密码 401）；登录页与列表页在无 HTTPS 内网可用 |
| A3（1d） | hub：`join`+credentials(0600)+doctor whoami；docker nginx `/web/` 路由与 README/agent-install 更新 | 全流程：admin 发邀请 → 新机 join → 上传 → Web 登录能看到该素材 → admin 吊销 → CLI 401、Web 不受影响（账号独立）；smoke 全绿 |

按 A1→A2→A3；每步验收后进下一步。现有部署零破坏：旧 key 自动映射 default 租户。

## 6. 执行纪律

1. 零第三方依赖；`bash test/redline-check.sh` 三关全过；新功能全部带 smoke 测试（当前基线 69/69，只增不减）。
2. 明文密钥/初始密码只在创建与兑换响应中出现一次；存储一律哈希；日志与审计禁止打印明文（脱敏前 6 字符）。
3. `/v1/admin/*` 仅 ADMIN_KEY 或租户 admin；`redeem` 与 `/web/login` 均限流 + 统一错误防枚举；密码比较必须 `timingSafeEqual`。
4. 部署文档同步：公网暴露建议 HTTPS（cookie Secure 依赖它）+ IP 白名单；密钥泄露半径=单设备，密码泄露半径=只读浏览。
5. 未实现 ≠ 假装实现；不卡住原则同主规格。
6. 越界信号：出现「Web 端要做写操作（上传/删除）」「找回密码自助」「邮件/短信通知」→ 停，报告，等人类决策——都超出 D5 v3 的密码面边界。
