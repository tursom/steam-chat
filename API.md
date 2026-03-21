# Steam Chat 服务 API 文档

本文档基于当前仓库中的 `chat.js` 实现整理，说明该服务对外提供的 HTTP 与 WebSocket API。

## 1. 启用服务

在 `config.js` 中启用 `chat` 配置即可。

### 最简写法

```js
module.exports = {
  // ...
  chat: true,
};
```

等价于：

```js
chat: {
  enabled: true,
  host: '0.0.0.0',
  port: 3000,
  wsPath: '/ws',
  auth: {
    username: 'admin',
    password: 'change-me',
    realm: 'Steam Chat',
    trustProxy: false,
  },
}
```

### 完整写法

```js
chat: {
  enabled: true,
  host: '0.0.0.0',
  port: 3000,
  wsPath: '/ws',
}
```

## 2. 基本说明

- 默认监听地址：`0.0.0.0:3000`
- 默认 WebSocket 路径：`/ws`
- 可选 HTTP Basic Auth：当请求来源不是局域网/回环地址，且配置了 `chat.auth.username` 与 `chat.auth.password` 时，会要求输入用户名和密码
- 反向代理支持：将 `chat.auth.trustProxy` 设为 `true` 后，会优先解析 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`
- 根页面：`GET /` 会返回内置聊天页面
- 历史记录来源：本地日志文件 `logs/chat.jsonl`
- 贴纸缓存目录：`logs/stickers`
- 图片缓存目录：`logs/images`
- 错误响应统一为：

```json
{ "error": "错误信息" }
```

未认证时返回：

```json
{ "error": "Authentication Required" }
```

## 3. 数据结构

### 3.1 历史消息项 `HistoryItem`

```json
{
  "type": "message",
  "date": "2026-03-20 10:00:00.000",
  "echo": false,
  "id": "7656119xxxxxxxxxx",
  "name": "Friend",
  "message": "hello",
  "imageUrl": null,
  "ordinal": 1,
  "sentAt": null
}
```

字段说明：

- `type`: `message` 或 `image`
- `date`: 格式通常为 `yyyy-mm-dd HH:MM:ss.l`
- `echo`: 是否为自己发送的消息
- `id`: 会话对象 SteamID
- `name`: 显示名称
- `message`: 文本消息内容；图片记录通常为空字符串
- `imageUrl`: 图片消息的远程地址，没有则为 `null`
- `ordinal`: Steam 消息序号；图片记录通常为 `null`
- `sentAt`: 某些图片记录可能带 ISO 时间戳

### 3.2 会话摘要项 `ConversationSummary`

```json
{
  "id": "7656119xxxxxxxxxx",
  "name": "Friend",
  "updatedAt": "2026-03-20 10:00:00.000",
  "preview": "hello",
  "lastType": "message",
  "lastEcho": false,
  "messageCount": 12
}
```

字段说明：

- `preview`: 最近一条消息的摘要，可能是普通文本，也可能是 `[图片]`、`[贴纸] xxx`、`[表情] xxx`
- `lastType`: `message` 或 `image`
- `lastEcho`: 最近一条是否为自己发送
- `messageCount`: 当前日志窗口内该会话的消息数

## 4. HTTP API

以下示例默认服务地址为 `http://127.0.0.1:3000`。

### 4.1 发送文本消息

**POST** `/message`

兼容别名：**POST** `/`

请求体：

```json
{
  "id": "7656119xxxxxxxxxx",
  "msg": "你好"
}
```

必填字段：

- `id`: 对方 SteamID
- `msg`: 文本内容

成功响应：`200 OK`

```json
{
  "type": "message",
  "date": "2026-03-20 10:00:00.000",
  "echo": true,
  "id": "7656119xxxxxxxxxx",
  "name": "MyName",
  "message": "你好",
  "imageUrl": null,
  "ordinal": 42,
  "sentAt": null
}
```

示例：

```bash
curl -X POST http://127.0.0.1:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"id":"7656119xxxxxxxxxx","msg":"hello"}'
```

### 4.2 发送图片

**POST** `/image`

兼容别名：**POST** `/img`

请求体支持两种方式：

#### 方式 A：直接上传 base64

```json
{
  "id": "7656119xxxxxxxxxx",
  "img": "iVBORw0KGgoAAAANSUhEUg..."
}
```

`img` 可以是：

- 纯 base64 内容
- `data:image/png;base64,...` 这种 Data URL

