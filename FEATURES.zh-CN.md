# Steam Chat 功能说明

最后更新：2026-06-23

本文档基于当前仓库实现整理，目标是说明 `steam-chat` 已具备的功能边界、主要数据流、前后端能力和运行限制。接口的字段级示例仍以 [API.md](./API.md) 为准；本文侧重完整功能总览。

## 1. 项目定位

`steam-chat` 是一个基于 Steam 账号的实时聊天服务。它在后端维护 Steam 登录、Web Session、聊天日志和 HTTP/WebSocket 服务，并提供一个内置的中文 Web UI，用于收发 Steam 好友消息、图片、表情和贴纸。

核心能力：

- 通过 Steam Chat 接收好友消息，并实时推送给浏览器客户端。
- 通过 HTTP API 或 WebSocket API 发送文本消息和图片。
- 将聊天记录写入本地 JSONL 文件，并基于本地日志查询历史和最近会话。
- 代理并缓存远程图片、Steam 表情图片和 Steam 贴纸图片。
- 提供响应式 Web UI，支持桌面端和移动端聊天操作。

## 2. 功能总览

| 功能域 | 已实现能力 | 主要文件 |
|--------|------------|----------|
| Steam 账号连接 | 凭据登录、refresh token 登录、自动保存 refresh token、断线重试、Web Session 刷新 | `client.js`, `steam-lifecycle.js` |
| 聊天服务 | HTTP Server、WebSocket Server、静态资源服务、可选 Basic Auth | `chat.js` |
| 文本消息 | 发送好友消息、接收好友消息、接收自己消息回显、短期去重 | `chat.js`, `logger.js` |
| 图片消息 | Base64 图片发送、远程 URL 图片发送、发送队列、发送回执、图片回显去重 | `chat.js`, `public/app/composer.js` |
| 富内容 | Steam 表情、Steam 贴纸、BBCode 图片、HTML 图片、OpenGraph 卡片、普通链接 | `chat.js`, `public/app/rich-content.js`, `public/app/message-bubble.js` |
| 历史与会话 | 本地 JSONL 日志、历史查询、最近会话摘要、预览文本生成 | `chat.js`, `logger.js` |
| 好友与群组 | Steam 好友列表、群组列表、在线状态、游戏状态展示 | `chat.js`, `public/app/sidebar.js` |
| Web UI | 会话侧栏、消息列表、发送区、附件菜单、表情/贴纸选择器、图片预览、通知、移动端侧栏 | `public/index.html`, `public/app.js`, `public/app/` |
| 图片代理缓存 | 远程图片代理、贴纸代理、内容类型推断、并发请求合并、磁盘缓存 | `chat.js`, `public/app/managed-images.js` |
| 配置与测试 | `config.chat` 配置、禁用自动启动环境变量、Node 内置测试 | `config.example.js`, `package.json`, `test/` |

## 3. 后端服务功能

### 3.1 服务启动与模块关系

- `client.js` 创建 `SteamUser`、`SteamCommunity` 和 Winston logger。
- `client.js` 调用 `createSteamLifecycle()`，启动 Steam 登录生命周期，并导出 `steamLoginPromise` 与 `steamWebLoginPromise`。
- `logger.js` 监听 Steam 消息事件，将好友消息和自己消息回显写入 `logs/chat.jsonl`。
- `logger.js` 在 `config.chat` 启用时加载 `chat.js`，启动聊天 HTTP/WebSocket 服务。
- `chat.js` 在没有设置 `STEAM_CHAT_DISABLE_AUTOSTART=1` 时会自动创建默认聊天服务并启动。
- 测试环境通过 `STEAM_CHAT_DISABLE_AUTOSTART=1` 禁用自动启动，改为直接构造可注入依赖的 `createChatService()`。

### 3.2 HTTP 服务

后端使用 Node.js 原生 `http` 创建服务，默认监听 `0.0.0.0:3000`。主要能力：

