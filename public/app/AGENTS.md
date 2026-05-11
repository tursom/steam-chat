# Frontend Modules (public/app/)

**Domain:** Browser-side ES6 modules for Steam Chat UI

## STRUCTURE
```
app/
├── bootstrap.js        # Page init, event binding, config fetch
├── session.js          # Active conversation state, sidebar data
├── websocket.js        # WebSocket client, auto-reconnect, request IDs
├── composer.js         # Message input, attachments, emoticon/sticker picker
├── messages.js         # Message list rendering, history, separators
├── message-bubble.js   # Individual bubble rendering (text/image/sticker)
├── sidebar.js          # Conversations/friends/groups tabs
├── lightbox.js         # Image preview modal with zoom
├── managed-images.js   # Lazy loading, image lifecycle
├── rich-content.js     # Emoticons, link cards, BBCode parsing
├── notifications.js    # Desktop notifications, unread count
├── preferences.js      # localStorage for target ID, history limit
├── layout.js           # Responsive layout, mobile sidebar toggle
├── status.js           # Connection status chip
├── dom.js              # DOM element references
└── utils.js            # Date formatting, Steam URL builders, parsers
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Add new WebSocket message type | `websocket.js` switch statement |
| Change message rendering | `message-bubble.js` |
| Add emoticon/sticker support | `composer.js` + `rich-content.js` |
| Modify layout breakpoints | `layout.js` (900px mobile) |
| Add keyboard shortcuts | `bootstrap.js` or `composer.js` |
| Change date/time format | `utils.js` |
| Mobile sidebar behavior | `layout.js`, `sidebar.js` |

## CONVENTIONS

### Module Pattern
```javascript
export function createXController({ dep1, dep2 }) {
  // private state
  let state = {};
  
  function privateFn() {}
  
  function publicFn() {}
  
  return {
    publicFn,
    // only expose necessary methods
  };
}
```

### Event Handling
- Prefer delegation: `container.addEventListener('click', handler)`
- Check targets: `if (event.target.matches('.class'))`
- One-time warmup: `{ once: true }` option

### DOM References
- Centralized in `dom.js` via `getAppDomRefs(document)`
- Passed as dependencies to controllers
- Avoid querying DOM repeatedly

### WebSocket Communication
- Request IDs: `${prefix}-${counter++}` format
- Types: `send_message`, `get_history`, `get_conversations`, `get_friends`, `get_groups`, `get_emoticons`
- Auto-reconnect on disconnect (3s delay)

## ANTI-PATTERNS
- **DO NOT** use inline event handlers (onclick="...")
- **DO NOT** import Node.js modules (fs, path, etc.)
- **AVOID** direct DOM manipulation outside controllers
- **NEVER** store sensitive data in localStorage

## DEPENDENCIES
- Pure vanilla JS, no frameworks
- Native WebSocket API
- Native Fetch API (for `/api/config`)
- `window.visualViewport` for mobile keyboard handling
