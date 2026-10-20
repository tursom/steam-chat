# Steam 图片发送错误

`A server error occurred. (16)` 中的 16 对应 Steam `EResult.Timeout`。它不是网页解析错误，也不能单独证明图片是否已经发出。已安装的 SteamCommunity SDK 在准备上传、PUT 上传和提交阶段都可能返回超时；Steam 的 HTML 错误页还可能只保留这句文字，丢失结构化的 `eresult`。

## 阶段与恢复

发送复用 SDK 原有的 `beginfileupload → PUT → commitfileupload` 流程。每个 SDK 调用有独立接收对象，记录进入的阶段，并将 HTTP 调用委托给原实例。共享的 Cookie、请求计数、会话事件和 HTTP 方法保持原状；并发上传不会覆盖彼此的阶段。进入 commit 后，该次尝试一直按可能已提交处理。

| 阶段 | 失败的含义 | 自动处理 |
| --- | --- | --- |
| prepare | SDK 尚未发起上传请求，例如图片解析失败 | 不重试，显示发送失败 |
| begin / upload | SDK 尚未调用 commit，因此没有通过该次尝试发出聊天消息 | 每轮临时错误最多重试两次，分别等待 1 秒、2 秒；每次重新检查权限、账号和在线状态 |
| commit | Steam 可能已经提交图片，但确认响应没有成功返回 | 不重发，保留结果未确认 |
| unknown | 自定义发送器没有可验证的 SDK 阶段 | 超时不重试，保留结果未确认 |

临时错误包括 Steam Timeout、服务暂不可用及部分网络错误；明确的其他错误直接返回。已知提交阶段的登录错误也不触发整个上传重放。准备上传阶段的网页登录过期仍复用原有共享会话刷新。

错误接口返回 `imageUploadPhase` 和布尔 `uncertain`。网页保留这一标志：明确尚未发送的错误显示失败，可能已经提交的错误显示未知。浏览器网络自身中断仍显示未知，不自动重发。失败不会归档为发送成功，图片回显与成功回调继续通过现有机制去重。

## 诊断

服务端输出 `Steam image upload failed`，消息本身包含 JSON 格式的 `phase`、`eresult`、枚举名称、传输错误码、HTTP 状态、尝试次数、耗时、`uncertain` 及是否继续重试。当前生产日志格式不显示独立 metadata，因此这些有限字段同时放入日志消息。没有 Cookie、sessionid、HMAC、上传 URL、请求体、图片内容或收件人信息。

旧版没有记录图片请求的失败阶段，不能根据事后的在线状态或单条 `(16)` 截图恢复该次发送的确定结果；这类已有未知提示仍需检查实际聊天记录。

`test/image-upload.test.ts` 使用已安装的 SDK，只替换最低层的网络传输。覆盖与截图一致的 Steam HTML/JSON 错误、提交前退避、提交后不重发、权限复查、并发隔离、日志过滤、HTTP 确定性和失败不归档。`test/browser/outgoing-messages.cjs` 在桌面与手机视口验证图片发送失败/未知状态及客户端不重试。
