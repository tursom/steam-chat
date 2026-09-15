# 安装 Steam Chat 网页应用

通过 HTTPS 打开后台，在「设置 → 安装应用」中安装。支持的浏览器会出现安装按钮；如果没有直接安装提示，点击「查看安装方法」。安装后的应用以独立窗口打开，连接原有服务器，沿用该浏览器可用的登录状态；平台可能要求重新登录。

- Chrome / Edge：浏览器菜单中的「安装应用」，或网页设置页的安装按钮。
- iPhone / iPad：Safari 分享菜单 → 添加到主屏幕。
- Mac Safari：文件菜单 → 添加到程序坞。
- 不支持 PWA 安装的浏览器仍可正常使用网页版。

应用需要联网。Service Worker 只为主页导航的网络故障提供连接提示，不缓存聊天、图片、登录接口或应用脚本。网络恢复后点击「重新连接」。服务器更新后重新打开或刷新应用即可获取新网页资源；无需重新安装。

桌面通知仍在「设置 → 消息通知」单独授权。安装不等于开启后台推送，目前关闭应用后的消息推送不受支持。

构建会将 manifest、Service Worker 和 192/512px PNG 图标复制到 dist/web；服务器公开这些静态文件，并以 no-store 返回 manifest 和 Service Worker，便于更新。

验证：`npm test`；构建后运行 `node test/browser/pwa-install.cjs`（需 Playwright Chromium）。浏览器测试覆盖桌面/手机视口、真实静态路由、PNG 尺寸、Chrome 安装资格检查、模拟安装提示交互和真实 Service Worker 断网恢复。未自动操作操作系统安装对话框，Safari/iOS 安装步骤需在相应设备验证。
