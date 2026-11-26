# Maitian-Hub · 多租户与访问体系实施规格 v1.2（D5 v4，交实现 LLM 直接执行）

> 文档性质：自包含规格，实现 LLM 零背景可开工。基线：仓库 main（≥ `1d707e6`，含自进化四回路）。
> **变更史**：v1.0 密钥体系（D5 v2）→ v1.1 Web 素材台密码登录（D5 v3，admin 开号）→ **v1.2（本版，2026-11-24 用户拍板 D5 v4）：开放注册（账号+密码自助）+ workspace 邀请链接（邀请人=owner）+ 每账号默认 API key、可随时新建发给别人**。
> 动手前通读 `README.md`、`backend/cloud/server.mjs`、`backend/cloud/store.mjs`、`backend/src/config.mjs`、`test/smoke.mjs`。

## 1. 前因

### 1.1 现状痛点（为什么改）

1. **「网站打不开」实为令牌门槛**：服务器 2680 的页面框架正常，但大屏数据接口被 SERVER_TOKEN 拦截（401），前端未提示 → 用户看到 Invalid Date + 空白，误以为打不开。（前端 401 提示已另行修复；根治靠本规格的登录体系。）
2. 一把共享 workspace_key：无个人粒度、走人全换、加人要登服务器。
3. 非技术用户没有入口：想要「打开网站 → 注册 → 登录 → 看素材/拿 key」的常规体验。

### 1.2 定案模型（D5 v4，用户 2026-11-24 拍板）

```
浏览器（人）：打开 http://<server>:2680/  → 注册（用户名+密码）/ 登录
              → Web 门户：素材台（本 workspace 素材浏览）+ 密钥管理 + 邀请链接
CLI（agent/hub）：用「自己的默认 API key」连接（注册时自动生成；Web 密钥页可随时新建/吊销）
管理员：ADMIN_KEY 仅服务器引导（建首个租户等）；日常管理全在 Web
```

- **workspace**：注册即创建自己的 workspace 并成为 **owner**；想加入别人的 workspace → 用对方生成的**邀请链接**注册（注册页自动带上目标 workspace）。
- **API key 属于用户**（不是租户）：key 继承用户的租户与角色；每人注册即得 1 把默认 key，可创建多把分发（如给一台服务器专用）。
- **门户素材管理面**（SIY-229 扩展）：密码会话可上传/编辑/删除/释放占用**本租户素材**（人工管理操作）；claim/used/knowledge 等设备协同端点仍只在密钥通道（hub 发布流程调用）。
- 零第三方依赖不变：scrypt 哈希、HMAC 签名 cookie、手写 cookie 解析。

## 2. 数据模型（maitian-cloud，轻量迁移）

```sql
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  owner_user_id TEXT,              -- 邀请链接/注册创建者 = owner
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users(  -- 人：一个用户归属一个 workspace（v1 简化）
  id TEXT PRIMARY KEY,             -- 'u'+8hex
  tenant_id TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,   -- 3-32 字符
  password_hash TEXT NOT NULL,     -- scrypt: salt$hash
  role TEXT NOT NULL,              -- owner|member
  display_name TEXT, created_at TEXT NOT NULL, last_login_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- '默认密钥' / '服务器hub' 等
  key_hash TEXT UNIQUE NOT NULL, key_hint TEXT,   -- key_hint=明文前6位+'…'，列表展示用
  created_at TEXT NOT NULL, last_used_at TEXT,
  expires_at TEXT, revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,           -- '/web/register?invite=<code>' 用
  tenant_id TEXT NOT NULL, created_by TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_count INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 1,  -- 链接可多人用：max_uses 可调
  revoked_at TEXT
);
-- materials / journals 加列 tenant_id（既有行归 default 租户）
-- 兼容：启动时若设置 MAITIAN_WORKSPACE_KEY，自动建 default 租户 + admin 用户映射（见 §5 兼容）
```

## 3. API 契约

