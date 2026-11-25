# Maitian-Hub 使用手册（新用户指南）

> 版本 v1.0 · 2026-11-25。面向**使用者**（不是开发者）。读完即可独立使用系统全部能力。
> 开发者文档见 `README.md`、`docker/README.md`、`content-hub/agent-install.md`。

## 这套系统能为你做什么

Maitian-Hub 帮你统一运营**你自己的**多平台账号（小红书 / 抖音 / TikTok / YouTube / Bilibili / 闲鱼 / X，每平台最多 5 个）：

- 一条素材，AI 改写成各平台文案并**自动填写发布表单**；
- 按拟人节奏做**互动养号**（点赞/评论/话题），给好友发**个性化私聊**；
- 发布后**自动收数据**，第 1/3/7 天出复盘卡片。

你只做三件事：**审内容、扫码、（review 模式下）点发布**——其余全部由系统完成。

## 零、开始前，向管理员确认

- 门户地址：`http://<服务器地址>:2680/`（开放注册）
- 你的电脑：Windows 10/11 或 macOS（下文命令以 macOS/Linux bash 为例，Windows 在 PowerShell 中执行，`python3` 换成 `python`）

## 一、注册与首次配置（每台电脑一次，约 30 分钟）

### 1. 注册门户账号

浏览器打开门户 → 「注册」：输入**邮箱或手机号** + 密码（≥8 位，输两遍确认）→ 登录进入**素材库**。

- 直接注册：自动创建你自己的 workspace，你是**拥有者**。
- 拿到同事的邀请链接再注册：自动**加入对方的 workspace**（成为成员，共享素材库）。

### 2. 安装基础软件

| 软件 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.5（`node -v` 验证） | https://nodejs.org 装 LTS 版 |
| Python 3 | ≥ 3.10（`python3 --version`） | 仅自检脚本用，标准库即可 |
| ego lite | v2.2.1+（Citro Labs 官网安装包） | **必须你亲手装**——它是替你操作平台页面的 AI 浏览器，任何助手不得代装 |

### 3. 拉代码并安装助手技能

```bash
git clone git@github.com:Siyue-on-my-way/marketing-ops-hub.git ~/marketing-ops-hub   # 没配 SSH key 就用 https://github.com/Siyue-on-my-way/marketing-ops-hub.git；Windows 建议纯英文路径
mkdir -p ~/.claude/skills
cp -r ~/marketing-ops-hub/content-hub ~/.claude/skills/content-hub
```

装好后**新开一个 Claude Code 会话**，之后日常全部用对话完成，不再敲命令。（用 Codex / WorkBuddy 也行：把同一个 `content-hub/` 文件夹放进它的 skill 目录。）

### 4. 配置

```bash
cd ~/marketing-ops-hub/backend
cp config/config.example.json config.json
# 编辑 config.json：把 cloud.base_url 改为 http://<服务器地址>:2680
```

### 5. 云入职（把你的密钥交给本机 hub）

门户登录后打开顶部「**密钥管理**」页 → 复制你的**默认密钥**（随时可回来点「复制」取回），然后：

```bash
node src/hub.mjs join <粘贴默认密钥>
```

看到 `"ok": true` 和你的租户名即成功。密钥已写入本机凭证文件（`backend/data/credentials.json`，仅本机可读），之后不再需要。

- **想给另一台电脑用**：在门户「密钥管理」再新建一把密钥（例如命名"笔记本"），在那台电脑上重复本章即可。
- 默认密钥**不可吊销**（账号始终保留）；新建的密钥可随时吊销。怀疑泄露就新建一把换用、吊销旧的。

### 6. 启动中控

```bash
cd ~/marketing-ops-hub/backend
node src/hub.mjs serve
```

这个终端**保持运行**——它就是你的驾驶舱（本机大屏 + 自动排期守护）。关机重开后，重新跑这一条即可，账号登录态不会丢。

### 7. 自检

新开一个终端，在仓库根执行：

```bash
python3 content-hub/scripts/doctor
```

目标：`"ready": true`，且 `cloud.whoami` 显示你的租户。哪项缺就按 `actions[]` 的提示补；装不齐就把整段 JSON 发给管理员。

## 二、录入账号并登录（每账号一次，10 分钟）

```bash
cd ~/marketing-ops-hub/backend
node src/hub.mjs accounts add bili "你的B站昵称" --mature   # 老号加 --mature（立即能发）；新号去掉（14 天冷启动）
node src/hub.mjs accounts login <account_id>                # 弹出浏览器 → 你手机扫码 → 自动核对昵称
node src/hub.mjs accounts list                              # 验收：login.ok = true
```

平台代号：`xhs` 小红书 · `douyin` 抖音 · `tiktok` TikTok · `yt` YouTube · `bili` B站 · `x` X · `xianyu` 闲鱼。

- **扫码永远你亲手做**，系统不碰任何平台密码；登录态只存在你这台电脑的 ego space 里。
- 身份不符（快照昵称 ≠ 录入昵称）系统会立即停下，此时核对录入名是否写错。
- **发布模式二选一**（内容都必须先经你过目，区别只在最后一下谁来点）：
  - **review（默认）**：系统填好表单停住，你亲手点「发布」；
  - **auto**：录入时加 `--auto-publish`，或随时 `node src/hub.mjs accounts set <id> --auto-publish on`（关掉用 `off`）——系统自动点发布并回读，你不必守在电脑旁。
