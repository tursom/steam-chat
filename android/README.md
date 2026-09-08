# Steam Chat Android

原生 Android 客户端，使用 Kotlin、Jetpack Compose 和本地 SQLite 缓存。目标设备为荣耀 WIN RT（MagicOS 10 / Android 16），最低支持 Android 8。不是 WebView，也不包含原型中的模拟账户或通知。

## 首次使用

1. 后端先部署本次代码，并在 Web 后台完成管理员初始化、Steam 登录和用户授权。历史库会升级为 schema 2；先备份并预留磁盘空间，具体见 [同步与升级说明](../docs/android-durable-sync.md)。
2. 安装 APK，填写手机可访问的 HTTPS 后端地址，使用**后台用户账号**登录，不是在 App 中输入 Steam 密码。
3. 在 App 设置中允许系统通知，开启后台接收消息。
4. 在荣耀的应用启动管理中允许后台活动，并按需设置允许自启动、取消该 App 的电池优化、锁定最近任务。
5. 分别测试 Wi-Fi、移动数据、锁屏、网络切换以及后台运行。

后端可以部署在反向代理路径下，例如 `https://example.com/steam-chat/`，反代须同时正确转发 HTTP 和 WebSocket Upgrade。服务端 TLS 证书必须受 Android 信任；不支持明文 HTTP、跳过证书校验或向第三方域名转发登录 Cookie。

## 功能与边界

- 会话和好友列表、文字、图片选择与预览、图片放大、Steam 表情和贴纸。
- 签名 Cookie 登录；凭据以 Android Keystore 加密保存，不保存密码，登录过期需重新登录。
- WebSocket 实时提示结合持久化增量同步，断线重连后补拉；本地消息和游标在同一事务中保存。
- 前台服务常驻连接通知，以及按会话的新消息通知。通知内容预览默认关闭。
- 当前正在查看的会话不重复弹通知；首次同步旧历史不批量通知。
- 发送失败不自动重发可能已经送达的消息。手动重试前会提示可能重复发送。
- 首版每个会话展示最近 500 条本机同步记录。已同步消息与游标持久化；尚未确认的发送和图片附件只在当前进程内保留，进程被回收后不会自动重发。
- 群聊、手机端 Steam 登录/Guard、后台用户管理、厂商离线推送和云端跨设备已读同步不在首版范围。
- 图片上传有大小限制。复杂 Steam 富文本按支持的文本、链接、图片、表情和贴纸渲染，不执行 HTML。

**后台方案不是厂商推送通道。** App 通过 `remoteMessaging` 前台服务继续处理从 Steam 后端转发的跨设备消息，不依赖付费推送平台或 Google 服务。Android 与 MagicOS 仍可能限制后台执行；系统强行停止 App、断网或重启后未重新打开 App 时，不能保证收到通知。不会通过滥用闹钟、隐藏进程或启动另一个服务绕过系统限制。实际延迟、锁屏到达率和耗电需真机验收。

通知被用户或系统关闭时，前台服务仍可能运行，但普通新消息通知无法显示。通知类别的声音、锁屏显示和重要程度最终受系统设置控制。SDK 版本不能模拟荣耀厂商后台管理策略。

## 构建

需要 JDK 17、Android SDK Platform 36 和 Android Build Tools。Gradle Wrapper 已固定版本与分发包 SHA-256。

```sh
cd android
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

输出为 `app/build/outputs/apk/debug/app-debug.apk`。这是供个人测试安装的 debug 签名包。持续升级必须保留同一签名；正式长期使用应另行配置私有 release 签名，不能把签名密钥或密码提交到仓库。

磁盘较小时可把 Gradle 缓存和输出移到外部目录：

```sh
export GRADLE_USER_HOME=/tmp/steam-chat-gradle
export STEAM_CHAT_ANDROID_BUILD_DIR=/tmp/steam-chat-android-build
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

外部输出为 `$STEAM_CHAT_ANDROID_BUILD_DIR/app/outputs/apk/debug/app-debug.apk`。Robolectric 还会下载 Android 测试运行时，默认写入 `~/.m2`；已准备好这些 JAR 的机器可设置 `STEAM_CHAT_ROBOLECTRIC_JARS` 指向离线 JAR 目录，避免重复下载到根盘。

## 数据与安全

消息缓存存于应用私有目录，应用备份和设备迁移备份均关闭。缓存按后端、后台用户和 Steam 账户隔离；退出登录或失去授权后不展示旧账户数据。清除 App 数据或卸载会删除本机缓存和登录状态，服务器聊天记录不受影响。

本地 SQLite 消息不做数据库级加密，依赖 Android 应用沙箱与设备存储加密。Keystore 加密的是登录凭据，不应将其误认为整个聊天数据库已额外加密。受 Root 控制的设备不在本客户端的隔离保证范围内。

APK 不内置后端地址、访问密钥或测试密码。图片读取走同源媒体代理；网络请求不向外部链接泄露 Cookie。初次连接自己的服务前，请先确认域名与证书。

## 验收清单

- 两个 Steam 客户端互发文字、图片、表情和贴纸，网页和手机显示一致。
- 前台新消息可见；后台通知能进入对应联系人；当前会话不重复通知。
- 关闭正文预览后锁屏不显示聊天内容。
- 离线十分钟以上后恢复，消息补齐并正确标记未读，不因同步重复提醒。
- Wi-Fi 切移动数据后自动重连，重复断网不会重复发送已提交消息。
- 后台账号被禁用、改密、取消账户授权后，手机停止访问对应数据。
- 切换后台或 Steam 账户时，消息、草稿、媒体缓存和通知不串账户。
- 锁屏 5/30/120 分钟、系统休眠、重启、强行停止分别测试，并记录限制。

测试通过不等于已经验证荣耀真机的后台到达率。验收记录应区分 JVM 单元测试、后端集成测试、Android 模拟器和真机结果。

图标使用 Compose Material Icons；启动图标改编自 Lucide gamepad-2（ISC 许可）。项目整体许可见仓库根目录 LICENSE。