#### 方式 B：让服务端下载远程图片后转发

```json
{
  "id": "7656119xxxxxxxxxx",
  "url": "https://example.com/demo.png"
}
```

说明：

- `id` 必填
- `img` 与 `url` 至少提供一个
- 如果两者同时提供，服务端优先使用 `url`

成功响应：`200 OK`

```json
{
  "type": "image",
  "date": "2026-03-20 10:00:00.000",
  "echo": true,
  "id": "7656119xxxxxxxxxx",
  "name": "MyName",
  "message": "",
  "imageUrl": "https://...",
  "ordinal": null,
  "sentAt": "2026-03-20T10:00:00.000Z"
}
```

示例：

```bash
curl -X POST http://127.0.0.1:3000/image \
  -H 'Content-Type: application/json' \
  -d '{"id":"7656119xxxxxxxxxx","url":"https://example.com/demo.png"}'
```

### 4.3 获取历史记录

**GET** `/history`

查询参数：

- `id`：可选，仅返回指定 SteamID 的记录
- `limit`：可选，返回条数上限，默认 `100`，最大 `500`

示例：

```bash
curl 'http://127.0.0.1:3000/history?id=7656119xxxxxxxxxx&limit=50'
```

成功响应：

```json
{
  "items": [
    {
      "type": "message",
      "date": "2026-03-20 10:00:00.000",
      "echo": false,
      "id": "7656119xxxxxxxxxx",
      "name": "Friend",
      "message": "hello",
      "imageUrl": null,
      "ordinal": 1,
      "sentAt": null
    }
  ]
}
```

说明：

- 数据来自本地日志 `logs/chat.jsonl`
- 返回结果按时间升序排序；同一时间下按 `ordinal` 升序

### 4.4 获取最近会话摘要

**GET** `/conversations`

查询参数：

- `limit`：可选，默认 `500`，最大 `500`

示例：

```bash
curl 'http://127.0.0.1:3000/conversations?limit=200'
```

成功响应：

```json
{
  "items": [
    {
      "id": "7656119xxxxxxxxxx",
      "name": "Friend",
      "updatedAt": "2026-03-20 10:00:00.000",
      "preview": "hello",
      "lastType": "message",
      "lastEcho": false,
      "messageCount": 12
    }
  ]
}
```

说明：

- 这里的 `limit` 是“用于生成摘要的历史记录条数”，不是最终会话数上限
- 返回结果按 `updatedAt` 倒序排列

### 4.5 代理贴纸图片

**GET** `/proxy/sticker/:type`

示例：

```bash
curl -o sticker.png 'http://127.0.0.1:3000/proxy/sticker/Sticker_MalteseCry'
```

说明：

- 服务会尝试从 Steam 贴纸地址下载图片
- 成功后缓存到 `logs/stickers`
- 成功响应内容类型固定为 `image/png`

### 4.6 代理远程图片

**GET** `/proxy/image?url=...`

示例：

```bash
curl -o image.png 'http://127.0.0.1:3000/proxy/image?url=https%3A%2F%2Fexample.com%2Fa.png'
```

说明：

- 服务会下载指定远程图片并缓存到 `logs/images`
- 响应 `Content-Type` 会尽量根据 URL 后缀或源响应头推断
- `url` 必须是 `http://` 或 `https://`

### 4.7 内置聊天页面

**GET** `/`

返回一个内置 HTML 页面，页面内部通过 WebSocket 调用下文的实时接口。

## 5. WebSocket API

连接地址：

```text
ws://<host>:<port><wsPath>
```

默认示例：

```text
ws://127.0.0.1:3000/ws
```

### 5.1 连接建立后的消息

服务端在连接成功后会先主动发送：

```json
{
  "type": "ready",
  "data": {
    "wsPath": "/ws"
  }
}
```

### 5.2 客户端请求格式

所有请求均为 JSON。可选携带 `requestId`，服务端会原样带回，便于请求响应配对。

```json
{
  "type": "send_message",
  "requestId": "req-1",
  "id": "7656119xxxxxxxxxx",
  "msg": "hello"
}
```

### 5.3 支持的请求类型

#### 发送文本消息

```json
{
  "type": "send_message",
  "requestId": "req-1",
  "id": "7656119xxxxxxxxxx",
  "msg": "hello"
}
```

兼容别名：`type: "msg"`

成功响应：