- 服务内置前端静态资源，`GET /` 返回 `public/index.html`。
- 支持 `/style.css`、`/app.js` 和模块化 CSS/JS 静态资源。
- 所有 JSON 响应统一设置 `Content-Type: application/json; charset=utf-8`。
- 请求体最大限制为 10 MB，超过会返回 `Request body too large`。
- 非 POST 的未知路径返回 `404` JSON 错误。

### 3.3 WebSocket 服务

后端使用 `ws` 建立 WebSocket Server，默认路径为 `/ws`。主要能力：

- 连接成功后主动发送 `ready` 事件，携带当前 `wsPath`。
- 单服务实例最多允许 100 个 WebSocket 连接，超过后关闭连接并返回 `1013 Too many connections`。
- 每个客户端请求可携带 `requestId`，服务端响应会原样带回。
- 支持非法 JSON 检测，解析失败时返回 `type: "error"`。
- 未支持的 WebSocket 类型返回错误消息。
- 收到 Steam 新消息时向所有已连接 WebSocket 客户端广播。

### 3.4 HTTP Basic Auth

聊天服务支持可选 HTTP Basic Auth：

- 只有 `chat.auth.username` 和 `chat.auth.password` 同时配置时才启用。
- 局域网和回环地址请求默认不要求认证。
- 非局域网请求需要认证，认证失败返回 `401` 和 `WWW-Authenticate`。
- 设置 `chat.auth.trustProxy: true` 后，会优先解析 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`。
- WebSocket 握手也走同一套认证判断。
- 凭据比较使用 SHA-256 后的 timing-safe 比较，避免直接字符串比较。

## 4. API 与实时通信功能

### 4.1 HTTP API

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| `GET` | `/` | 内置 Web UI | 返回 `public/index.html` |
| `GET` | `/api/config` | 前端配置 | 当前返回 `{ "wsPath": "..." }` |
| `GET` | `/api/emoticons` | 表情和贴纸库存 | 需要 Steam 登录和 Web Session |
| `GET` | `/api/friends` | 好友列表 | 返回好友 SteamID、昵称、头像、在线状态、游戏名 |
| `GET` | `/api/groups` | 群组列表 | 返回群组 SteamID/Clan ID 和名称 |
| `GET` | `/history?id=&limit=` | 本地历史记录 | `id` 可选，`limit` 默认 100，最大 500 |
| `GET` | `/conversations?limit=` | 最近会话摘要 | `limit` 是生成摘要时读取的历史条数 |
| `GET` | `/proxy/sticker/:type` | 贴纸图片代理 | 下载 Steam 贴纸并缓存到本地 |
| `GET` | `/proxy/image?url=` | 远程图片代理 | 下载远程图片并缓存到本地 |
| `POST` | `/message` | 发送文本消息 | 请求体 `{ "id": "...", "msg": "..." }` |
| `POST` | `/` | 发送文本消息别名 | 与 `/message` 相同 |
| `POST` | `/image` | 发送图片 | 支持 `img` Base64 或 `url` |
| `POST` | `/img` | 发送图片别名 | 与 `/image` 相同 |

### 4.2 WebSocket 请求类型

| 请求 `type` | 兼容别名 | 功能 | 成功响应 |
|-------------|----------|------|----------|
| `send_message` | `msg` | 发送文本消息 | `message_sent` |
| `send_image` | `img` | 发送图片 | `image_sent` |
| `get_history` | `history` | 获取本地历史记录 | `history` |
| `get_conversations` | `conversations` | 获取最近会话摘要 | `conversations` |
| `get_emoticons` | `emoticons` | 获取 Steam 表情和贴纸库存 | `emoticons` |
| `get_friends` | `friends` | 获取 Steam 好友列表 | `friends` |
| `get_groups` | `groups` | 获取 Steam 群组列表 | `groups` |
| `ping` | 无 | 心跳检测 | `pong` |

### 4.3 服务端主动推送事件

| 推送 `type` | 触发条件 | 数据 |
|-------------|----------|------|
| `ready` | WebSocket 连接建立 | `{ wsPath }` |
| `message` | 收到 Steam 好友消息，或服务端成功发送文本消息后广播 | `HistoryItem` 格式的文本消息 |
| `image` | 服务端成功发送图片后广播给其他客户端 | `HistoryItem` 格式的图片消息 |
| `error` | 请求失败或非法 JSON | 错误消息，可能包含 `requestId` |

### 4.4 数据结构

历史消息项统一规范化为：

- `type`: `message` 或 `image`。
- `date`: 本地格式化时间，通常是 `yyyy-mm-dd HH:MM:ss.l`。
- `echo`: 是否为自己发送。
- `id`: 会话对象 SteamID64。
- `name`: 发送方昵称。收到好友消息时为好友昵称，自己发出的消息为当前 Steam 账号昵称。
- `message`: 文本消息内容，图片记录通常为空字符串。
- `imageUrl`: 图片 URL，没有则为 `null`。
- `ordinal`: Steam 消息序号，图片记录通常为 `null`。
- `sentAt`: 某些图片记录会带 ISO 时间戳。

会话摘要项包含：

- `id`: 会话 SteamID64。
- `name`: 会话名称，优先使用非自己消息的发送方昵称，缺失时尝试查询 Steam 用户信息。
- `updatedAt`: 最近消息时间。
- `preview`: 最近消息摘要，可为普通文本、`[图片]`、`[贴纸] xxx`、`[表情] xxx` 或 OpenGraph 标题。
- `lastType`: 最近消息类型。
- `lastEcho`: 最近消息是否为自己发送。
- `messageCount`: 当前读取日志窗口内该会话消息数。

## 5. Steam 生命周期与账号能力

### 5.1 登录模式

Steam 生命周期优先读取 `refresh.token`：

- 如果 `refresh.token` 存在且非空，使用 refresh token 登录。
- 如果 refresh token 不存在或不可读，使用 `config.accountName` 和 `config.password` 登录。
- 登录参数同时带上 `config.logonID` 和 `config.steamID`。
- SteamUser 启用 `renewRefreshTokens`，收到新 refresh token 时写回 `refresh.token`。

### 5.2 自动重连

`steam-lifecycle.js` 区分可恢复错误和不可恢复错误：

- 可恢复错误包括网络中断、Steam 服务不可用、超时、部分 socket/TLS 错误等。
- 不可恢复错误包括密码错误、Steam Guard/两步验证问题、账号禁用、登录节流、需要验证码等。
- 可恢复错误会安排重试，初始延迟 5 秒，指数退避，最大 5 分钟。
- 如果已经安排重试，不会重复安排多个重试定时器。
- `loggedOn` 会清理待重试定时器并重置退避。

### 5.3 Web Session

- 登录成功后调用 `steamUser.webLogOn()` 获取 Web Session。
- 收到 `webSession` 后将 cookies 注入 `SteamCommunity`。
- 如果配置了 `identitySecret`，会启动 confirmation checker，间隔 10 秒。
- 图片发送和表情/贴纸库存读取依赖 Web Session 就绪。
- 文本或图片发送遇到疑似 Session 过期时，会触发一次 `webLogOn()` 并等待新的 `webSession` 后重试。

### 5.4 用户信息缓存

`client.js` 提供 `getUserInfo()`：

- 支持传入字符串 SteamID64 或 SteamID 对象。
- 首次查询通过 `steamUser.getPersonas()` 拉取资料。
- 查询结果缓存在进程内 `users` 对象中。
- 查询失败时返回 `{ player_name: "Unknown" }`。

## 6. 消息、媒体与富内容能力

### 6.1 文本消息

- 后端通过 `steamUser.chat.sendFriendMessage()` 发送好友文本消息。
- 发送成功后写入本地日志，并广播给 WebSocket 客户端。
- 收到 Steam `friendMessage` 时广播为 `type: "message"`。
- 收到 Steam `friendMessageEcho` 时按短期 key 去重，避免同一条自己发送的消息重复出现。
- 文本发送遇到临时网络错误时会先重试一次。
- 文本发送遇到疑似 Web Session 过期时会刷新 Session 后重试。

### 6.2 图片发送

后端支持两种图片输入：

- `img`: Base64 字符串，允许纯 Base64 或 Data URL。
- `url`: 远程图片 URL，服务端先下载为 Buffer 再上传给 Steam。

发送流程：

- 发送前等待 Steam 登录和 Web Session。
- 使用 `steamCommunity.sendImageToUser()` 上传图片。
- 发送成功后记录 `type: "image"` 日志。
- WebSocket 发送图片时，发送者收到 `image_sent` 回执，其他客户端收到 `image` 广播。
- 图片发送遇到临时网络错误会先重试一次。
- 图片发送遇到疑似 Session 过期会刷新 Web Session 后重试。
- 服务会记住最近发送的图片 URL，抑制 Steam 随后以文本 URL 或 BBCode 形式回显出的重复图片消息。

### 6.3 表情与贴纸

- 后端通过 Steam `ClientGetEmoticonList` 获取当前账号的表情和贴纸库存。
- 表情项包含 `name`、`count`、`use_count`、`time_last_used`、`appid`。
- 贴纸项包含 `name`、`count`、`use_count`、`time_last_used`、`appid`。
- 前端将表情渲染为 `:name:`，发送时仍作为普通文本消息发送。
- 前端发送贴纸时实际发送 Steam 贴纸 BBCode：`[sticker type="..." limit="0"][/sticker]`。
- 后端和前端都能识别贴纸 BBCode，并在消息气泡和会话预览中渲染为贴纸。

### 6.4 富内容解析

文本消息渲染支持：

- Steam 表情：`:name:`、`[emoticon name="name"][/emoticon]`、`[emoticon]name[/emoticon]`。
- 图片：`[img]url[/img]`、`[img src=url]...[/img]`、HTML `<img src="url">`、直接图片 URL。
- OpenGraph：`[og url="..." img="..." title="..."]fallback[/og]`。
- 链接：`[url=href]label[/url]`、`[url]href[/url]`、普通 `http(s)` URL。
- 纯单图消息会渲染为图片气泡；混合文本和图片会渲染为富文本内容。

## 7. 历史记录、日志与缓存

### 7.1 聊天日志

- 日志文件为 `logs/chat.jsonl`。
- 每行是一条 JSON 消息记录。
- `logger.js` 监听 `friendMessage` 和 `friendMessageEcho` 并写入日志。
- `chat.js` 发送文本和图片时也会写入同一日志。
- `logger.js` 在首次获取某个用户资料时，会尝试通过 Steam 拉取该好友历史消息并导入本地日志。
- `/history` 和 `/conversations` 只读取本地日志，不会主动向 Steam 远端查询历史。

### 7.2 历史查询

- `/history` 可按 `id` 过滤会话。
- `limit` 默认 100，最大 500。
- 返回前会补齐旧日志缺失字段，例如旧文本日志没有 `type` 时会补为 `message`。
- 结果按 `date` 或 `sentAt` 升序排序，同一时间下按 `ordinal` 升序。
- 日志文件不存在时返回空数组。
- 无法解析的 JSONL 行会跳过并记录 warning。

### 7.3 会话摘要

- `/conversations` 基于最近日志生成会话列表。
- 会话列表按最近更新时间倒序排列。
- 摘要预览会识别图片、贴纸、表情-only 消息和 OpenGraph 标题。
- 如果会话名称缺失，会尝试通过 Steam 用户信息补齐。

### 7.4 图片和贴纸缓存

- 贴纸缓存目录：`logs/stickers`。
- 图片缓存目录：`logs/images`。
- 贴纸缓存路径基于贴纸类型生成。
- 远程图片缓存路径基于 URL 的 SHA-1 生成，同时保存 `.bin` 数据和 `.json` 元信息。
- 远程图片 Content-Type 优先根据 URL 后缀推断，fallback 到源响应头或 `image/png`。
- 对同一贴纸或同一图片 URL 的并发请求会合并为一个下载 Promise。
- 图片代理只接受 `http://` 或 `https://`，并拒绝 `localhost`、回环地址、`0.0.0.0` 和局域网 IPv4，降低 SSRF 风险。

