# Steam 素材库存缓存

表情、贴纸和聊天效果共用一份按 Steam 账号隔离的快照，各类别可以独立刷新。HTTP
`/api/emoticons` 和 WebSocket `get_emoticons` 使用相同的缓存及刷新任务。

## 服务端

- 快照保存到 `STEAM_CHAT_DATA_DIR/steam-inventory/<SteamID>.json`，仅包含素材名称、
  标题、缩略图和协议别名，不保存 SDK 对象或登录凭据。已有数据卷即可持久化，
  不需要修改 Docker Compose。
- 已有快照时立即返回。超过 10 分钟后在后台刷新，同一账号的并发请求共用刷新任务。
- 加载器通过 `SteamInventory.failedCategories?: Array<'emoticons' | 'stickers' | 'effects'>`
  标记失败类别。成功类别更新，失败类别保留此前的数组；失败类别传入的数组不可信，直接忽略。
  `complete: false` 仍表示整次刷新失败，不能接收其中任何类别的新数据。
- 加载器通过 `SteamInventory.partialCategories?: Array<'emoticons' | 'stickers' | 'effects'>`
  标记只能解析出部分素材的类别。对应数组必须是解析器已确认可用的素材子集，仍须通过素材字段校验；
  按 `name` 合并到旧列表，同名新素材覆盖旧素材，缺失的旧素材继续保留，不根据原始未知物品生成素材。
  同一类别不能同时标记为失败和部分成功；无效子集或元数据会拒绝整次刷新，保留原快照。
  未标记的完整成功类别仍整体替换，允许删除不再拥有的素材。
- 部分成功也通过临时文件和原子替换保存，持久化顶层 `failedCategories`。快照仍用
  `version: 1`，兼容没有失败元数据的旧版完整快照。失败和部分成功类别合并为 `failedCategories`，
  不持久化或向浏览器输出 `partialCategories`。成功确认的空数组可以替换对应旧列表。
- 部分失败时 `cache.stale` 始终为 `true`，`retryAt` 为 30 秒后；读取部分快照后即使
  未达到 10 分钟 TTL，也会按此冷却时间重试。重启从快照时间恢复冷却时间，完整成功后清除失败元数据。
- 无缓存的第一次加载最多等待 15 秒。有类别成功时返回并保存部分结果；没有旧数据的失败
  类别仍以数组 `[]` 保持接口兼容，必须结合 `cache.failedCategories` 判断其不可用，不能视为成功空库存。
  三个类别全部失败且没有旧快照时返回 503，不创建快照；如果类别都不完整但存在已确认可用的子集，
  仍返回并保存这些素材，不虚构未解析的物品。
- 整次加载拒绝、超时、`complete: false`、返回结构无效或写盘失败时保留原快照，30 秒后重试。
- 读取缓存仍检查账号和访问权限，等待后再次校验。离线可以读取有权限账号的快照，
  发送操作仍按实时登录状态和授权执行。

响应保持 `emoticons`、`stickers`、`effects` 三个数组，并增加 `cache`：

```json
{
  "updatedAt": 1800000000000,
  "refreshing": false,
  "stale": true,
  "retryAt": 1800000030000,
  "failedCategories": ["stickers", "effects"]
}
```

`updatedAt` 是最后一次接收并保存快照的时间，可能包含保留旧数组的失败类别；`retryAt`
是失败后的下一次允许刷新时间。`cache.failedCategories` 只在存在类别失败时返回，类别按
`emoticons`、`stickers`、`effects` 排序并去重。完整成功响应省略该字段。
目录缓存保留已验证的旧协议别名，但实际可用列表仍由当前账号拥有的物品决定。
已下架但仍被拥有的素材可以复用此前快照中明确记录的协议别名；新增其他应用的物品
或服务重启不会让它们阻断整份库存刷新。缺失物品描述的 SDK 响应属于贴纸和效果类别失败，
不能据此判定这两个类别的库存为空，也不能阻断成功的表情类别。

缓存诊断日志正文带固定阶段：`stage=load`、`fetch`、`validate`、`persist` 或 `partial`。
部分失败只记录经过校验的类别名称；其他失败只记录白名单 `error.code`，从不记录原始错误信息、
堆栈、响应或 Cookie。加载器抛出的错误可以使用 `EMOTICONS`、`COMMUNITY_INVENTORY`、
`STICKERS`、`EFFECTS`、`CATALOG` 标记来源。其余允许值为 `UNAVAILABLE`、`TIMEOUT`、
`STOPPED`、`INCOMPLETE`、`INVALID_MATERIAL`、`INVALID_SNAPSHOT`、`ALL_CATEGORIES_FAILED`、
`EACCES`、`ENOTDIR`、`ENOSPC`、`EROFS`；未知值统一为 `UNKNOWN`。

## 浏览器

浏览器将显示和发送所需的字段保存到 `localStorage['steam-chat.inventory.v1']`。
单份快照最多 2 MiB，按后台用户、会话版本、Steam 账号及访问修订隔离。页面刷新后
先恢复旧列表，再请求服务端；刷新期间和请求失败后，旧素材按钮继续可用。

面板打开时会根据服务端刷新状态重新取回新快照，并遵守失败重试时间。面板关闭后
不持续轮询。真实成功的空结果会清除旧列表；账号或授权失效会清除相应浏览器缓存，
晚到的旧请求不能覆盖当前账号的数据。浏览器禁用存储或配额不足时，网络请求与
内存中已有的素材仍然可用。

同一活动 Steam 账号断线重连、实时 Steam ID 暂时为空时，继续保留库存缓存。
消息回应面板也立即使用旧库存，并在后台新结果到达后更新已打开的列表，移除已经
不再拥有的素材；不要求关闭面板后重新打开。
