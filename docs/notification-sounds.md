# 消息提示音

设置 → 消息通知中可开关提示音、选择音效及试听。默认启用 Steam 私聊提示音，独立于桌面通知权限。当前正在阅读的会话不响铃；自己的回显、历史加载和重复事件不响铃，连续消息最多每 1.5 秒一次。选择和开关保存在当前浏览器。

浏览器自动播放策略可能要求先点击「试听提示音」，网站或系统静音也会影响播放。此功能需要页面保持打开，不提供关闭后的推送。

音频来自 Steam 官方客户端网页使用的公开资源，原文件未重新编码。版权归 Valve / 相应权利人所有。

- steam-message.m4a（默认）：https://community.cloudflare.steamstatic.com/public/sounds/webui/ui_steam_message_old_smooth.m4a
- steam-room.m4a：https://community.cloudflare.steamstatic.com/public/sounds/webui/steam_chatroom_notification.m4a
- steam-mention.m4a：https://community.cloudflare.steamstatic.com/public/sounds/webui/steam_at_mention.m4a

默认选择依据 Steam 官方 friends.js 的私聊消息声音调用。静态资源随构建部署，播放不依赖 Steam CDN 的即时可用性。
