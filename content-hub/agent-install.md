# agent-install.md — content-hub 安装规范（Agent 做 / 用户做，禁止跳步假装完成）

本文件规定把 content-hub 装到一台新电脑的完整流程。**纪律：Agent 只做列表里「Agent 做」的事；每一步完成后必须用给出的验证命令核实并如实报告结果；验证不过就停下来报告，绝不宣称完成。**

## 前置条件

| 项 | 要求 | 谁负责 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 或 macOS | —— |
| Node.js | ≥ 22.5.0（node:sqlite 需要） | 用户安装（或授权 Agent 装） |
| Python 3 | ≥ 3.10（仅 doctor/hub wrapper 用，标准库） | 用户安装 |
| ego lite | v2.2.1+（Citro Labs AI 浏览器） | **用户手动安装**（Agent 不得代装、不得臆造下载源） |
| 云端 maitian-cloud | 已部署（见 cloud/ 目录 compose） | 用户/运维 |
| workspace_key | 云端部署时生成的 key | **用户经环境变量注入，禁止进 git/聊天记录/截图** |

## 步骤

### 1. 获取代码（Agent 做）

```bash
git clone <本仓库> ~/maitian-hub    # Windows 建议放在纯英文路径
```

### 2. 配置（Agent 做，key 由用户安全提供）

```bash
cd ~/maitian-hub
cp config.example.json config.json
# 编辑 config.json：cloud.base_url 填云端地址；hub 端口默认 8787
# 环境变量注入 key（示例）：
#   macOS:  export MAITIAN_WORKSPACE_KEY=...   （写进 shell profile）
#   Windows PowerShell: setx MAITIAN_WORKSPACE_KEY "..."
```

### 3. ego 全路径探测（Agent 做）

运行 `python3 content-hub/scripts/doctor`。它会：
- 探测 ego-browser.exe 全路径（Windows 在 `C:\Program Files\Citro Labs\ego lite\Application\<版本>\`，取最高版本）并写回 `config.json` 的 `ego.path`；
- 探测 node/python/hub/云连通性；
- 输出 JSON `commands.*` 全路径与 `actions[]`（缺什么补什么）。

**ego 探测不到 → 停，转交用户手动安装 ego lite，不得继续。**

### 4. 启动 hub（Agent 做）

```bash
node src/hub.mjs serve        # 大屏 :8787 + 守护进程
# 或分开：node src/hub.mjs web ｜ node src/hub.mjs daemon
```

验证：`curl 127.0.0.1:8787/api/health` 返回 `{"ok":true,...}`。

### 5. 录入账号 + 首次登录（Agent 引导，用户扫码）

```bash
node src/hub.mjs accounts add bili "我的B站号"
node src/hub.mjs accounts login <account_id>   # 弹出 ego 登录页 → 用户扫码 → 自动快照核对昵称
```

- 扫码永远用户亲手做（红线 3）；Agent 不得索要/代填任何平台凭据。
- 登录后 Agent 必须核对返回的 `displayName` 与账号昵称一致（红线 4）。

### 6. 终验（Agent 做）

`python3 content-hub/scripts/doctor` 输出 `ready: true`（或列出剩余 `actions[]`）。只有全绿才算装完；有任何红项，如实报告并停。

## 用户须知（Agent 转达）

- 本工具只管理**自有/公司账号**（每平台 ≤5 个）；拒绝矩阵农场（红线 9）。
- 每次发布由你亲手点平台发布按钮（红线 1）；互动逐条 approve 后才执行（红线 8）。
- 新账号 14 天冷启动：不发布、互动减半（红线 10），由系统强制。
