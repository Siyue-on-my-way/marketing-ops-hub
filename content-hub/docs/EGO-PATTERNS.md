# EGO-PATTERNS.md — ego lite 执行层纪律（写 ego 脚本/适配器前必读）

执行层唯一指定：ego lite（Citro Labs AI 专用浏览器，v2.2.1 实测基线）。CDP 直连普通 Chrome 已被实测证伪（BOSS 直聘秒杀标签页），**禁止复活该路线**；自研 Chrome 扩展路线已冻结。本文是适配器与 round 脚本的全部前提假设。

## 调用方式（不在 PATH，一律全路径；doctor 输出 `commands.ego`）

```
Windows PowerShell:  & $EGO nodejs -e "await import('file:///D:/<脚本绝对路径，正斜杠>.mjs')"
macOS/Linux zsh/bash: "$EGO" nodejs -e "await import('file:///Users/<...>/round-01.mjs')"
```

hub 统一封装在 `src/ego.mjs`：每轮生成一个 round 脚本（`runs/<ts>-<action>.mjs`，幂等、可追溯），spawn ego 执行，从 stdout 解析协议：

```
@@RESULT@@{"ok":true,"data":{...},"shot":"/abs/shots/x.png"}
@@RESULT@@{"ok":false,"error":"RISK_SIGNAL","data":{"risk":["验证码"]},"shot":"..."}
```

**Windows 坑位 10**：PowerShell 5.1 会把 stderr 报成 NativeCommandError，不代表失败——判定一律以 stdout 的 `@@RESULT@@` JSON + 退出码为准（`src/ego.mjs` 已实现）。

## 核心 API（round 脚本内可用）

| API | 说明 |
| --- | --- |
| `await taskSpace("name")` | 新建/复用命名任务空间（登录态持久在 space） |
| `await takeOverTaskSpace(id)` | 接管既有 space（账号→space 绑定优先走这个） |
| `await task.handOff()` | 控制权交还用户（扫码登录/权限弹窗必用） |
| `task.userPage()` | 用户正在操作的页面 |
| `task.pages()` / `task.tabs()` / `task.adopt(page)` | 页面管理 |
| `page.goto(url,{timeout})` / `page.waitForLoadState()` / `page.url()` / `page.title()` | 导航 |
| `snapshot` | 语义化快照：带 ref 的结构化 DOM 摘要，文本定位首选 |
| `screenshot` / `mouse.move/click(x,y)` / `keyboard.insertText(text)` | 视觉模式 |
| `page.waitForFileChooser({timeout})` → `chooser.setFiles(绝对路径)` | 文件上传首选（原生选择器） |
| `page.setInputFiles(sel, paths)` | 隐藏 `input[type=file]` 备选 |

### 实现层假设登记（字段名如与实际版本不符，只改 `src/ego/round-runtime.mjs` / `src/adapters/runtime.mjs`）

- `page.evaluate(expr, ...args)`：表达式为字符串形态的 JS 函数。坑位 3/6 的 TreeWalker 与 native setter 都依赖它。若实际 API 名不同（如 `page.js`），在 runtime.mjs 一处改。
- `page.screenshot({path})`：直接落盘；若实现返回 base64，round-runtime 会自动补写盘。
- 快照 ref 与文本定位并存：适配器优先文本 TreeWalker（稳定），ref 用于 snapshot 流程。
- **iframe（坑位 4）**：目标可能在 iframe 内。v1 策略：快照找不到元素先查 frame；若平台目标确认在 frame 内，把知识包 `pages.*.url` 直接指向 frame 所在入口页并在 RECIPES 记录。适配器不自动穿 frame（避免盲操作）。

## 十条实测坑位（每条都是血泪，适配器代码已按它们实现）

1. **hover 才出现的按钮**：板块标题/列表条目的「添加/编辑/删除」按钮默认不渲染。先 `mouse.move()` 到目标上约 1 秒再取 ref/坐标点击。→ `clickText(..., {hoverMs:1000})`
2. **滚动后坐标失效（最大坑）**：页面滚动后旧坐标点击无效——必须 `scrollIntoView({block:"center"})` 后**重新取坐标**再点。这是纪律不是建议。→ `clickText/clickSelector` 内部强制「滚动→重取→再点」，适配器不得绕过。
3. **文本定位用 TreeWalker**（按 textContent 遍历匹配），不要用裸 querySelector 猜 hash 类名。→ `dom.mjs JS_FIND_BY_TEXT`；知识包之外写死 hash 类名视为 bug。
4. **iframe 陷阱**：目标可能在 iframe 内，快照找不到元素先查 frame（见上）。
5. **页面被上一轮点击「吃掉」**：弹层关闭后 DOM 已变，每轮动作前重新快照/重新定位。适配器每步都重新 `findByText`，不缓存元素坐标。
6. **React 受控输入**：`keyboard.insertText` 无效时用 native setter + `dispatchEvent(new Event('input',{bubbles:true}))`。→ `typeInto()`：先 `setValueNative`（知识包 selector），失败回退「点击聚焦 + insertText」。
7. **选择器字段（城市/职位/分类等）**：点击弹面板后必须**在面板内**搜索/逐级点选；自定义值搜「暂无匹配…点击确定直接添加」。→ 各适配器 fill 的面板流程。
8. **日期选择器三层结构**（年/月/日面板逐级）。v1 发布流不涉及；互动/上架需要时按逐级点选实现。
9. **保存后逐字段验收**：textarea 在视口外时值可能整批丢失——保存/提交前必须快照核对每个字段（尤其「业绩」类长文本）。→ hub confirm 的 verify + 用户人审双保险；后续版本可在 fill 尾部加逐字段回读断言。
10. **每轮一个新 round 脚本文件**（幂等、可追溯）；Windows 中文路径可用但必须正斜杠（`pathToFileURL` 已处理）；PowerShell 5.1 stderr 假报错以 stdout/退出码为准。

## 风控检测协议（红线 2）

每个动作前 `detectRisk(page, knowledge)`：知识包 `risk` 数组（纯文本 / `re:` 正则 / `sel:` 选择器）对页面 innerText/DOM 匹配；命中 → 截图 → audit_log → 该账号**当日停机**（hub `paused:<id>:<date>`）。适配器与 skill 文档不得提供任何绕过/重试路径；**永不实现验证码破解**。

## 账号→space 约定（§4.5）

- 每账号一个长期 task space：`accounts.ego_space_id = mt-<platform>-<account_id>`；
- round 脚本内先 `takeOverTaskSpace(space_id)`，不存在再 `taskSpace("acct-<id>")` 创建并 `handOff` 扫码；
- 未登录 10 分钟未完成 → 该账号本轮任务 `skipped(no_login)`（D1），绝不代填凭据；
- 已知风险（规格 §8）：space 长期隔离稳定性 M1 首验；若 48h 内丢登录态，备选=一账号一 ego profile 目录进程级隔离（字段语义可换，API 不变）。
