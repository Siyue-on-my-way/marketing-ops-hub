# Maitian-Hub 分工执行手册（Codex × 你）

> 版本 v1.0 · 2026-11-27。配套《USER-GUIDE.md》（业务目标 → 步骤 → 完成标志）使用：本手册把每个目标的步骤按「**谁能做**」拆开——能自动化的写成**给 Codex 的提示词**（整段复制即用），必须人做的写成**你的操作清单**。
> 术语：【Codex】= 你电脑上的 Codex 终端智能体；【你】= 人工；【系统】= hub 自动。凡涉及扫码、内容确认、点发布、大屏 approve 的，都是人的活——这是系统的红线，不是分工偏好。

## 使用方法（3 句话）

1. 新开一个 Codex 会话，先把下面「开场白」整段粘贴给它（一次即可）。
2. 按目标顺序推进；每个目标把「Codex 提示词」复制给它，出现 ⏸ 时按「你的操作清单」动手。
3. 每步用「完成标志」核对，Codex 说完成但标志不满足 = 没完成，让它如实重报。

> 更省事的路线：`content-hub/` 技能包本身跨 agent（无 Claude 专有语法）。如果你的 Codex 支持自定义技能目录，把 `~/marketing-ops-hub/content-hub` 放进去，日常直接对它说触发词（发一条 / 养号巡检 / 私聊好友 / 看账号健康 / 复盘）即可——本手册的提示词是**不装技能也能干**的等价兜底。

---

## 开场白（每个 Codex 会话粘贴一次）

```text
你在帮我操作 Maitian-Hub——一套多平台账号矩阵运营系统（本地中控 hub + 云端素材库 + ego 浏览器）。
代码在 ~/marketing-ops-hub（若不存在先告诉我，不要自作主张换路径）。所有 hub 命令在
~/marketing-ops-hub/backend 下执行：node src/hub.mjs <子命令>。命令输出都是 JSON，逐字段核实后再汇报。

纪律（违反任何一条即任务失败）：
1. 未实现 ≠ 假装实现：每一步用给出的验证命令核实并如实报告结果；验证不过就停下报告，绝不宣称完成。
2. 同一操作重试 2 次失败 → 停，报告：①当前状态 ②已试过什么 ③≥2 个下一步建议，等我决策。
3. 永远不碰平台账号密码/验证码；不代我安装 ego lite；不把我给你的 API 密钥写进任何文件、提交、日志或截图（join 命令产生的 backend/data/credentials.json 除外）。
4. 不执行 git push，不删数据，不修改 content-hub/ 下的红线文档；装软件先征得我同意。
5. 涉及"发布/发送/互动执行"的动作只按流程推进到该停的地方就停——系统会自动拦，你也不要绕。

确认理解后回复"就绪"，然后等我发具体任务。
```

---

## 目标 1：装机（每台电脑一次）

### 你做（3 件 Codex 替代不了的事）