### 3.1 Web 门户（nginx：`/` 与 `/web/*`、`/webapi/*` → maitian-cloud）

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /` | — | **门户单页**：未登录=登录/注册页；已登录=素材台+密钥管理+邀请+成员 |
| `POST /webapi/register` | — | `{username,password,invite_code?}`：invite 空 → 新建 workspace（name=username 的团队）且该用户 role=owner；invite 有 → 加入对应 workspace，role=member。**注册成功即登录**（发 cookie）。同时自动生成该用户**默认 API key**（name='默认密钥'）。限流：同 IP ≤5 次/分；密码 ≥8 位 |
| `POST /webapi/login` | — | `{username,password}` → cookie（HMAC 签名，HttpOnly/SameSite=Lax/7 天）；失败限流同 username+IP 5 次锁 10 分钟 |
| `POST /webapi/logout` | cookie | 内存黑名单 |
| `POST /webapi/password` | cookie | `{old,new}` 改密 |
| `GET /webapi/materials?platform=&q=&limit=&offset=` | cookie | 本租户素材列表（title/type/tags/size/note/sha256/created_at/used_on/claim 状态） |
| `POST /webapi/materials` | cookie | **门户网页上传**（multipart：file + title + platform_tags(JSON 串) + note?/type?——type 缺省按扩展名推断 video|image|text）。与 `/v1` 同规则：sha256 去重、标签白名单校验、入库到本租户 |
| `PATCH /webapi/materials/:id` | cookie | 编辑素材 `{title?/platform_tags?/note?}`（title 非空；tags ⊆ 白名单且 ≥1 个） |
| `DELETE /webapi/materials/:id` | cookie | 删除素材：DB 行 + 磁盘目录（跨租户 404） |
| `POST /webapi/materials/:id/release` | cookie | 释放占用锁（清理卡住的 30 分钟占用） |
| `GET /webapi/materials/:id/file` | cookie | 302 → 复用 `/v1/files` 签名下载 |
| `GET /webapi/me/keys` | cookie | 我的 key 列表（key_hint 明文前 6 位+…；新建时明文仅显示一次） |
| `POST /webapi/me/keys` | cookie | `{name}` → `{api_key(仅此一次)}` |
| `DELETE /webapi/me/keys/:id` | cookie | 吊销自己的某把 key（至少保留 1 把有效） |
| `GET /webapi/me/invite` | cookie（owner/member 均可） | 生成/查看本 workspace 邀请链接（`/web/register?invite=<code>`，max_uses 与有效期可设） |
| `GET /webapi/members` | cookie | 成员列表（owner 可见全部；含各成员 key 数） |
| `DELETE /webapi/members/:userId` | cookie（**仅 owner**） | 移除成员：吊销其全部 key + revoke 用户（owner 不可移除自己） |

### 3.2 CLI 密钥通道（`/v1/*`，设备密钥，不变+兼容）

- 既有 `/v1/*` 端点鉴权改为：查 `api_keys`（有效且未吊销），租户=该 key 的 tenant_id，全部数据操作按租户过滤。角色：key 跟随用户（owner/member 都等价 operator 权限；viewer 后置）。
- `hub join`（hub 侧新命令）：`node src/hub.mjs join` → 提示粘贴自己的 API key（从 Web 密钥页复制）→ 校验 `/v1/whoami` → 写 `<dataDir>/credentials.json`（0600）。凭证解析顺序：credentials.json → 旧 MAITIAN_WORKSPACE_KEY env（兼容）→ doctor 报缺。
- `GET /v1/whoami`：任意有效 key → `{tenant_id, user, key_name}`。
- `POST /v1/admin/*`（ADMIN_KEY 引导）保留：建租户/查状态/应急吊销；日常不用。

### 3.3 网关路由变更（docker/volumes/nginx/nginx.conf）

```
location /            → proxy_pass http://maitian-cloud:8788;   # 门户：注册/登录/素材台/密钥管理
location /webapi/     → proxy_pass http://maitian-cloud:8788;
location /v1/         → proxy_pass http://maitian-cloud:8788;   # CLI 密钥通道（不变）
location /api/        → proxy_pass http://backend:8787;         # hub 大屏 API（管理员/本机用，SERVER_TOKEN 不变）
location /console/    → proxy_pass http://frontend:80/;         # 原 hub 大屏（挪到 /console/）
```

hub 大屏前端静态资源引用为相对路径，挪 `/console/` 需在 frontend nginx 配置 `sub_filter` 或保持 frontend 原样并把大屏链接放门户页顶部——**推荐后者**（改 frontend/Dockerfile 不动，仅门户页加「运营大屏(/console/)」入口，frontend nginx 的 location / 直接服务）。

## 4. 客户端（hub）改动清单

1. `backend/src/config.mjs`：`workspaceKey()` → 先读 `<dataDir>/credentials.json`（0600）再回退 env。
2. `backend/src/hub.mjs`：加 `join` 命令（粘贴 key → whoami 校验 → 写 credentials.json）。
3. `backend/src/planner.mjs doctor`：whoami 自检 + credentials 权限检查 + 无凭证时 actions[] 指引「登录 Web 密钥页复制默认 key，然后 hub join」。
4. `backend/src/static/index.html`：顶部加「素材门户 /」与说明（SERVER_TOKEN 面向管理员）。401 指引文案已修（不再静默空白）。
5. `content-hub/agent-install.md` + `docker/README.md`：入职流程改为「注册 → 密钥页复制默认 key → hub join」。

## 5. 兼容与迁移

- 启动时：自动建 `default` 租户；若 env 有 MAITIAN_WORKSPACE_KEY → 建 admin 用户（username=`legacy-admin`，密码=该 key 值不适用——改为：直接生成一把 api_keys 记录 name='legacy' 归 default 租户，哈希=该 key）。旧 hub/脚本零改动可用。
- 既有 materials/journals 归 default 租户。
- 门户上线后，用户注册新 workspace 为隔离单元；需要接管 default（旧数据）→ 后续人工用 ADMIN_KEY 挂靠，不在本规格自动做。

## 6. 里程碑与验收

| M | 内容 | 验收 |
| --- | --- | --- |
| B1（1.5d） | cloud：五表迁移 + register/login/会话 + materials 只读 + keys CRUD + invite + members + 既有 /v1 端点租户化 + legacy 兼容 | smoke：注册→自动登录→列表可见自己上传素材；双租户互不可见；key 吊销即 401；限流 429；旧 key 兼容；scrypt 校验 |
| B2（1d） | 门户前端单页（登录/注册/素材台/密钥页/邀请/成员）+ nginx 路由切换 + 大屏挪 /console/ + 401 提示页 | 浏览器全流程手测：打开 2680 → 注册 → 看到素材（先手动 curl 传一条）→ 新建 key → 复制 → 邀请链接第二账号注册入同租户 → 两账号素材互通 → owner 移除成员后其 key 全 401 |
| B3（1d） | hub join + credentials + doctor + 文档（agent-install/docker README/用户手册子 issue 更新） | 全流程：注册复制 key → hub join → hub 正常拉素材上传 → 吊销该 key → hub 401 → doctor 提示 |

按 B1→B2→B3；每步验收后进下一步。`node test/smoke.mjs`（基线 114，只增不减）与 `bash test/redline-check.sh` 三关全程保持绿。

## 7. 执行纪律

1. 零第三方依赖；明文 key/密码只在创建与注册响应中出现一次；存储一律哈希；日志脱敏（前 6 位）。
2. `timingSafeEqual` 比较密码/签名；cookie HttpOnly+SameSite=Lax（HTTPS 后加 Secure）；register/login 限流+统一错误防枚举。
3. 密码面=门户素材管理（上传/查看/编辑/删除/释放占用，仅限本租户）+密钥/成员/邀请管理；**设备协同端点（claim/used/knowledge）永远只认密钥**——这是 D5 v4 的安全边界。
4. 越界信号：要做「邮箱/手机验证」「找回密码自助」「Web 端上传/写操作」→ 停，报告，等人类决策。
5. 未实现 ≠ 假装实现；不卡住原则同主规格；交付说明含实测表格与未验证项清单。