## 8. 前端 Web UI 功能

### 8.1 页面布局

Web UI 是纯浏览器 ES Module 应用，无前端框架。页面分为：

- 左侧侧栏：打开会话、历史条数、反馈状态、最近会话、好友、群组。
- 主聊天区：当前会话标题、连接状态、消息列表、消息发送区。
- 全局浮层：拖拽图片提示、图片 lightbox。

样式入口为 `public/style.css`，按模块引入 `base.css`、`sidebar.css`、`messages.css`、`composer.css`、`overlays.css`、`responsive.css`。

### 8.2 初始化流程

前端启动后：

1. 从 `localStorage` 恢复最近使用的目标 SteamID 和历史条数。
2. 请求 `/api/config` 获取 WebSocket 路径，失败时回退到 `/ws`。
3. 建立 WebSocket 连接。
4. 收到 `ready` 后请求最近会话、好友、群组和表情/贴纸库存。
5. 如果已有活跃会话，加载该会话历史；否则优先恢复本地目标 SteamID，再退到最近会话列表第一项。

### 8.3 会话、好友与群组侧栏

- 最近会话展示名称、更新时间、消息预览和 SteamID。
- 好友列表展示头像、昵称、SteamID、在线状态和正在游戏信息。
- 群组列表展示群组名称和 ID。
- 点击最近会话、好友或群组会切换当前会话并加载历史。
- 侧栏 tab 支持鼠标点击和键盘方向键、Home、End 导航。
- 支持手动输入 SteamID64 打开会话。
- 支持刷新历史、刷新最近会话、刷新好友列表、刷新群组列表。