| # | 操作 | 说明 |
| --- | --- | --- |
| 1 | 浏览器打开 `http://8.148.26.166:2680/` → 注册（邮箱或手机号 + 密码 ≥8 两次）→ 登录 | 注册即创建你的 workspace；顶部「密钥管理」页**复制默认密钥**，暂存到安全的地方 |
| 2 | 到 Citro Labs 官网下载并安装 **ego lite** | 必须亲手装（系统红线：任何 LLM 不得代装）。装完记住：Windows 一般在 `C:\Program Files\Citro Labs\ego lite\` 下 |
| 3 | 决定是否让 Codex 代装 Node/Python | 同意就在提示词 A 的开头加一句"已授权你安装 Node.js ≥22.5 与 Python 3" |

### Codex 提示词 A（代码与环境）

```text
任务：把 Maitian-Hub 装到这台电脑。
1. 检查 node -v（需 ≥22.5）与 python3 --version；不满足且我已授权安装，就用本机包管理器装（macOS 用 brew，Windows 用 winget），装完复验。
2. 克隆代码：git clone git@github.com:Siyue-on-my-way/marketing-ops-hub.git ~/marketing-ops-hub（失败改用 https://github.com/Siyue-on-my-way/marketing-ops-hub.git）。
3. 安装技能：mkdir -p ~/.claude/skills && cp -r ~/marketing-ops-hub/content-hub ~/.claude/skills/content-hub。
4. 写配置：复制 ~/marketing-ops-hub/backend/config/config.example.json 为同目录 config.json，把 cloud.base_url 改为 http://8.148.26.166:2680，其余不动。
验证：node -v、python3 --version、ls ~/marketing-ops-hub/backend/src/hub.mjs、cat config.json 里的 base_url。
汇报：逐项列 结果/缺失项。缺什么就停在那一步说明，不要跳步。
```

### ⏸ 你 → Codex 交接：把门户复制的默认密钥粘贴给它，并发提示词 B

### Codex 提示词 B（云入职 + 启动 + 自检）

```text
任务：云入职并启动中控（继续上个任务，代码在 ~/marketing-ops-hub/backend）。
1. 云入职：node src/hub.mjs join <我粘贴的密钥>。验证输出 ok:true 且 tenant_name 是我的租户名；密钥只能进 backend/data/credentials.json，不得出现在你输出的任何其他地方。
2. 启动中控（长驻进程，用后台方式）：先 curl -s http://127.0.0.1:8787/api/health，若未运行则 nohup node src/hub.mjs serve > ~/maitian-hub.log 2>&1 & ，10 秒后复验 /api/health 返回 ok:true。
3. 自检：cd ~/marketing-ops-hub && python3 content-hub/scripts/doctor，输出完整 JSON。
汇报：doctor 的 ready 值 + cloud.whoami 租户名 + actions[] 里剩余的缺项。ready:false 时逐条解释缺什么、哪些需要我做。
```

### 完成标志

doctor `"ready": true` 且 `cloud.whoami` 显示你的租户。唯一的常见红项是 ego 未装——回到你的操作清单第 2 条。

---

## 目标 2：接入一个平台账号（每账号 10 分钟）

### 你做

1. 告诉 Codex：平台、账号昵称、**是老号还是新号**、发布模式（review=它填好你点发布；auto=系统自动发布。内容都要先经你过目）。
2. ⏸ Codex 弹出浏览器后：**手机打开对应平台 App 扫码**（永远你亲手扫，系统不碰密码）。

### Codex 提示词（以 B 站老号 + review 为例，按实际替换）

```text
任务：接入我的平台账号。参数：平台 bili，昵称 "XXX"，老号（--mature），发布模式 review（不开 --auto-publish）。
1. 录入：cd ~/marketing-ops-hub/backend && node src/hub.mjs accounts add bili "XXX" --mature，记下返回的 account id。
2. 登录：node src/hub.mjs accounts login <account_id>。它会弹出 ego 浏览器窗口——这时停下来告诉我"请扫码"，命令会等最多 10 分钟。
3. 命令返回后核实：快照 displayName 与录入昵称一致、login.ok=true；再跑 node src/hub.mjs accounts list 给我看该账号的 id/platform/status/login 状态。
异常处理：超时未扫码/昵称不符 → 如实报告并停，不要重试登录超过 1 次。
```

### 完成标志

`accounts list` 里该账号 `login.ok = true`，昵称与你手机上看到的一致。

---

## 目标 3：素材入库（发帖前置）

### 你做（最省事的一条路）

门户 `http://8.148.26.166:2680/` →「素材库」→ 上传面板**点选/拖入文件**（可多选，单个 ≤500MB）→ 勾平台标签（common=全平台）→「开始上传」。传完可直接在页面上编辑标题/标签/备注、下载、删除、释放占用。到这就不用 Codex 了。

### Codex 提示词（批量/命令行场景才需要）

```text
任务：把素材上传到云端素材库。文件：<逐个列绝对路径>；平台标签：common（或指定 xhs/douyin/tiktok/yt/bili/x/xianyu 组合）；备注：<可选>。
用门户密钥走 API（密钥在 backend/data/credentials.json，读出来用，但不要打印）：
curl -s -X POST http://8.148.26.166:2680/v1/materials -H "Authorization: Bearer <key>" -F file=@<路径> -F 'meta={"title":"<标题>","type":"<video|image|text>","platform_tags":["common"]}'
验证每个文件返回 id+status:ready；返回 dedup:true 说明与库内重复（sha256 相同），如实报告。
最后跑 GET /v1/materials?limit=10 列出最新素材清单给我核对。
```

### 完成标志

门户「素材库」能看到这些素材，可查看/下载。

---

## 目标 4：发一条（核心业务）

### 你做（两处，不能省）

1. ⏸ **过目差异表并确认**——Codex 会把各平台改写文案列给你，你看完说"确认"才继续；不满意让它改。
2. ⏸ review 模式账号：填完后**你打开平台页面亲手点「发布」**，再开本机大屏 `http://127.0.0.1:8787` →「待审队列」点「**已发布，回读确认**」。（auto 账号无需此步）

### Codex 提示词

