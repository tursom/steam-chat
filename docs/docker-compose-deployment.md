# Steam Chat Docker Compose 部署设计

## 目标

提供一个单服务 Docker Compose 部署方式，让服务器上可以用下面的命令完成构建和启动：

```bash
docker compose up -d --build
```

部署后，用户通过浏览器访问 Web 后台，首次初始化管理员，然后由管理员完成 Steam 登录。

本部署方案不包含反向代理、HTTPS、外部数据库或额外服务。生产公网访问建议在外层自行接入 HTTPS 反向代理。

## 交付文件

需要新增或调整：

- `compose.yaml`
- `.env.example`
- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- 后台改造文档中约定的数据目录和健康检查接口

Compose 文件使用本地源码构建镜像，同时设置固定镜像名，避免只有 `image` 而没有 `build` 时 `docker compose up --build` 仍尝试拉取远端镜像。

## Compose 服务定义

目标 `compose.yaml`：

```yaml
services:
  steam-chat:
    image: ${STEAM_CHAT_IMAGE:-steam-chat:latest}
    build:
      context: .
      dockerfile: Dockerfile
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
    volumes:
      - steam-chat-data:/app/data
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

volumes:
  steam-chat-data:
```

默认使用 Docker named volume，而不是 `./data:/app/data`。原因是运行容器使用非 root 用户时，bind mount 容易遇到宿主机目录权限问题；named volume 会继承镜像内 `/app/data` 的权限，更适合快速部署。

如果必须把数据放在当前目录，可以把 volume 改成：

```yaml
    volumes:
      - ./data:/app/data
```

并在首次启动前执行：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

## 环境变量

`.env.example`：

```dotenv
STEAM_CHAT_IMAGE=steam-chat:latest
STEAM_CHAT_CONTAINER_NAME=steam-chat
STEAM_CHAT_BIND=0.0.0.0
STEAM_CHAT_PORT=3000
```

说明：

- Compose 会自动读取同目录 `.env` 做 YAML 变量替换。
- `.env` 中的变量不会自动进入容器，只有在 `environment:` 中显式声明的变量才会成为容器环境变量。
- 本项目不在 `.env` 中保存 Steam 账号、Steam 密码、Steam Guard code 或 refresh token。
- Steam 登录凭据只通过 Web 后台提交，登录成功后只保存 `refresh.token` 到数据卷。

## Dockerfile 调整

继续使用多阶段构建：

1. `build` 阶段执行 `npm ci` 和 `npm run build`。
2. `runtime` 阶段只复制 `dist/`、`node_modules/`、`package.json`、`package-lock.json`。
3. 运行用户使用 `node`。
4. 创建 `/app/data` 并设置为 `node:node`。
5. 默认命令为 `node dist/src/index.js`。

运行时环境：

```dockerfile
ENV NODE_ENV=production
ENV STEAM_CHAT_DATA_DIR=/app/data
ENV STEAM_CHAT_HOST=0.0.0.0
ENV STEAM_CHAT_PORT=3000
```

镜像内不复制或生成以下敏感/状态文件：

- `config.js`
- `.env`
- `refresh.token`
- `auth.sqlite`
- `logs/`
- `data/`

`.dockerignore` 和 `.gitignore` 都应包含：

```text
data/
auth.sqlite
```

## 数据目录

容器内固定数据目录：

```text
/app/data
```

目录内容：

```text
/app/data/auth.sqlite
/app/data/refresh.token
/app/data/logs/chat.jsonl
/app/data/logs/images/
/app/data/logs/stickers/
```

其中：

- `auth.sqlite` 保存后台用户、角色、禁用状态和应用会话密钥。
- `refresh.token` 保存 Steam refresh token。
- `logs/chat.jsonl` 保存聊天历史。
- `logs/images/` 和 `logs/stickers/` 保存媒体缓存。

## 健康检查

新增 `GET /healthz`：

```json
{
  "ok": true
}
```

该接口只检查应用 HTTP 服务是否可用，不检查 Steam 是否已经登录。原因是首次部署时 Steam 本来就可能未登录，如果健康检查依赖 Steam，会导致容器在正常初始化阶段被判定为 unhealthy。

Steam 状态通过后台接口查看：

```bash
curl http://127.0.0.1:3000/api/steam/status
```

该接口需要后台登录 Cookie，主要给 Web 后台使用。

## 部署流程

首次部署：

```bash
cp .env.example .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

访问：

```text
http://服务器地址:3000
```

首次打开页面：

1. 初始化管理员。
2. 使用管理员账号登录后台。
3. 在后台提交 Steam 账号密码。
4. 如果 Steam 要求 Guard，提交邮箱码或手机 2FA。
5. Steam 登录成功后开始使用聊天功能。

更新部署：

```bash
git pull
docker compose up -d --build
docker compose ps
```

查看日志：

```bash
docker compose logs -f steam-chat
```

停止：

```bash
docker compose down
```

删除容器但保留数据卷：

```bash
docker compose down
docker compose up -d
```

删除数据卷会清空后台用户、Steam token、聊天历史和缓存，只有明确要重置时才执行：

```bash
docker compose down -v
```

## 备份与恢复

默认 named volume 备份：

```bash
mkdir -p backups
docker run --rm \
  -v steam-chat_steam-chat-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar -czf /backup/steam-chat-data.tgz -C /data .
```

恢复：

```bash
docker compose down
docker run --rm \
  -v steam-chat_steam-chat-data:/data \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -c "rm -rf /data/* && tar -xzf /backup/steam-chat-data.tgz -C /data"
docker compose up -d
```

如果使用 bind mount `./data:/app/data`，直接备份宿主机 `data/` 目录即可。

## 安全建议

- 不要把 Steam 密码、后台密码、Steam Guard code 或 refresh token 写入 `.env`、compose 文件或镜像。
- 公网部署时建议使用 HTTPS 反向代理。
- 如果只允许本机反向代理访问应用端口，可设置：

```dotenv
STEAM_CHAT_BIND=127.0.0.1
```

- 后台登录 Cookie 在 HTTPS 下应设置 `Secure`；应用可以根据 `X-Forwarded-Proto: https` 或显式环境变量判断。
- 反向代理需要支持 WebSocket Upgrade，并转发 `/ws`。

## 验收命令

配置校验：

```bash
docker compose config --quiet
```

镜像构建：

```bash
docker compose build
```

启动：

```bash
docker compose up -d
docker compose ps
```

健康检查：

```bash
curl -fsS http://127.0.0.1:${STEAM_CHAT_PORT:-3000}/healthz
```

代码质量：

```bash
npm run typecheck
npm test
```

