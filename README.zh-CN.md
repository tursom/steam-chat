# Steam Chat

[English](./README.md)

一个基于 Steam API 的实时聊天服务，支持通过 HTTP/WebSocket 接口发送和接收消息，并提供内置的 Web 聊天界面。

## 功能特性

- **实时消息收发**：支持通过 WebSocket 实时接收 Steam 好友消息
- **多媒体支持**：发送/接收图片、表情、贴纸
- **历史记录**：本地 JSONL 文件存储聊天记录
- **HTTP API**：提供完整的 RESTful API 接口
- **内置 Web UI**：响应式设计，支持桌面端和移动端
- **图片代理**：自动缓存远程图片，支持贴纸和图片代理
- **身份验证**：可选的 HTTP Basic Auth 保护

## 项目结构

```
steam-chat/
├── public/                    # 前端资源
│   ├── index.html            # 主页面
│   ├── style.css             # 样式入口
│   ├── app.js                # 前端主脚本
│   ├── app/                  # 前端模块化代码
│   │   ├── bootstrap.js       # 页面初始化与事件绑定
│   │   ├── composer.js        # 消息发送组件
│   │   ├── dom.js            # DOM 引用收集
│   │   ├── layout.js         # 响应式布局控制
│   │   ├── lightbox.js       # 图片预览弹层
│   │   ├── managed-images.js # 图片管理
│   │   ├── messages.js       # 消息列表渲染
│   │   ├── message-bubble.js # 消息气泡渲染
│   │   ├── notifications.js  # 桌面通知
│   │   ├── preferences.js    # 本地偏好设置
│   │   ├── rich-content.js   # 富内容渲染
│   │   ├── session.js        # 会话状态管理
│   │   ├── sidebar.js        # 侧栏渲染
│   │   ├── status.js         # 连接状态显示
│   │   ├── utils.js          # 工具函数
│   │   └── websocket.js      # WebSocket 通信
│   └── styles/               # CSS 模块化文件
│       ├── base.css          # 基础样式
│       ├── composer.css      # 发送区样式
│       ├── messages.css      # 消息区样式
│       ├── overlays.css      # 弹层样式
│       ├── responsive.css    # 响应式样式
│       └── sidebar.css       # 侧栏样式
├── logs/                     # 日志目录
│   ├── chat.jsonl            # 聊天记录
│   ├── images/               # 图片缓存
│   └── stickers/             # 贴纸缓存
├── test/                     # 测试文件
├── client.js                 # Steam 客户端封装
├── chat.js                   # 聊天服务核心
├── config.js                 # 配置文件
├── config.example.js         # 配置示例
├── logger.js                 # 日志记录器
└── package.json              # 项目依赖
```

## 快速开始

### 环境要求

- Node.js 18+
- Steam 账号

### 安装

```bash
npm install
```

### 配置

复制配置文件并编辑：

```bash
cp config.example.js config.js
```

编辑 `config.js`：

```javascript
module.exports = {
    accountName: 'your_steam_username',
    password: 'your_steam_password',
    steamID: "your_steam_id64",
    // 可选：两步验证
    // identitySecret: 'your_identity_secret',

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
    },
};
```

### 运行

```bash
node client.js
```

服务启动后，访问 `http://localhost:3000` 打开聊天界面。

### 测试

```bash
npm test
```

## API 文档

详细 API 文档请参阅 [API.md](./API.md)。

### 基础信息

- 默认监听地址：`0.0.0.0:3000`
- WebSocket 路径：`/ws`
- 根页面：`GET /` 返回内置聊天页面

### HTTP API

#### 发送文本消息

```bash
POST /message
# 或
POST /

{
  "id": "7656119xxxxxxxxxx",  # 对方 SteamID
  "msg": "你好"
}
```

#### 发送图片