### 8.4 消息列表

- 历史消息批量渲染，实时消息增量追加。
- 自己和对方消息使用不同方向的消息行。
- 每条消息显示发送方昵称和时间。
- 跨天插入日期分隔线。
- 同一天内两条消息间隔超过 10 分钟时插入时间分隔线。
- 渲染历史或追加新消息后自动滚动到底部。
- 切换会话或清空消息时会清理已创建的图片对象 URL 和未完成图片请求。

### 8.5 消息发送区

文本发送：

- 点击发送按钮或按 Enter 发送。
- Shift+Enter 换行。
- 输入框会按内容自动调整高度，移动端和桌面端有不同高度上限。
- 未选择会话且没有有效内容时会显示状态提示。

图片发送：

- 支持选择本地图片文件。
- 支持输入远程图片 URL。
- 支持在输入框或页面中直接粘贴剪切板图片。
- 支持拖拽一个或多个图片文件到页面，多个文件会依次发送。
- 未选择会话时，图片会先进入待发送附件预览。
- 发送区有上传队列，展示读取进度、等待确认、成功或失败状态。
- WebSocket 断开时会将挂起上传请求标记为失败。

表情和贴纸：

- 表情/贴纸选择器有独立 tab。
- 支持搜索库存中的表情或贴纸。
- 表情按 `use_count` 和名称排序，点击后插入输入框光标位置。
- 贴纸按 `use_count` 和名称排序，点击后立即发送贴纸 BBCode。
- 输入 `:xxx` 时会出现表情自动补全建议。
- 自动补全支持上下键选择、Tab 或 Enter 应用、Escape 关闭。
- 发送或加载历史时会记住出现过的表情，提高后续补全命中率。

