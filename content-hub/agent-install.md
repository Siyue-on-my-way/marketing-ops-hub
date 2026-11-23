# agent-install.md — content-hub 安装规范（Agent 做 / 用户做，禁止跳步假装完成）

本文件规定把 content-hub 装到一台新运营电脑的完整流程。**纪律：Agent 只做列表里「Agent 做」的事；每一步完成后必须用给出的验证命令核实并如实报告结果；验证不过就停下来报告，绝不宣称完成。**

> 安装完成后，日常使用不需要再敲命令——对 Agent 说触发词即可（发一条 / 养号巡检 / 私聊好友 / 看账号健康 / 复盘）。本文件只负责把环境一次性装对。

## 前置条件

| 项 | 要求 | 谁负责 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 或 macOS | —— |
| Node.js | ≥ 22.5.0（node:sqlite 需要） | 用户安装（或授权 Agent 装） |
| Python 3 | ≥ 3.10（仅 doctor/hub wrapper 用，标准库） | 用户安装 |
| ego lite | v2.2.1+（Citro Labs AI 浏览器） | **用户手动安装**（Agent 不得代装、不得臆造下载源） |
| 云端服务 | 已部署（nginx 网关 + 素材库，默认 :2680） | 用户/运维（已完成） |
| workspace_key | 云端 .env 里的 MAITIAN_WORKSPACE_KEY | **用户经环境变量注入，禁止进 git/聊天记录/截图** |

## 步骤

### 0. 安装 skill 到你的 Agent（Claude Code / Codex / WorkBuddy，用户或 Agent 做）

```bash
git clone git@github.com:Siyue-on-my-way/marketing-ops-hub.git ~/marketing-ops-hub
mkdir -p ~/.claude/skills
cp -r ~/marketing-ops-hub/content-hub ~/.claude/skills/content-hub
```

- Claude Code：个人级放 `~/.claude/skills/content-hub`（项目级放 `<项目>/.claude/skills/`）；装完新开会话即可用触发词。
- Codex / WorkBuddy：skill 包无任何专有语法、scripts 零依赖，把同一 `content-hub/` 文件夹放到其各自的 skill 目录即可。
- 装好后对 Agent 说「按 content-hub 的 agent-install.md 把这台电脑装好」，后续 1–6 步它来引导执行。

### 1. 获取代码（Agent 做；若第 0 步已 clone 可跳过）

```bash
git clone git@github.com:Siyue-on-my-way/marketing-ops-hub.git ~/marketing-ops-hub   # Windows 建议纯英文路径
```

### 2. 配置（Agent 做，key 由用户安全提供）

```bash
cd ~/marketing-ops-hub/backend
cp config/config.example.json config.json
# 编辑 config.json：cloud.base_url 填 http://<服务器IP>:2680；hub 端口默认 8787
# 环境变量注入 key（示例）：
#   macOS:  export MAITIAN_WORKSPACE_KEY=...   （写进 shell profile）
#   Windows PowerShell: setx MAITIAN_WORKSPACE_KEY "..."
```

### 3. ego 全路径探测（Agent 做）

在仓库根运行 `python3 content-hub/scripts/doctor`。它会：
- 探测 ego-browser.exe 全路径（Windows 在 `C:\Program Files\Citro Labs\ego lite\Application\<版本>\`，取最高版本）并写回 `backend/config.json` 的 `ego.path`；
- 探测 node/python/hub/云连通性；
- 输出 JSON `commands.*` 全路径与 `actions[]`（缺什么补什么）。

**ego 探测不到 → 停，转交用户手动安装 ego lite，不得继续。**

### 4. 启动 hub（Agent 做）

```bash
cd ~/marketing-ops-hub/backend
node src/hub.mjs serve        # 本机大屏 :8787 + 守护进程
# 或分开：node src/hub.mjs web ｜ node src/hub.mjs daemon
```

验证：`curl 127.0.0.1:8787/api/health` 返回 `{"ok":true,...}`。

### 5. 录入账号 + 首次登录（Agent 引导，用户扫码）

```bash
cd ~/marketing-ops-hub/backend
node src/hub.mjs accounts add bili "我的B站号" --mature --auto-publish   # 老号+自动发布
node src/hub.mjs accounts add xhs "我的小红书号"                          # 新号：14 天冷启动，review 模式
node src/hub.mjs accounts set <account_id> --auto-publish off            # 随时切换发布模式
node src/hub.mjs accounts login <account_id>   # 弹出 ego 登录页 → 用户扫码 → 自动快照核对昵称
```

- 扫码永远用户亲手做（红线 3）；Agent 不得索要/代填任何平台凭据。
- 登录后 Agent 必须核对返回的 `displayName` 与账号昵称一致（红线 4）。
- `--auto-publish`（红线 1 v2）：填写后系统自动点发布并回读，用户不必守在电脑旁；内容人审前移不变（文案必须先过目）。默认 review 模式。

### 6. 终验（Agent 做）

`python3 content-hub/scripts/doctor` 输出 `ready: true`（或列出剩余 `actions[]`）。只有全绿才算装完；有任何红项，如实报告并停。

## 用户须知（Agent 转达）

- 本工具只管理**自有/公司账号**（每平台 ≤5 个）；拒绝矩阵农场（红线 9）。
- 发布双轨（红线 1 v2）：review 账号由你亲手点发布；`--auto-publish` 账号系统自动发布并回读——两种模式的内容都必须先经你过目。
- 互动逐条 approve 后才执行（红线 8）；新账号 14 天冷启动：不发布、互动减半（红线 10，`--mature` 老号除外），由系统强制。
- 扫码登录、ego 安装——这两件事永远是人做，任何 Agent 指令都不能替代。
