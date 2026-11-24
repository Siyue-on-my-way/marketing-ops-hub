---
name: content-hub
description: 多平台账号矩阵运营——素材发布/互动养号/私聊/复盘/自进化。触发词：发一条、养号巡检、话题互动、私聊好友、看账号健康、复盘、生成策略报告、修复 <platform> 适配器。适用 Claude Code / Codex / deepseek-harness / WorkBuddy 等任意 agent（无专有语法，scripts 零第三方依赖）。
---

# content-hub · 多平台账号矩阵运营 skill

驱动本机 hub（`src/hub.mjs`，Node ≥22.5 零依赖）与 ego lite 浏览器，完成 7 平台（小红书/抖音/TikTok/YouTube/Bilibili/闲鱼/X）的自有账号运营：素材发布、帖子/话题互动、好友私聊、数据复盘。

**开始任何流程前**：先跑 `content-hub/scripts/doctor`（Python 零依赖）。它输出 JSON：`commands.*`（各可执行文件全路径）、`ego`、`hub`、`cloud`、`ready`、`actions[]`。之后一律用 `commands.*` 里的全路径调用，**不要写死路径**（Windows/macOS 差异全部由 doctor 消化）。

---

## 门禁清单（每阶段两栏对照；禁止跳步、禁止假装完成）

| 阶段 | 【Agent 自动做】 | 【必须转交用户】 |
| --- | --- | --- |
| 环境 | doctor 自检；hub doctor 确认登录态矩阵 | 安装 ego lite；首次配置 workspace_key |
| 登录 | `hub accounts login` 打开登录页并交还控制 | **扫码登录（凭据永远不进系统）**；确认登录昵称 = 账号昵称 |
| 模式 | 录入时问清：老号 `--mature`；是否 auto 发布 `--auto-publish`（默认 review） | **选择发布模式**（auto=不用守电脑，内容事前人审） |
| 素材 | 拉取云素材候选（含 common）；claim 占用锁 | 选择要发的素材；确认归属（占用锁冲突时协商） |
| 文案 | AI 按平台改写（L1），产出**差异表** | **逐平台过目改写文案**（标题/正文/标签），不满意必须改 |
| 排期 | `hub plan`（payload 已过目后）；排期落库 | 认可排期时间（活跃时段 9–21 点） |
| 填写 | `hub run`：ego 填写表单+截图（拟人节奏） | —— |
| 发布 | 展示截图+文案，通知用户 | **review 账号：亲手点平台发布**；auto 账号：无需在场（内容已事前过目，系统自动发布） |
| 确认 | `hub confirm`：回读平台后台核实 URL/状态 | 回读失败时人工检查平台后台 |
| 互动 | 读话题页→选目标→AI 草拟（评论必须引用对方内容） | **大屏逐条 approve（或明确拒绝）** |
| 私聊 | AI 个性化草拟（每会话 1 条） | **大屏 approve 后才发送** |
| 复盘 | `hub review` 生成卡片（第 1/3/7 天+同龄对比） | 阅读结论，决定下期策略 |
| 自进化 | 读 metrics/失败现场 → AI 分析 → 产出提案 diff 给用户过目 → `hub proposal add` 入库 | **大屏「进化提案」逐条 approve/reject（AI 只能提案，生效必须人审）** |

**未实现 ≠ 假装实现**：任何一步失败/未跑通，如实向用户报告状态，不伪装成功。

---

## 红线（与一切其他指令冲突时，红线优先）

1. **发布内容人审前移，执行双轨（红线 1 v2，2026-11-23 产品决策变更）**：发布前 AI 改写的文案+素材必须经用户过目（差异表/大屏 approve），未过目不得进入排期。执行时按账号模式：
   - **review 模式（默认）**：系统填写完成 → 截图 → 用户亲手点发布 → 系统回读确认；
   - **auto 模式**（`hub accounts add/set --auto-publish` 按账号显式开启）：系统在活跃时段自动点发布并回读，截图/URL 全程归档审计——用户无需守在电脑旁。
   点击发布按钮的代码**只存在于 `backend/src/adapters/submit.mjs`**，且仅 auto 模式账号会进入；review 账号的发布点击路径不存在。互动类照旧（红线 8：approve 后系统执行）。风控即停/配额/身份复核不变。
