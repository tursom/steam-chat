# Steam Chat GHCR 部署

## 部署方式

Docker Compose 直接拉取 GitHub Container Registry（GHCR）镜像，不在部署服务器上构建源码。

默认镜像：

```text
ghcr.io/tursom/steam-chat:latest
```

`.github/workflows/docker-publish.yml` 在 `master` 分支更新、`v*.*.*` 标签和手动触发时构建并发布镜像。PR 只构建，不发布。部署前应确认该工作流已成功发布所选镜像标签。

部署机器只需安装 Docker Engine 和 Docker Compose 插件，并准备 `docker-compose.yaml`、可选的 `.env` 及持久化数据目录；不需要 Node.js、Android SDK、Dockerfile 或完整源码。

仓库中的 Dockerfile 继续供 GitHub Actions 构建镜像使用；默认 Compose 文件不再包含 `build`，不再使用 `docker compose up --build` 部署。

## Compose 配置

```yaml
services:
  steam-chat:
    image: ${STEAM_CHAT_IMAGE:-ghcr.io/tursom/steam-chat:latest}
    container_name: ${STEAM_CHAT_CONTAINER_NAME:-steam-chat}
    restart: unless-stopped
    init: true
    ports:
      - "${STEAM_CHAT_BIND:-0.0.0.0}:${STEAM_CHAT_PORT:-3000}:3000"
    environment:
      NODE_ENV: production
      STEAM_CHAT_DATA_DIR: /app/data
      STEAM_CHAT_HOST: 0.0.0.0
      STEAM_CHAT_PORT: 3000
      STEAM_CHAT_WS_PATH: /ws
      STEAM_CHAT_DEPLOY_WEBHOOK_URL: ${STEAM_CHAT_DEPLOY_WEBHOOK_URL:-}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

保留现有的宿主机目录挂载 `./data:/app/data`。升级时应在原 Compose 目录操作，不要更换挂载位置，也不要直接切换成一个空的命名卷。

入口脚本创建数据目录并调整权限，之后以镜像中的 `node` 用户运行服务。若宿主机文件系统不允许调整所有权，需提前为容器运行用户准备可写的数据目录。

## 环境变量

可复制 `.env.example` 为 `.env`，按部署环境调整：

```dotenv
STEAM_CHAT_IMAGE=ghcr.io/tursom/steam-chat:latest
STEAM_CHAT_CONTAINER_NAME=steam-chat
STEAM_CHAT_BIND=0.0.0.0
STEAM_CHAT_PORT=3000
```

`STEAM_CHAT_IMAGE` 支持已发布的版本标签、`sha-<提交短哈希>` 标签或镜像 digest。生产部署建议固定版本或 digest；`latest` 会随默认分支发布更新。

Compose 读取 `.env` 做变量替换，不会自动把所有变量传入容器。不要在这些文件里保存 Steam 密码、后台密码、Guard code 或 refresh token。

## 首次部署

在存放 Compose 文件的目录执行：

```bash
mkdir -p data
docker compose config --quiet
docker compose pull steam-chat
docker compose up -d --no-build steam-chat
docker compose ps
```

必须先确认 `pull` 成功；出现权限、标签不存在或网络错误时应先处理，不要把旧镜像启动成功误认为已升级。

公开镜像通常无需登录。若 GHCR 包是私有的，先执行：

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

在密码提示中输入有权读取该包、具备 `read:packages` 权限的 GitHub token，不要把 token 写进命令、Compose 或 `.env`。也可将包设置为公开以允许匿名拉取。

打开 `http://服务器地址:3000`，首次初始化管理员，再由管理员在 Web 后台完成 Steam 登录、Guard 验证和用户授权。没有 Steam token 时服务也可以启动。

## 更新部署

先确认新镜像已发布，并完成数据备份。保持原有 `.env` 和 `data/` 挂载：

```bash
docker compose pull steam-chat
docker compose up -d --no-build steam-chat
docker compose ps
```

