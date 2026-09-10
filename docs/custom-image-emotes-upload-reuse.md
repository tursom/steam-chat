# 自定义图片表情：重复发送的上传复用调查

## 结论

自定义图片入库一次、随后浏览器只发送素材 ID 是确定可实现的优化。完全免除服务器到 Steam 的重复图片上传，目前仍需真实协议实验确认，不能以 CDN 地址可访问或网页能够渲染为成功依据。

## 已确认的协议

现有 `steamcommunity.sendImageToUser` 以及官方网页客户端采用三步流程：

1. `POST https://steamcommunity.com/chat/beginfileupload/`：提交文件名、大小、SHA-1、MIME 类型、尺寸和 sessionid，返回上传地址、请求头、ugcid、timestamp、hmac。
2. `PUT` 图片字节到返回的上传地址。
3. `POST https://steamcommunity.com/chat/commitfileupload/`：提交上述文件元数据、ugcid、timestamp、hmac、success=1，以及 friend_steamid、spoiler，完成发送。

收件人由第三步指定。读取的官方实现和 SDK 都无条件执行 PUT；没有发现“相同哈希直接跳过上传”的分支。存在 file_sha 不能证明服务端提供可供客户端使用的去重协议。

FriendMessages.SendMessage 的公开协议定义有 message、contains_bbcode 等字段，没有直接传 ugcid 的字段。图片 BBCode 是接收/展示格式，不能据此断言它可直接作为发送请求。

## 值得实验的复用路径

### 复用首次上传的 commit 参数

保存首次成功上传的文件元数据、ugcid、timestamp、hmac，再次只调用 commitfileupload。若成功且官方客户端收到新的原生图片消息，可免除重复图片字节传输。

未确认：提交凭据是否一次性、有效期、是否绑定原会话、能否跨收件人使用、重启及重新登录后是否有效。素材应按 Steam 账号隔离；提交凭据不得发往浏览器、公开日志或聊天历史。

### 相同 SHA-1 再次 begin

对同一图片重新 begin，比较返回 ugcid 和上传协议。只有响应明确允许复用，或受控实验确认跳过 PUT 后新提交仍有效，才能实现免传；不能盲目省略 PUT。

## 最小实验与验收

先获得指定测试收件人的授权；不对现有好友自动试发。

1. 正常上传小测试图片并发送一次；保留参数于测试进程内，记录上传字节数及规范化回显。
2. 向同一测试收件人重复 commit，观察是否产生新时间戳/ordinal 的消息，还是失败或只返回幂等成功。
3. 核对官方客户端实际收到并能打开原图，不能只看 HTTP 200 或本地气泡。
4. 若成功，继续测试延时、服务重启、重新登录；跨收件人测试另需对应授权。
5. 如复用返回超时/连接中断，不自动补发完整上传，防止重复消息；结果未确认时保持未知状态。
6. 只有明确表示未发送的失效响应才可考虑刷新凭据或重新上传。

## 素材库建议

- 原图按 SHA-256 去重、缓存缩略图和图片尺寸；同一素材重复添加不重复存储。
- 浏览器请求只传素材 ID、目标会话及账号前置条件，不再次传 Base64。
- 服务器持有原始字节和单独的 Steam 上传凭据；凭据按账号和素材隔离。
- 若实验确认复用可行，支持“首次上传 / 复用发送 / 凭据失效”的状态。
- 若实验失败，仍可省去浏览器上传和重复下载；压缩素材可以减少 Steam 上传流量，但原生图片仍需要上传。
- CDN 链接属于另一种消息语义，不应静默替换用户选择的原生图片发送。

## 来源

- 当前安装的 SDK：`node_modules/steamcommunity/components/users.js`，`sendImageToUser`。
- 官方前端代码的 SteamTracking 镜像： https://github.com/SteamDatabase/SteamTracking/blob/master/steamcommunity.com/public/javascript/webui/friends.js ，`BeginFileUpload`、`DoFileUpload`、`CommitFileUpload`、`PopulateCommitFileUploadFormData`。
- Steam 消息协议镜像： https://github.com/SteamDatabase/Protobufs/blob/master/webui/service_friendmessages.proto 。

## 线上受控实验（2026-09-10）

用户明确授权向指定好友「はく」发送两次测试图片。通过现有线上登录会话执行，不新建 Steam 登录，不更换镜像或重启服务。历史记录和实时好友资料匹配到唯一收件人后才开始。

同一张 256×128 PNG（626 字节）执行了两次发送尝试：

| 尝试 | 请求 | 图片上传字节 | 结果 |
| --- | --- | ---: | --- |
| 第一次 | begin → PUT → commit | 626 | 成功，有原生图片回显 |
| 第二次 | 复用首次 commit 的文件元数据、ugcid、timestamp、hmac 和收件人 | 0 | HTTP 500，Steam success=9（FileNotFound），无第二条回显 |

第二次在首次确认约 1.5 秒后发起，没有重做 begin，也没有重新上传。读取 Steam 端最近历史确认仅有一条匹配测试尺寸的原生图片，时间 2026-09-10T07:14:46Z、ordinal=0。该结果证明本次原样重放 commit 参数失败，不能推出所有可能的文件复用方式都不支持，也不能仅凭 FileNotFound 确认是凭据过期或一次性消费。

没有自动补发或进行第三次发送。临时调试接口已关闭，实验状态及提交参数已清理，服务仍 online、error=null。用户实际应收到一张测试图，而非两张。

## 第二轮线上实验：重新 begin、跳过 PUT（2026-09-10）

用户再次授权向同一测试好友做一次尝试。使用与第一轮完全相同的 PNG，SHA-256 为 `2aec3e5c4207ff6ecb6c8afcfe770cf73a3fe2d346f816230f8e87e69bb3417a`，大小 626 字节。

实际执行：重新 begin，拦截并跳过 PUT，然后使用这次 begin 返回的新参数 commit。仅一次发送尝试，无自动重试。

- commit 返回成功；Steam 回显及服务端历史产生新原生图片消息，时间 `2026-09-10T07:22:57Z`、ordinal=0。
- 图片上传字节数为 0。
- **但是新消息的原图和缩略图均返回 HTTP 404。** 新旧资源路径不同。
- 第一轮正常上传的原图及缩略图仍返回 HTTP 200，原图大小 626 字节、SHA-256 与测试文件一致。

结论：本次同哈希重新 begin 没有提供可直接使用的已存储图片。跳过 PUT 虽能提交图片消息，但得到的是缺失资源的图片消息，不能用于素材库。HTTP 提交成功、出现原生图片标签与回显都不足以验证免上传成功，必须额外验证文件可读取及字节哈希。

没有再发送第三张或自动补发；接收方可能看见一条加载失败的图片消息。临时调试接口和实验状态已清理，服务仍 online。实际 SDK/服务端接口没有改动。

两轮实验否定了“原样重复 commit”和“新 begin 后直接跳过 PUT”这两种朴素方案；不代表所有潜在文件复用接口都不存在。在找到并验证其他协议前，可上线的确定性优化仅是素材入库一次、浏览器按 ID 发送以及缓存/尺寸优化，不能省略原生图片的 Steam PUT。