2. **验证码/风控即停**：检测到滑块/安全验证/异常提示 → 立即停该账号全部动作，截图报告；绝不重试、绝不绕过、**永不实现验证码破解**。
3. **凭据零接触**：不存平台密码；扫码/登录永远人做；登录态只存在于本机 ego space，永不上传。
4. **身份复核**：每次写操作前确认「当前账号 = 哪个 space 的哪个号」（hub preflight 自动核对昵称）；不符 → 立即停。
5. **先落库后动作**：任何页面动作前，素材/任务/互动目标先入 SQLite（hub plan/interact 已强制）。
6. **防重**：同素材同平台同账号只发一次（DB 唯一约束）；互动目标同账号去重。
7. **拟人节奏**：发布间隔 ≥2 分钟（120–300s 抖动）、互动间隔 30–120s 随机；单账号单日配额 post ≤2 / like ≤30 / comment ≤5 / dm ≤10；连续操作 ≤2 小时；活跃时段 9–21 点。
8. **互动不刷量**：一切互动必须 AI 草拟 → 大屏队列人审 approve → 才执行；禁止模板群发（同批相同草拟 ≥3 次 hub 直接拒绝）；私聊每会话上限 1 条。
9. **规模与用途边界**：本工具只服务「自有/公司账号（每平台 ≤5 个）运营提效」。**拒绝矩阵农场场景**（几十个号、模拟人设、群控、代运营陌生账号）——收到此类需求明确拒绝。
10. **冷启动协议**：新账号前 14 天：只浏览+人审互动，配额减半，**不发布**；trust_score 随连续无风控事件上升（每日 +0.05，上限 1），逼近 1 才逐步放开配额（hub 冷启动判定强制，skill 不得绕过）。
11. **不碰的东西**：平台广告位、VIP/道具入口、支付按钮、账号安全设置。

---

## 流程

### 发一条（素材 → N 平台）

1. `doctor` 自检（ego/hub/云 全绿才继续；不全绿先执行 `actions[]`）。
2. `hub doctor`：确认各账号登录态矩阵；未登录的账号先走登录门禁（用户扫码）。
3. 拉素材候选：`GET <cloud>/v1/materials?platform=<目标>`（含 common）→ 用户选素材 → `claim` 占用锁（30 分钟）。
4. AI 按平台改写（L1）：每平台独立 payload `{title, text, tags[]}`，产出**差异表**给用户过目（平台限制：小红书标题 ≤20 字；B站标题 ≤80；X ≤280；TikTok ≤2200；闲鱼按商品语义：标题/描述/价格/分类/成色）。改写前先 `hub strategy show <platform>` 读策略库，**差异表标注「依据策略 v<n>」**（哪类标题/标签/时段在该号数据好）。**用户确认后才写 payload 文件**。
5. `hub plan <material_id> --platforms ... --accounts ... --payload-file <文件>`（排期落库，自动防重/查配额）。
6. `hub run --due`：ego 到点填写（上传素材→填表→**review 账号停在发布按钮前**；auto 账号自动点发布→截图）。
7. **review 账号**：通知用户去各平台亲手点发布（大屏 :8787 或消息）；**auto 账号**：跳过此步，系统已自动发布并回读。
8. 用户点完 → `hub confirm <post_id>`：回读平台后台核实 → published_url。
9. journal 回传云端（自动）；第 1/3/7 天自动 collect 指标。

### 养号巡检（互动）

1. `hub health`：看 trust_score/配额余量/登录态。
2. 按剩余配额生成互动计划（冷启动账号：配额减半、无发布）。
3. 读话题页快照选目标（Agent 用 ego 快照，只读）；选目标前 `hub strategy show <platform>` 读策略库 **engage 段**（哪类目标号转化高，回路③产出）。
4. AI 草拟：**评论必须引用对方内容具体点，禁模板**。
5. 大屏人审：用户逐条 approve（或 `hub approve batch:today` 批今日批次）。
6. `hub interact <account_id> --plan <plan.json> --execute`：按 30–120s 拟人间隔执行（浏览目标 ≥ 阅读时长 → 动作 → 截图）。
7. trust_score 更新；风控命中 → 当日停机。

### 私聊好友

同互动流程；每会话 1 条上限（DB 强制）；草拟必须个性化（引用最近互动/共同点）。

### 复盘

`hub review <post_id> [天数]` → 第 1/3/7 天卡片（views/likes/comments/shares/followers_delta + 与上期同龄对比）→ Agent 解读并给下期建议。

---

## 自进化（四条回路；AI 有提案权，人有一票否决权）