### 8.6 图片展示与预览

- 消息中的图片通过 `/proxy/image` 加载，避免浏览器直接访问远程图片。
- 图片加载使用 XHR，展示加载中、百分比、失败状态。
- 加载成功后使用 Blob object URL 显示，并在清理时释放。
- 图片、OpenGraph 缩略图和单图气泡都可点击打开 lightbox。
- lightbox 支持滚轮缩放、按钮缩放、双击放大/还原、拖拽平移、触摸双指缩放。
- lightbox 支持 Escape 关闭、点击背景关闭，并在关闭后恢复焦点。

### 8.7 通知与未读

- 浏览器支持 Notification API 时，首次 pointerdown 或 keydown 会尝试预热通知权限。
- 当页面隐藏、窗口失焦、没有活跃会话或新消息来自非活跃会话时，会增加未读数。
- 未读数会显示在 document title 中。
- 非自己发送的新消息在通知权限为 granted 时会弹出系统通知。
- 点击通知会聚焦窗口、切换到对应会话并重新加载历史。
- 页面重新可见或窗口聚焦时清空未读数。

### 8.8 移动端适配

- 900px 及以下进入移动布局。
- 移动端侧栏改为抽屉，支持遮罩关闭和按钮开关。
- 使用 `visualViewport` 和 CSS 变量处理移动端键盘、视口高度和安全区域。
- 移动端输入框 placeholder 和高度范围与桌面端不同。
- 退出移动布局时会自动关闭侧栏。