```json
{
  "type": "message_sent",
  "requestId": "req-1",
  "data": {
    "type": "message",
    "date": "2026-03-20 10:00:00.000",
    "echo": true,
    "id": "7656119xxxxxxxxxx",
    "name": "MyName",
    "message": "hello",
    "imageUrl": null,
    "ordinal": 42,
    "sentAt": null
  }
}
```

#### 发送图片

```json
{
  "type": "send_image",
  "requestId": "req-2",
  "id": "7656119xxxxxxxxxx",
  "url": "https://example.com/demo.png"
}
```

或：

```json
{
  "type": "send_image",
  "requestId": "req-2",
  "id": "7656119xxxxxxxxxx",
  "img": "iVBORw0KGgoAAAANSUhEUg..."
}
```

兼容别名：`type: "img"`

成功响应：

```json
{
  "type": "image_sent",
  "requestId": "req-2",
  "data": {
    "type": "image",
    "date": "2026-03-20 10:00:00.000",
    "echo": true,
    "id": "7656119xxxxxxxxxx",
    "name": "MyName",
    "message": "",
    "imageUrl": "https://...",
    "ordinal": null,
    "sentAt": "2026-03-20T10:00:00.000Z"
  }
}
```

#### 获取历史记录

```json
{
  "type": "get_history",
  "requestId": "req-3",
  "id": "7656119xxxxxxxxxx",
  "limit": 50
}
```

兼容别名：`type: "history"`

成功响应：

```json
{
  "type": "history",
  "requestId": "req-3",
  "data": {
    "items": []
  }
}
```

#### 获取会话摘要

```json
{
  "type": "get_conversations",
  "requestId": "req-4",
  "limit": 200
}
```

兼容别名：`type: "conversations"`

成功响应：

```json
{
  "type": "conversations",
  "requestId": "req-4",
  "data": {
    "items": []
  }
}
```

#### 心跳

```json
{
  "type": "ping",
  "requestId": "ping-1"
}
```

成功响应：

```json
{
  "type": "pong",
  "requestId": "ping-1",
  "data": {
    "now": "2026-03-20T10:00:00.000Z"
  }
}
```

### 5.4 服务端主动推送事件

#### 文本消息广播

当服务收到 Steam 好友消息，或通过 HTTP / WebSocket 成功发送文本消息后，会广播：

```json
{
  "type": "message",
  "data": {
    "type": "message",
    "date": "2026-03-20 10:00:00.000",
    "echo": false,
    "id": "7656119xxxxxxxxxx",
    "name": "Friend",
    "message": "hello",
    "imageUrl": null,
    "ordinal": 1,
    "sentAt": null
  }
}
```

#### 图片发送广播

当通过服务成功发送图片后，会广播：

```json
{
  "type": "image",
  "data": {
    "type": "image",
    "date": "2026-03-20 10:00:00.000",
    "echo": true,
    "id": "7656119xxxxxxxxxx",
    "name": "MyName",
    "message": "",
    "imageUrl": "https://...",
    "ordinal": null,
    "sentAt": "2026-03-20T10:00:00.000Z"
  }
}
```

#### 错误消息

请求失败时，服务端会返回：

```json
{
  "type": "error",
  "requestId": "req-1",
  "message": "错误信息"
}
```

若收到非法 JSON，则返回：

```json
{
  "type": "error",
  "message": "Invalid JSON"
}
```

## 6. 行为细节

### 6.1 去重策略

服务在本地发送文本消息后，会记录一个短期去重键；如果随后从 Steam 收到同一条 `friendMessageEcho`，15 秒内会避免重复广播。

### 6.2 图片发送

发送图片时依赖 Steam Web Session：

- 服务会先等待 Steam 登录和 Web Session 就绪
- 如果首次上传失败，会尝试刷新一次 Web Session 后重试

### 6.3 历史记录来源

`/history` 和 `/conversations` 都基于本地日志文件，不会主动向 Steam 拉取远端历史消息。

## 7. 快速示例

### HTTP 发送消息

```bash
curl -X POST http://127.0.0.1:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"id":"7656119xxxxxxxxxx","msg":"hello"}'
```

### WebSocket 发送消息

```js
const ws = new WebSocket('ws://127.0.0.1:3000/ws');

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'send_message',
    requestId: 'req-1',
    id: '7656119xxxxxxxxxx',
    msg: 'hello',
  }));
};
```