```text
任务：按 content-hub 的「发一条」流程把一条素材发到多平台。
素材：<标题或 id>；平台与账号：<如 xhs+账号a、bili+账号b>；时间：<如 今晚 20:00，留空=最近的活跃时段>。
1. cd ~/marketing-ops-hub && python3 content-hub/scripts/doctor —— ready 不为 true 先停下报告。
2. node src/hub.mjs accounts list —— 核对目标账号 login.ok=true 且不在冷启动（cold 不能发）。
3. 从云端拉素材候选（GET /v1/materials?platform=<平台>，key 在 backend/data/credentials.json），确定用哪条后 claim 占用锁。
4. 按平台改写文案（标题/正文/标签逐平台适配：小红书标题≤20字、X≤280字符、TikTok≤2200……），生成差异表。
5. ⏸ 把差异表完整贴给我，等我回复"确认"。未确认前不得排期。
6. 我确认后：写 payload 文件 → node src/hub.mjs plan <material_id> --platforms <...> --accounts <...> [--at "<时间>"] --payload-file <文件>。
7. node src/hub.mjs run --due 触发执行（或说明守护进程会到点自动执行）。
8. review 账号：执行完提醒我"去平台点发布，然后在大屏点已发布回读确认"；auto 账号：说明系统会自动发布回读，把 post_id 给我。
9. 验证：大屏 /api/state 里该帖状态（filled→confirmed）与发布 URL。
任何一步失败：报告 ①状态②已试③下一步建议，不重试超过 2 次。
```

### 完成标志

大屏该帖 `confirmed` + 发布 URL；平台后台可见内容。

---

## 目标 5：养号互动 / 目标 6：私聊好友

### 你做

⏸ 本机大屏 `http://127.0.0.1:8787` →「待审队列」→「互动待审」：逐条看 AI 草拟的评论/私聊，点 **approve** 或 **reject**（都看过也可"批准今日全部"）。执行、间隔、截图都是系统的活。

### Codex 提示词（互动；私聊把首行换成"私聊好友"并说明对象意图）

```text
任务：按 content-hub 的「养号巡检」流程给账号 <account_id> 做今日互动。
1. node src/hub.mjs health —— 确认该号登录正常、互动配额有余量（余量=上限×trust_score，冷启动减半）。
2. 采集目标：按我给的话题/列表页（<链接>）取快照选目标，遵守同账号同目标去重。
3. 逐条草拟：评论必须引用对方内容、个性化，禁止模板（同批相同草拟 hub 会直接拒绝）；点赞只对已浏览内容。
4. 把草拟清单汇总贴给我，提醒我去大屏 approve；approve 后 hub 会按 30–120 秒拟人间隔自动执行，你不用代执行。
5. 验证：node src/hub.mjs health 里配额用量上升；异常（skipped(risk) 等）如实报告。
```

### 完成标志

大屏「审计时间线」出现 executed 记录；健康页配额用量上涨。

---

## 目标 7：健康检查 / 目标 8：复盘（全自动，放心整个交给 Codex）

### Codex 提示词（健康）

```text
任务：跑 node src/hub.mjs health，用中文表格汇总：每个账号的 登录态/trust_score/今日各配额上限与已用/风控事件。最后给结论：今天哪些号能发、哪些只能互动、哪些停机（及原因）。
```

### Codex 提示词（复盘）

```text
任务：跑 node src/hub.mjs review <post_id> [天数，默认7]，用中文解读复盘卡片：各天数据、与自己上期同龄帖的差值意味着什么、下期选题/文案的 2-3 条具体建议。post_id 我不知道就先从大屏 /api/state 或审计里查。
```

### 完成标志

拿到结论/卡片；数字与平台后台一致（抽查 1 个即可）。

---

## 目标 9：和同事共用团队空间

### 你做

1. 门户顶部「**邀请**」页 → 生成链接 → 发给同事。
2. 同事打开链接注册（自动加入你的 workspace，自带一把自己的密钥）。

### 交给同事

把本手册发给同事：其电脑按**目标 1**（开场白 + 提示词 A/B，用它自己的默认密钥 join）和**目标 2**接入**不与你重叠**的账号。账号不重叠是多人协作的唯一冲突规则。

### 完成标志

门户「成员」页看到同事；素材库互相可见。

---

## 附：任务分界速查

| 步骤 | Codex | 你 |
| --- | --- | --- |
| 装 Node/Python、克隆、配置、join、serve、doctor | ✅ 提示词 A/B | 授权装软件；提供密钥 |
| 装 ego lite | ❌ 红线禁代装 | ✅ 官网亲手装 |
| 平台扫码登录 | ❌ 永远人工 | ✅ 手机扫码 |
| 门户注册/取密钥/邀请/素材网页上传 | ❌ 网页人工 | ✅ 浏览器操作 |
| 素材 API 批量上传、拉候选、改写文案、排期、填表、健康、复盘 | ✅ | 过目结果 |
| 差异表确认、互动 approve、review 模式点发布、大屏回读确认 | ❌ 内容人审红线 | ✅ 亲手 |
| 风控/验证码处理 | ❌ 系统自动停机，任何一方不得绕过 | ✅ 看报告做决策 |
