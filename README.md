# marketing-ops-hub · 多平台账号矩阵运营系统

服务自媒体运营者对**自有账号**（每平台 ≤5 个）的统一管理：素材发布（小红书/抖音/TikTok/YouTube/Bilibili/闲鱼/X）、帖子互动、话题互动、好友私聊、数据复盘。执行层 = ego lite（用户本机 AI 浏览器）；**人审最后一下**：系统只填写，发布按钮永远由用户亲手点（红线 1，11 条红线全文见 `content-hub/SKILL.md`）。**拒绝矩阵农场场景**。

## 目录结构

```
marketing-ops-hub/
├── backend/                      # 后端运行时代码（Node ≥22.5，零第三方依赖）
│   ├── src/                      # hub 本地中控：CLI/排期/审核/配额/审计/大屏API/适配器/ego执行桥
│   ├── cloud/                    # maitian-cloud 云素材库 API（同镜像双用途，compose 以 command 区分）
│   ├── config/                   # 默认配置样例（config.example.json）
│   ├── package.json
│   ├── Dockerfile                # node:22-alpine；HEALTHCHECK 探 /api/health
│   └── .dockerignore
├── frontend/                     # 大屏（零依赖单页）
│   ├── src/                      # （页面单一来源在 backend/src/static/index.html，构建期共享）
│   ├── package.json
│   ├── nginx-frontend.conf       # SPA 回退
│   ├── Dockerfile                # 多阶段：node:22-alpine → nginx:alpine
│   └── .dockerignore
├── content-hub/                  # skill 包（各用户本机 agent 载体：SKILL.md/doctor/知识包/策略库/坑位文档）
├── test/                         # 冒烟测试（mock 级，不需真机）+ 红线自检
├── .gitignore
└── docker/
    ├── docker-compose.yaml       # nginx 网关 / frontend / backend(hub) / maitian-cloud（内部）
    ├── docker-compose.cloud.yaml # 云素材库独立部署（生产推荐）
    ├── env.example               # 环境变量样例（入库；.env 不入库）
    ├── README.md                 # 部署与运维说明
    └── volumes/
        ├── nginx/nginx.conf      # 网关路由（:ro）
        └── marketing-ops-hub/
            ├── config.json       # hub 运行时配置（挂 :ro，改后 restart backend 生效）
            ├── data/             # hub SQLite（:rw，持久化）
            ├── workspace/        # round 脚本/截图/素材缓存（:rw）
            └── cloud-data/       # 云素材库文件与元数据（:rw）
```

## 请求链路（架构铁律）

```
客户端 → nginx:{GATEWAY_PORT:-2380} ─┬─ /            → frontend（大屏静态 + SPA 回退）
                                     ├─ /api/*       → backend:8787（hub；SERVER_TOKEN 鉴权）
                                     └─ /ws          → 无 WebSocket，已按模板说明删除
服务间不直连；maitian-cloud 为主栈内部服务（无对外端口），生产拆分用 docker-compose.cloud.yaml。
```

知识包单一来源 `content-hub/docs/knowledge/`，经 compose `additional_contexts` 共享进镜像（防两份漂移）；大屏页面单一来源 `backend/src/static/index.html`，同理共享给 frontend 构建。

## 快速开始

见 `docker/README.md`（首部 5 行部署 + 运维速查 + 云拆分 + 本机模式边界）。

## 开发与测试

```bash
node test/smoke.mjs        # 114 项 mock 级冒烟（不需要真机 ego/平台；含自进化四回路）
bash test/redline-check.sh # 红线自检：适配器代码「点击发布/提交」零命中；无写死 hash 类名
```

## 自进化（docs/EVOLUTION-SPEC-v1.md）

闭环：采集(metrics/审计/失败快照) → AI 分析(harness 会话内) → 变更提案 → 大屏人审 → L2 配置 version+1 生效 → hub 确定性执行(不变)。**proposals 队列是唯一进化入口**：直接改 L2 配置（`content-hub/docs/strategies/*.json` 策略库、`content-hub/docs/knowledge/*.json` 知识包）不经提案人审不生效。四条回路：

| 回路 | 内容 | 触发词 / 命令 |
| --- | --- | --- |
| ① 文案策略 | `strategies/<platform>.json` 版本化 + 周分析提案 | 「生成策略报告」→ `hub proposal add --kind strategy` → 大屏 approve |
| ② 知识包自愈 | 失败现场 dom_snapshot → AI 字段级选择器提案 → 云端热更 | 「修复 <platform> 适配器」→ `hub proposal add --kind knowledge --basis ...` |
| ③ 互动目标 | 策略库 engage 段（反馈采集本期占位） | `hub engage feedback <id>`（占位） |
| ④ 配额收紧 | `quota_override` 只收紧，clamp 在 hub 代码强制 | 风控频发时 `hub proposal add --kind quota`（上调直接拒绝） |

相关命令：`hub strategy show|history`、`hub proposal add|list|approve|reject`、`hub knowledge sync|push|status`。云端热更端点：`GET/PUT /v1/knowledge`（乐观锁，冲突 409）。

## 已知边界（如实标注）

- ego 浏览器执行无法容器化（GUI + 本机登录态）：容器 backend 的排期/审核/大屏全功能可用，ego 动作如实报未配置；日常运营走本机模式。
- 7 平台知识包选择器为 v1 初始版，待真机实测回填（`content-hub/docs/RECIPES-bili.md` 有首验清单）。
- 后端基线 Node 22（规格表写 Node 20）：零依赖 SQLite（node:sqlite）需 ≥22.5，为保持零依赖升级基线。
- 自进化：策略库云端分发为 v1 规划（当前 git/本机分发，规格允许多机后升云端）；知识包云端热更已可用（`hub knowledge sync`）；容器模式下知识包/策略目录随镜像，approve 写入在容器层（重建镜像前需先同步归档）——日常运营本机模式不受影响。