```bash
POST /image
# 或
POST /img

# 方式 A：Base64 编码
{
  "id": "7656119xxxxxxxxxx",
  "img": "iVBORw0KGgoAAAANSUhEUg..."
}

# 方式 B：远程 URL
{
  "id": "7656119xxxxxxxxxx",
  "url": "https://example.com/image.png"
}
```

#### 获取历史记录

```bash
GET /history?id=7656119xxxxxxxxxx&limit=100
```

#### 获取会话列表

```bash
GET /conversations?limit=200
```

### WebSocket API

连接地址：`ws://localhost:3000/ws`

#### 发送消息

```javascript
ws.send(JSON.stringify({
  type: 'send_message',
  requestId: 'req-1',
  id: '7656119xxxxxxxxxx',
  msg: 'hello'
}));
```

#### 获取历史

```javascript
ws.send(JSON.stringify({
  type: 'get_history',
  requestId: 'req-2',
  id: '7656119xxxxxxxxxx',
  limit: 50
}));
```

## 配置选项

### 聊天服务配置 (`config.chat`)

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用聊天服务 |
| `host` | string | `'0.0.0.0'` | 监听地址 |
| `port` | number | `3000` | 监听端口 |
| `wsPath` | string | `'/ws'` | WebSocket 路径 |
| `auth.username` | string | `''` | HTTP Basic Auth 用户名 |
| `auth.password` | string | `''` | HTTP Basic Auth 密码 |
| `auth.realm` | string | `'Steam Chat'` | 认证领域名称 |
| `auth.trustProxy` | boolean | `false` | 是否信任反向代理 |

## 前端模块说明

### 核心模块

| 模块 | 职责 |
|------|------|
| `bootstrap.js` | 页面初始化、事件绑定、配置拉取 |
| `session.js` | 会话状态管理、当前会话信息 |
| `websocket.js` | WebSocket 连接、消息发送、请求 ID 管理 |
| `dom.js` | DOM 元素引用收集 |

### 功能模块

| 模块 | 职责 |
|------|------|
| `composer.js` | 消息输入、附件上传、表情/贴纸选择器 |
| `messages.js` | 消息列表渲染、分隔线、批量渲染 |
| `message-bubble.js` | 消息气泡渲染、文本/图片/贴纸样式 |
| `sidebar.js` | 侧栏列表渲染（会话/好友/群组） |
| `lightbox.js` | 图片预览弹层、缩放控制 |
| `managed-images.js` | 图片懒加载管理 |
| `rich-content.js` | 富文本内容渲染（表情、链接卡片） |
| `notifications.js` | 桌面通知、新消息提醒 |
| `preferences.js` | 本地偏好存储（目标 ID、历史条数） |
| `layout.js` | 响应式布局、侧栏切换 |
| `status.js` | 连接状态显示 |

### 样式模块

| 文件 | 覆盖范围 |
|------|----------|
| `base.css` | 基础布局、按钮、表单、空状态 |
| `sidebar.css` | 侧栏、标签页、列表项 |
| `messages.css` | 消息区、消息气泡、分隔线 |
| `composer.css` | 发送区、输入框、选择器 |
| `overlays.css` | 弹层、图片预览、拖拽提示 |
| `responsive.css` | 移动端适配、断点样式 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `STEAM_CHAT_DISABLE_AUTOSTART` | 设置为 `1` 可禁用自动启动聊天服务 |

## 安全说明

- 生产环境请务必修改默认的 HTTP Basic Auth 密码
- 建议通过反向代理（如 Nginx）启用 HTTPS
- 图片代理功能会自动缓存远程资源

## 依赖

### 主要依赖

- `steam-user` - Steam 登录和 API
- `steamcommunity` - Steam 社区功能
- `steam-totp` - Steam 两步验证
- `ws` - WebSocket 服务器
- `winston` - 日志记录
- `axios` - HTTP 请求

### 开发依赖

- `@types/steam-user`
- `@types/steamcommunity`
- `@types/steam-totp`

## 许可证

[GPL-3.0](./LICENSE)