- 一个账号只在一台电脑上使用。换电脑 = 新电脑上重新录入 + 扫码，旧电脑不再操作该账号。

## 三、日常使用：对助手说话（Claude Code 里直接说触发词）

### 1）「发一条」——把素材发到多平台

- **你说**：发一条（可指定素材/平台/账号/时间，例如「发一条，这个视频投小红书和B站，用我的老号」）
- **系统做**：拉素材候选 → 按平台改写文案出**差异表** → 排期 → 到点自动上传素材、填标题/正文/标签 → 截图
- **你做**：
  1. 过目差异表并确认（内容人审，不能跳过）；
  2. **review 账号**：打开平台页面亲手点「发布」，然后在本机大屏点「已发布，回读确认」；**auto 账号**：什么都不用做。
- **结果**：发布 URL 回读归档；第 1/3/7 天自动收数据。

素材从哪来：素材库是**云端共享**的（同一 workspace 的同事都看得到）。生产好的视频/图/文交给助手说「**上传到素材库**」即可（或自行调 API，见第五章）。

### 2）「养号巡检」——维持账号活跃度

按当日剩余配额生成互动计划（也可指定「话题互动」）→ AI 草拟评论（**引用对方内容，禁模板**）→ 你在大屏逐条 **approve** → 30–120 秒拟人间隔自动执行。连续无风控天数越多，trust_score 越高，配额越松。

### 3）「私聊好友」

同巡检流程；每会话上限 1 条，个性化草拟，你 approve 后才发送。

### 4）「看账号健康」

trust_score、今日配额用量、登录态、风控事件一屏看完。配额语义：

- 上限（trust=1 时）：发 ≤2 / 赞 ≤30 / 评 ≤5 / 私信 ≤10，每天；
- 实际余量 = 上限 × trust_score（新号冷启动再减半且不能发；风控命中当日的号清零）；
- 活跃时段 9–21 点，发布间隔 ≥2 分钟随机——到点自动执行，不用盯。

### 5）「复盘」

第 1/3/7 天自动采集。说「**复盘 <post_id>**」：各平台数据 + 与你**自己上期同龄帖**（发布后同一天）的对比。

### 进阶

- 「**生成策略报告**」「**修复 <平台> 适配器**」：助手分析数据/失效页面，产出**进化提案**；你在大屏「进化提案」逐条 approve 后才生效（AI 只能提案，人有一票否决）。

## 四、三个网页入口

| 入口 | 看什么 |
| --- | --- |
| 门户 `http://<服务器地址>:2680/` | 注册/登录；**素材库**（本 workspace 全部素材、使用记录、下载）；**密钥管理**（复制默认密钥/新建/吊销）；**邀请**（生成链接拉同事入 workspace）；**成员**（拥有者可移除成员） |
| 本机大屏 `http://127.0.0.1:8787`（随 `hub serve`） | **日常主战场**：待审队列（发布待审 + 互动 approve/reject）、进化提案、排期日历、账号健康、审计时间线 |
| 运营大屏 `http://<服务器地址>:2680/console/?token=<SERVER_TOKEN>` | 管理员视角（SERVER_TOKEN 向管理员要） |

### 素材怎么进库

门户素材库只做**查看/下载**，上传走 API（或直接让助手上传）。手动上传示例：

```bash
curl -X POST http://<服务器地址>:2680/v1/materials \
  -H "Authorization: Bearer <你的密钥>" \
  -F file=@video.mp4 \
  -F 'meta={"title":"双十一开箱","type":"video","platform_tags":["common"]}'
```

- `type` ∈ `video|image|text`；`platform_tags` ⊆ `common,xhs,douyin,tiktok,yt,bili,x,xianyu`（`common` = 全平台可发）；
- 相同文件自动去重（sha256）；「发一条」时同素材同账号同平台只发一次。

## 五、纪律（系统强制，不是建议）

- 发布内容**永远先经你过目**（差异表/大屏）；互动 approve 后才执行。
- **新号 14 天冷启动**：不发布、互动减半；trust_score 连续无风控每天 +0.05，满 0.8 且满 14 天自动转正（老号录入用 `--mature` 跳过）。
- 验证码/风控提示 → 该账号**当日自动停机**并截图报告，绝不绕过；风控 3 次进 `banned_watch`，需人工处理。
- 只管**自有/公司账号**（每平台 ≤5 个）；批量注册、模拟人设、群控类需求会被拒绝。

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| doctor 某项红 | 按 `actions[]` 提示补；不行把整段 JSON 发管理员 |
| `skipped(no_login)` | 登录态失效：重新 `node src/hub.mjs accounts login <id>` 扫码 |
| `skipped(quota)` | 当日配额用完，明天再试或换号 |
| 风控停机 | 看大屏审计里的截图，次日自动恢复；连续 3 次进 `banned_watch` 需人工 |
| `duplicate` | 同素材同账号同平台防重命中，换素材 |
| 回读未通过 | 平台审核中，稍后在大屏再点一次「已发布，回读确认」 |
| 云 401 | 凭证被吊销或过期：门户「密钥管理」拿新 key，重新 `hub join` |
| 大屏打开是空的/要 token | 本机大屏随 `hub serve` 启动；带 SERVER_TOKEN 的入口是运营大屏（管理员用） |

## 七、路线提示

- 遇到未支持的场景 → 到父 issue（AI+自动化+营销）提需求；
- 疑似 bug → 反馈时附上 `python3 content-hub/scripts/doctor` 的 JSON 输出。
