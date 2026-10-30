# Steam 网页扫码登录

管理员登录后台后，可在“Steam 连接”或“Steam 账户”页面点击“扫码登录 Steam”。打开手机 Steam App，进入 Steam 令牌页面，扫描网页上的二维码并确认登录。网页会显示“等待扫码”“已扫码待确认”和最终连接状态。

二维码从开始生成起有效 120 秒。过期或失败后可点击“重新生成二维码”，也可随时取消等待中的扫码。二维码等待期间，密码登录和账户连接按钮会暂时禁用，避免同时发起多个登录。页面每 5 秒查询扫码状态，期间保留密码表单中的输入。

服务同一时间连接一个 Steam 账户。当前账户在线时，先退出当前账户，再扫码登录其他账户。二维码入口保留原有账号密码和 Steam Guard 登录方式。扫码使用后台固定的 Logon ID；账户显示名称可在登录后的账户列表中编辑。

手机确认后，服务端使用 SteamClient 类型的 refresh token 连接 Steam 聊天服务，将凭据保存到现有 token 文件和 Steam 账户存储中，供自动重连及重启后恢复使用。恢复登录由 token 决定账户身份，避免旧配置中的 SteamID 与新扫码账户冲突。

`POST /api/steam/login/qr` 开始扫码，`DELETE /api/steam/login/qr` 取消扫码，均要求 `steam.manage` 权限。`GET /api/steam/status` 中的 `qrLogin` 包含二维码 PNG data URL、扫码状态和过期时间，仅对具有管理权限的已登录用户提供；refresh token 不会发送到浏览器。二维码状态响应禁止缓存。取消、超时和停止服务后，旧会话的异步返回不会触发登录或覆盖新的凭据。

验证覆盖 `test/steam-qr-login.test.ts`、`test/steam-qr-api.test.ts` 和 `test/web-steam-qr.test.ts`。自动化测试模拟手机确认及 Steam 客户端事件；真实 Steam 网络检查验证取得扫码链接并生成 PNG。完整的真实账号扫码确认仍需通过手机 Steam App 验证。
