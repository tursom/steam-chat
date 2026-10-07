# 收到的 Steam 视频

Web 聊天可显示 Steam 的 MP4 视频消息，例如：

```text
[video src=https://cdn.steamusercontent.com/ugc/123/0123456789ABCDEF0123456789ABCDEF01234567/ type=video/mp4 steamvideo=true][url=https://cdn.steamusercontent.com/ugc/123/0123456789ABCDEF0123456789ABCDEF01234567/]https://cdn.steamusercontent.com/ugc/123/0123456789ABCDEF0123456789ABCDEF01234567/[/url][/video]
```

点击「播放视频」后才加载本地 ArtPlayer 5.4.0 并创建播放器，使用中文控制栏、B 站式粉色进度条及底部悬浮控制。支持暂停、音量、进度和倍速，手机支持内嵌播放。原视频链接始终保留；媒体过期、网络失败、浏览器无法解码或播放器资源加载失败时显示错误提示，可打开原链接。

右下角分别提供「网页全屏」和「全屏」：网页全屏铺满浏览器内容区，可再次点击按钮或按 Escape 退出；系统全屏使用浏览器 Fullscreen API，实际支持情况取决于浏览器。网页全屏不移动播放器 DOM，退出后恢复聊天阅读位置。切换会话、退出账号或移除消息时会销毁播放器、退出网页全屏并清理监听器。聊天输入框聚焦时，空格和方向键保持正常输入行为。

解析接受引号或无引号属性，仅加载 HTTPS 的 cdn.steamusercontent.com 或 images.steamusercontent.com 的 UGC 资源。正文可为裸 URL，或 Steam 的完整 `[url=URL]URL[/url]` 包装；链接目标和显示 URL 均须与 src 一致。类型须为 video/mp4，steamvideo 须为 true；不支持或错误的标签保留原文。网页渲染不修改历史记录。

浏览器直接读取 Steam CDN 视频，保留其 Range 支持。视频不经过图片代理，不在服务端下载或缓存；聊天历史加载时没有视频资源请求。发送消息及其结果更新使用现有增量渲染，不移除播放器节点，保留播放进度。切换会话或刷新页面会结束当前播放。

这是收到的视频消息的网页播放支持，视频上传未接入。

ArtPlayer 以精确版本加入 npm 依赖。构建复制自包含的模块到 `/vendor/artplayer-5.4.0.mjs`，同时提供 `/vendor/artplayer-LICENSE.txt`；播放不依赖第三方脚本 CDN。播放器自身的自动重新加载已关闭，避免播放错误反复重试。

验证：`npm test` 包含格式/来源校验及真实后端静态模块路由验证。构建后运行 `node test/browser/steam-video.cjs`，需要 Playwright Chromium 和支持 libx264 的 ffmpeg；测试生成临时视频，覆盖桌面及移动触控模式、延迟加载、真实 MP4 解码、倍速、网页/系统全屏、Escape、退出后尺寸及滚动恢复、发送时保持播放、实例销毁和加载失败回退，结束后删除临时文件。不向 Steam 好友发送测试消息。