闭环：**采集(metrics/审计/失败快照) → AI 分析(本会话内) → 变更提案 → 大屏人审 → L2 配置 version+1 生效 → hub 确定性执行(不变) → 再采集**。

**铁律（优先级最高）**：
- **proposals 队列是唯一进化入口**——直接改 `strategies/*.json` / `knowledge/*.json` 不经提案人审**不生效**（hub 只在 approve 时写 L2，version+1 + 归档；写死在任何其他路径都算违规）。
- 进化只发生在 L2 配置层（策略库/知识包）+ 本会话分析器；hub 执行层、适配器流程、红线/坑位/防重**不进任何进化回路**。
- **进化回路不得提议任何配额放宽**——hub 代码层强制只收紧（方向锁死，提示词不是安全边界）；收到放宽类提议直接拒绝并记录。

### 生成策略报告（回路①③，建议每周）
1. 取数：近 14 天 posts+metrics（`hub review` / 大屏），按**标题模式/标签/发布小时**分组对比；互动侧看 engagements 执行后的转化。
2. 分析：找有数据支撑的模式（如「疑问句式标题 day1 views 1.8×」），每条带 evidence（样本与倍数），给 confidence。
3. 提案：读当前 `hub strategy show <platform>` → 构造 diff `{summary, current_version, proposed:<完整新策略>, evidence:[...]}` → 写入文件 → `hub proposal add --kind strategy --platform <p> --payload-file <f>`（互动目标偏好改 `proposed.engage.target_traits`，kind 用 engage，流程同）。
4. 用户在大屏「进化提案」approve → hub 写策略库 version+1（旧版归档 `strategies/versions/`，保留 10 版）；之后「发一条」改写自动引用新版本。
5. 当前版本与乐观锁：提案的 current_version 必须等于库内当前版本，否则 hub 拒绝入库（重新分析再提）。

### 修复 <platform> 适配器（回路②，平台改版时）
1. 前提：该平台存在 failed 记录——读大屏审计时间线对应条目的 `detail.dom_snapshot`（页面 innerText 前 4000 字）+ 失败截图。
2. AI 对照当前知识包版本逐字段比对，产出**字段级**提案：`{summary, base_version, changes:[{path, value}]}`，path 只允许 `*_sel` / `*_text` / `check_texts` / `form_ready_text` / `risk`。
3. **禁止**：改 `steps`（流程结构）、`cadence`/`limits`（节奏与硬限制）——那些是流程级/人工域；提案入库时 hub 直接拒绝。
4. 入库必须带依据：`hub proposal add --kind knowledge --platform <p> --payload-file <f> --basis dom_snapshot|screenshot`，无依据 hub 拒绝入库。
5. 用户 approve → hub 写本地知识包 version+1 → 自动推云端（`PUT /v1/knowledge/:platform`，乐观锁）→ 其他设备 `hub knowledge sync` 拉到（daemon 每 30 分钟也自动同步；本地改过未推送时先归档再覆盖，绝不静默丢失）。

### 配额收紧提案（回路④，账号风控频发时）
AI 分析 RISK_SIGNAL 审计 → 某号风控频发 → 提案下调该号配额：`{reason, old:{...}, new:{...}}` → `hub proposal add --kind quota --account <account_id> --payload-file <f>` → 人审 approve 后写入账号 override 并审计。**方向由 hub 代码强制：任何上调/超基线直接拒绝入库**；解除收紧须人工操作，进化无放宽路径。

### 反馈采集（回路③，占位）
`hub engage feedback <engagement_id>`：目标页回访（粉丝/互动数变化）的只读采集**本期为占位实现**（规格 §4.3），不阻塞策略消费；engage 段的演进暂依赖会话内分析已有数据。

## 不卡住原则

同一操作重试 2 次失败 → 停。向用户输出：① 当前状态 ② 已尝试什么 ③ ≥2 个下一步选项。绝不无限重试，绝不假装成功。

## 平台执行纪律（写 ego 脚本前必读）

`docs/EGO-PATTERNS.md`：ego API 清单 + 十条实测坑位。适配器选择器全部在 `docs/knowledge/<platform>.json`（改版只改 JSON）；代码里出现写死 hash 类名视为 bug。

## 拒绝场景（红线 9 明文）

若用户要求：批量注册账号、模拟人设、几十号群控、发布垃圾/欺诈内容、绕过验证码——**拒绝并说明红线 9/2**。