## 9. 配置、安全与运维能力

### 9.1 配置项

`config.example.js` 包含：

- `accountName`: Steam 登录名。
- `password`: Steam 密码。
- `logonID`: 随机登录 ID。
- `steamID`: 当前账号 SteamID。
- `chat.enabled`: 是否启用聊天服务。
- `chat.host`: HTTP 服务监听地址，默认 `0.0.0.0`。
- `chat.port`: HTTP 服务端口，默认 `3000`。
- `chat.wsPath`: WebSocket 路径，默认 `/ws`。
- `chat.auth.username`: Basic Auth 用户名。
- `chat.auth.password`: Basic Auth 密码。
- `chat.auth.realm`: Basic Auth realm。
- `chat.auth.trustProxy`: 是否信任反向代理 IP 头。
- `identitySecret`: 可选，用于 Steam confirmation checker。

`config.chat` 也可以直接配置为 `true`，表示启用聊天服务并使用默认参数。

### 9.2 环境变量

| 变量 | 功能 |
|------|------|
| `STEAM_CHAT_DISABLE_AUTOSTART=1` | 禁用 `chat.js` 自动启动，主要用于测试或手动构造服务 |

### 9.3 安全边界

- 生产环境应修改默认 Basic Auth 密码。
- 建议在反向代理后启用 HTTPS。
- Basic Auth 默认放行局域网和回环地址，公网暴露时应结合网络边界检查。
- 开启 `trustProxy` 前应确认反向代理会覆盖客户端传入的转发头。
- `/proxy/image` 对明显本地和局域网 IPv4 做拒绝，但它不是完整的网络沙箱。
- `config.js`、`refresh.token`、`logs/` 都属于运行态或敏感文件，不应提交真实内容。

### 9.4 运行与测试

安装依赖：

```bash
npm install
```

运行服务：

```bash
node client.js
```

测试：

```bash
npm test
```

当前 `package.json` 只有 `test` 脚本，没有独立 `build`、`lint` 或类型检查脚本。

## 10. 当前限制与注意事项

- `/history` 和 `/conversations` 只基于本地 `logs/chat.jsonl`，不会实时拉取 Steam 远端历史。
- `logger.js` 会在首次获取某好友资料时尝试导入 Steam 历史，但这不是每次查询历史都执行的同步远端拉取。
- 好友和群组列表依赖 `steamUser` 当前进程内状态，服务刚登录或 Steam 状态未同步完成时可能为空或信息不完整。
- 表情和贴纸库存依赖 Steam Web Session 和内部 Steam 消息接口，网络或 Session 异常时会失败。
- 图片上传依赖 `SteamCommunity` Web Session 和 Steam 图片上传能力。
- 图片 URL 发送会由服务端下载远程资源，因此受远程站点可用性、响应速度和图片大小影响。
- Web UI 是纯前端页面，没有用户管理、多账号管理或服务端会话隔离。
- 当前项目使用 CommonJS 后端和浏览器 ES Module 前端，不能在同一文件内混用模块系统。
