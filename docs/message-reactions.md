# 私聊消息的表情回应

消息下方显示普通表情/贴纸回应和人数，自己的回应高亮。悬停显示回应者；好友名不可用时显示 SteamID。点击已有回应可添加或取消自己的回应，点击笑脸按钮可从已有普通表情和贴纸中选择。发送回应不会改动输入框草稿。

使用官方 FriendMessages.UpdateMessageReaction，定位字段是对方 SteamID、服务器秒时间和 ordinal；同秒的不同消息互不混淆。普通表情按官方规则发送 `:name:`，贴纸发送官方内部名。SDK 尚未封装 UpdateMessageReaction，本实现使用其随包提供的 protobuf schema 和 `_send` 传输，回归测试会解码实际请求字节验证格式。SDK 升级时须保留此验证。

只有 Steam 返回成功及 reactors 列表才更新 UI；超时或网络错误不自动重试。操作要求登录、Steam 在线和活动账号授权，异步完成后再次检查权限及账号。GET/POST `/api/message-reactions` 均返回 no-store。

回应数据从 Steam 读取，不作为新的聊天消息写入 JSONL/RocksDB，也不覆盖旧消息。当前会话加载历史后查询该页最新时间之前的最多 100 条 Steam 历史消息，随后每约 10 秒刷新一次，因此其他客户端的回应可能延迟约 10 秒显示。这不是关闭网页后的推送。

只有 Steam 历史查询能确认的消息才显示添加按钮：Steam 已不再保留的旧消息、仅本地存在的未确认消息和社区群组暂不支持。未知/未返回的消息不伪装成“没有回应”。断线时保留最后一次确认的数据，切换账号后清空缓存。

验证：`npm test`；构建后 `node test/browser/message-reactions.cjs`（Playwright Chromium）。覆盖真实 SDK 请求编解码、计数/成员转换、取消最后一个回应、失败不重试、权限/账号/离线保护以及桌面手机交互。没有向真实好友发送回应测试。
