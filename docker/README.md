# marketing-ops-hub · 部署与运维

## 首次部署

```bash
cd docker
cp env.example .env
vi .env                 # 必改：SERVER_TOKEN、MAITIAN_WORKSPACE_KEY（两个长随机串）；按需改 GATEWAY_PORT
docker compose up -d --build
docker compose ps       # 等 backend / maitian-cloud / frontend 均 healthy
```

入口：
- **用户门户** `http://<host>:<GATEWAY_PORT>/`（注册/登录 → 素材台 + 密钥管理 + 邀请成员）
- 运营大屏 `http://<host>:<GATEWAY_PORT>/console/?token=<SERVER_TOKEN>`（hub 待审队列，管理员用；token 会被浏览器记住）。
API 健康检查（免鉴权）：`curl http://<host>:<GATEWAY_PORT>/api/health` → `{"ok":true,"version":"0.1.0",...}`。

CLI 接口发现（任意有效 API 密钥，查询全部开放端点）：

```bash
curl -H "Authorization: Bearer <api_key>" http://<host>:<GATEWAY_PORT>/v1/endpoints
```

注册用户自带默认密钥（注册成功页仅显示一次；之后可在门户「密钥管理」页新建）。

## 运维速查

```bash
cd docker
docker compose ps                    # 状态
docker compose logs -f backend       # 运行时日志（hub）
docker compose logs -f maitian-cloud # 云素材库日志
docker compose restart backend       # 改 volumes/marketing-ops-hub/config.json / .env 后生效
docker compose down                  # 停止（数据保留在 volumes/）
docker compose up -d --build         # 改代码后重建
```

## 云素材库拆分部署（生产推荐）

单机演示时 maitian-cloud 并在本栈内部（`MAITIAN_CLOUD_URL=http://maitian-cloud:8788`）。
生产建议单独一台服务器：`MAITIAN_WORKSPACE_KEY='...' docker compose -f docker-compose.cloud.yaml up -d --build`，
然后主栈 `.env` 里 `MAITIAN_CLOUD_URL=https://<云服务器>:8788` 并 `docker compose restart backend`。
公网暴露建议 HTTPS + IP 白名单（key=全部权限，规格 §4.1 安全边界）。

## 关键配置说明

| 变量 | 用途 |
| --- | --- |
| `SERVER_TOKEN` | 大屏/API 网关访问令牌（`X-Server-Token` 头或 `?token=`），重启不变 |
| `MAITIAN_WORKSPACE_KEY` | legacy 引导 key（兼容旧设备；新用户走门户注册→密钥管理→`hub join`） |
| `GATEWAY_PORT` | 唯一对外端口（默认 2380） |
| `MAITIAN_CLOUD_URL` | hub 访问云素材库的地址 |

数据落盘位置（`docker compose down` 后保留）：`docker/volumes/marketing-ops-hub/{data,hub.db|workspace|cloud-data}`。

## 本机模式（重要边界）

hub 的浏览器执行依赖**本机 ego lite**（GUI 浏览器，无法容器化）。容器里的 backend 能完整运行排期/审核队列/大屏/审计/复盘，但执行 ego 动作时会如实报 `EGO_NOT_CONFIGURED`（不假装可用）。日常运营在**装有 ego 的用户电脑**上以本机模式运行：

```bash
cd backend
cp config/config.example.json config.json   # 配 cloud.base_url 指向云素材库
export MAITIAN_WORKSPACE_KEY=...
node src/hub.mjs serve                       # 本机大屏 :8787 + daemon
```

安装与账号录入见 `content-hub/agent-install.md`。
