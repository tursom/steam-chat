# Steam Chat

[中文](./README.zh-CN.md)

A real-time chat service based on Steam API, supporting sending and receiving messages via HTTP/WebSocket interfaces, with a built-in web chat UI.

## Features

- **Real-time Messaging**: Receive Steam friend messages in real-time via WebSocket
- **Multimedia Support**: Send/receive images, emoticons, and stickers
- **Message History**: Local JSONL file storage for chat logs
- **HTTP API**: Complete RESTful API interface
- **Built-in Web UI**: Responsive design for desktop and mobile
- **Image Proxy**: Automatic caching of remote images, sticker and image proxy support
- **Authentication**: Optional HTTP Basic Auth protection

## Project Structure

```
steam-chat/
├── public/                    # Frontend resources
│   ├── index.html            # Main page
│   ├── style.css             # Style entry point
│   ├── app.js                # Frontend main script
│   ├── app/                  # Modular frontend code
│   │   ├── bootstrap.js       # Page initialization & event binding
│   │   ├── composer.js        # Message composer component
│   │   ├── dom.js            # DOM reference collection
│   │   ├── layout.js         # Responsive layout control
│   │   ├── lightbox.js       # Image preview modal
│   │   ├── managed-images.js # Image management
│   │   ├── messages.js       # Message list rendering
│   │   ├── message-bubble.js # Message bubble rendering
│   │   ├── notifications.js  # Desktop notifications
│   │   ├── preferences.js    # Local preferences
│   │   ├── rich-content.js   # Rich content rendering
│   │   ├── session.js        # Session state management
│   │   ├── sidebar.js        # Sidebar rendering
│   │   ├── status.js         # Connection status display
│   │   ├── utils.js          # Utility functions
│   │   └── websocket.js      # WebSocket communication
│   └── styles/               # Modular CSS files
│       ├── base.css          # Base styles
│       ├── composer.css      # Composer styles
│       ├── messages.css      # Message area styles
│       ├── overlays.css      # Overlay styles
│       ├── responsive.css    # Responsive styles
│       └── sidebar.css       # Sidebar styles
├── logs/                     # Log directory
│   ├── chat.jsonl            # Chat history
│   ├── images/               # Image cache
│   └── stickers/             # Sticker cache
├── test/                     # Test files
├── client.js                 # Steam client wrapper
├── chat.js                   # Chat service core
├── config.js                 # Configuration file
├── config.example.js         # Configuration example
├── logger.js                 # Logger
└── package.json              # Dependencies
```

## Quick Start

### Requirements

- Node.js 18+
- Steam account

### Installation

```bash
npm install
```

### Configuration

Copy and edit the configuration file:

```bash
cp config.example.js config.js
```

Edit `config.js`:

```javascript
module.exports = {
    accountName: 'your_steam_username',
    password: 'your_steam_password',
    steamID: "your_steam_id64",
    // Optional: Two-factor authentication
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

### Running

```bash
node client.js
```

After starting, access `http://localhost:3000` to open the chat interface.

### Testing

```bash
npm test
```

## API Documentation

For detailed API documentation, see [API.md](./API.md).

### Basic Info

- Default listen address: `0.0.0.0:3000`
- WebSocket path: `/ws`
- Root page: `GET /` returns the built-in chat page

### HTTP API

#### Send Text Message

```bash
POST /message
# or
POST /

{
  "id": "7656119xxxxxxxxxx",  # Recipient's SteamID
  "msg": "Hello"
}
```

#### Send Image

```bash
POST /image
# or
POST /img

# Method A: Base64 encoded
{
  "id": "7656119xxxxxxxxxx",
  "img": "iVBORw0KGgoAAAANSUhEUg..."
}

# Method B: Remote URL
{
  "id": "7656119xxxxxxxxxx",
  "url": "https://example.com/image.png"
}
```

#### Get Message History

```bash
GET /history?id=7656119xxxxxxxxxx&limit=100
```

#### Get Conversation List

```bash
GET /conversations?limit=200
```

### WebSocket API

Connection address: `ws://localhost:3000/ws`

#### Send Message

```javascript
ws.send(JSON.stringify({
  type: 'send_message',
  requestId: 'req-1',
  id: '7656119xxxxxxxxxx',
  msg: 'hello'
}));
```

#### Get History

```javascript
ws.send(JSON.stringify({
  type: 'get_history',
  requestId: 'req-2',
  id: '7656119xxxxxxxxxx',
  limit: 50
}));
```

## Configuration Options

### Chat Service Configuration (`config.chat`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable chat service |
| `host` | string | `'0.0.0.0'` | Listen address |
| `port` | number | `3000` | Listen port |
| `wsPath` | string | `'/ws'` | WebSocket path |
| `auth.username` | string | `''` | HTTP Basic Auth username |
| `auth.password` | string | `''` | HTTP Basic Auth password |
| `auth.realm` | string | `'Steam Chat'` | Authentication realm |
| `auth.trustProxy` | boolean | `false` | Trust reverse proxy headers |

## Frontend Modules

### Core Modules

| Module | Responsibility |
|--------|----------------|
| `bootstrap.js` | Page initialization, event binding, config fetching |
| `session.js` | Session state management, current conversation info |
| `websocket.js` | WebSocket connection, message sending, request ID management |
| `dom.js` | DOM element reference collection |

### Feature Modules

| Module | Responsibility |
|--------|----------------|
| `composer.js` | Message input, attachment upload, emoticon/sticker picker |
| `messages.js` | Message list rendering, separators, batch rendering |
| `message-bubble.js` | Message bubble rendering, text/image/sticker styles |
| `sidebar.js` | Sidebar list rendering (conversations/friends/groups) |
| `lightbox.js` | Image preview modal, zoom controls |
| `managed-images.js` | Lazy image loading management |
| `rich-content.js` | Rich text rendering (emoticons, link cards) |
| `notifications.js` | Desktop notifications, new message alerts |
| `preferences.js` | Local preference storage (target ID, history limit) |
| `layout.js` | Responsive layout, sidebar toggle |
| `status.js` | Connection status display |

### Style Modules

| File | Coverage |
|------|----------|
| `base.css` | Base layout, buttons, forms, empty states |
| `sidebar.css` | Sidebar, tabs, list items |
| `messages.css` | Message area, bubbles, separators |
| `composer.css` | Composer area, input, picker |
| `overlays.css` | Modals, image preview, drag hints |
| `responsive.css` | Mobile adaptation, breakpoint styles |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `STEAM_CHAT_DISABLE_AUTOSTART` | Set to `1` to disable auto-start of chat service |

## Security Notes

- Always change the default HTTP Basic Auth password in production
- Recommended to enable HTTPS via reverse proxy (e.g., Nginx)
- Image proxy feature automatically caches remote resources

## Dependencies

### Main Dependencies

- `steam-user` - Steam login and API
- `steamcommunity` - Steam community features
- `steam-totp` - Steam two-factor authentication
- `ws` - WebSocket server
- `winston` - Logging
- `axios` - HTTP requests

### Dev Dependencies

- `@types/steam-user`
- `@types/steamcommunity`
- `@types/steam-totp`

## License

[GPL-3.0](./LICENSE)
