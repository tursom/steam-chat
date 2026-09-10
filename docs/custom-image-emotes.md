# 自定义图片表情

## 使用

管理员从侧栏「图片表情」进入共享素材库，先建立分组，再选择图片上传。支持批量选择文件，按顺序保存；中途失败会显示已经保存的数量并停止，避免对结果不明的上传自动重试。

- 分组支持新增、改名、删除。仅空分组可以删除；非空分组先移动或删除图片。
- 图片支持预览、改名、移动分组、删除。
- 后台有 `chat.use` 权限的用户可以读取共享素材库，管理操作仅允许管理员。
- 素材库由同一后台的用户和 Steam 账号共享；实际发送仍要求用户获准访问当前 Steam 账号，Steam 在线且账号前置条件一致。
- 在聊天输入区打开表情面板，选择「自定义」，可以按分组和名称筛选。点击图片立即单独发送，保留尚未发送的文字和粘贴附件。
- 发送有本地图片预览、发送状态及现有上传处理状态；不自动重发结果未确认的请求。

## 限制和存储

图片支持 PNG、JPEG、GIF、WebP，单张最多 7 MiB、4000 万像素。保留原文件，不重新编码，GIF/APNG/WebP 中的动画字节保留。浏览器预览使用原文件并延迟加载，不生成额外缩略图文件。

最多 100 个分组、1000 条素材记录、512 MiB 被引用的去重图片数据。名称为 1–80 个字符，分组名称不能重复。

存储目录为 `${STEAM_CHAT_DATA_DIR}/image-emotes/`（未配置时为现有 `data/image-emotes/`）：

- `catalog.json`：分组、素材 ID、图片尺寸、MIME、内容哈希、版本号。
- `blobs/<sha256>`：内容寻址的原图。同一图片放在不同分组时共用文件；同一分组内拒绝重复添加。

单个应用进程内串行处理读写，元数据以临时文件替换发布。前端提交版本号，过期编辑返回 409，要求刷新，避免覆盖其他管理员的编辑。此实现不支持多个应用进程同时写同一个素材库目录。

删除最后一条引用时尝试删除原图；已发往 Steam 的图片和历史不受影响。已开始的发送先读取 Buffer 快照，之后删除素材不会更改该次发送的字节。崩溃或清理失败可能遗留无引用文件，备份应包含整个目录，手工清理需停服务并对照 catalog 的 hash 列表。

此存储独立于聊天历史双写，不修改 RocksDB、JSONL 或认证数据库。

## API

所有素材接口要求后台会话登录，匿名返回 401。文件按受保护的 ID 读取，不接受服务器路径；不公开磁盘哈希路径。图片响应包含确定的 MIME、`nosniff` 和 `private, no-store`。

- `GET /api/image-emotes`：返回 `{version, groups, images}`，要求 `chat.use`。
- `GET /api/image-emotes/file/:id`：读取原图，要求 `chat.use`。
- `POST /api/image-emotes`：管理员提交 `{version, action, ...fields}`。

| action | 附加字段 |
| --- | --- |
| createGroup | name |
| renameGroup | id, name |
| deleteGroup | id |
| addImage | groupId, name, data（图片 data URL） |
| updateImage | id, groupId, name |
| deleteImage | id |

发送复用现有 `POST /image`，请求为 `{id: 对方SteamID, emoteId: 素材ID, steamAccountId: 当前账号SteamID}`。WebSocket 图片发送亦支持 `emoteId`。浏览器无需再次上传图片，后端读取素材后仍按官方流程上传至 Steam，依据真实上传回调确认结果，不跳过 PUT。

## 验证

`npm test` 包含分组与图片持久化、字节去重、动画原文件保留、并发版本冲突、权限、格式/大小限制、删除、账号隔离及按素材 ID 发送测试。

安装 Playwright 和 Chromium 后，可以运行：

```sh
npm run build
node test/browser/image-emotes.cjs
```

浏览器测试使用真实 HTTP 后端、认证和素材存储，仅 Steam 图片发送器为模拟实现；不向真实好友发送测试消息。覆盖桌面和手机视口、分组操作、页面重载、按 ID 发送、保留草稿和发送中预览。