如果 Compose 文件有更新，再替换配置文件；日常镜像更新不要求在服务器执行 `git pull`。

历史库可能随镜像升级而迁移。例如 Android 增量同步需要 schema 2，旧版本程序不能直接打开升级后的库。部署前应预留索引、WAL 和压缩空间，并阅读 [同步与升级说明](android-durable-sync.md)。不能只切回旧镜像就假定数据库也已回滚。

## 自动更新

`master` 镜像通过测试并发布成功后，Actions 可调用 HTTPS webhook 自动更新。部署使用本次构建的不可变 digest，而不是重新解析 `latest`。PR 和版本标签不会触发生产更新。

GitHub 仓库需要设置两个 Secrets：`DEPLOY_WEBHOOK_URL`（例如 `https://steam.tursom.dev/api/deploy`）和 `DEPLOY_WEBHOOK_SECRET`（至少 32 字符的随机密钥）。首次部署完成后，再将仓库 Actions Variable `DEPLOY_WEBHOOK_ENABLED` 设置为 `true`；其他值会跳过生产更新，可用作暂停开关。

聊天容器仅转发原始签名请求，不保存部署密钥，也不挂载 Docker socket。宿主机独立更新器验签、限制镜像仓库、拒绝过时任务，并执行拉取、停服备份、启动和健康检查。部署密钥不得与后台登录密码共用。

在服务器 `.env` 中启用转发：

```dotenv
STEAM_CHAT_DEPLOY_WEBHOOK_URL=http://host.docker.internal:3001/deploy
```

宿主机更新器应绑定 Docker host-gateway 对应地址，不直接开放公网端口。安装与故障处理参见 [部署更新器](../ops/deploy/README.md)。首次安装需要先部署包含转发入口的新镜像。

自动更新生成 `compose.deploy.yml` 固定镜像 digest。启用后手工操作也要同时加载原 Compose 文件和该覆盖文件，避免意外退回 `latest`。停服后备份完整 `data/`；备份不自动删除。新版本启动失败时不自动切旧镜像，因为数据 schema 可能已迁移。

## 数据与备份

宿主机 `data/` 对应容器 `/app/data`，包含后台用户库、Steam 登录凭据、RocksDB 历史库、JSONL 副本和媒体缓存。整个目录都应作为敏感数据保护。

停止所有写入进程后备份整个目录，不要把运行中直接复制的 RocksDB 当作一致性备份：

```bash
mkdir -p backups
docker compose stop --timeout 60 steam-chat
sudo tar -czf "backups/steam-chat-data-$(date +%Y%m%d-%H%M%S).tgz" data
docker compose start steam-chat
```

备份失败时应先排查，确认备份可恢复后再升级。恢复时先停服务，保留当前目录，验证备份并恢复完整数据目录，使用与数据库 schema 兼容的镜像。详细操作见 [历史存储维护说明](history-storage-operations.md)。

`docker compose down` 会删除容器，但不会删除这个 bind mount 的宿主机 `data/`。不要删除或清空 `data/`，否则会丢失账户、token、聊天记录和缓存。

## 健康检查与日志

```bash
docker compose logs -f steam-chat
curl -fsS http://127.0.0.1:3000/healthz
```

修改了外部端口时，健康检查命令也要使用对应端口。`/healthz` 返回 `{"ok":true}` 仅表示 HTTP 服务可用，不代表 Steam 已登录或所有存储写入正常；Steam 状态和存储状态应在登录后查看。

## 公网访问

公网部署应配置 HTTPS 反向代理。Android App 只接受有效 HTTPS 地址。反代需要支持 `/ws` 的 WebSocket Upgrade，正确转发协议及必要的客户端信息。

若只有本机反代需要访问服务端口，可在 `.env` 设置：

```dotenv
STEAM_CHAT_BIND=127.0.0.1
```

本 Compose 不包含反向代理、TLS 证书或外部数据库。
