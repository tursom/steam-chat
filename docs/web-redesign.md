# Web 前端重设计（方向 C · 极简聚焦）

## 背景与范围

这是 Web 前端（`web/app.ts`、`web/style.css`、`web/index.html`）的布局、交互和视觉重做规格。之前做过 A / B / C 三个方向的原型，最终选定 **C**。

- **原型**：`web/redesign-prototype/`。它是本文的视觉基准；本文写不清的地方，以原型的实际表现为准。
  - 预览方法见该目录下的 `NOTES.md`。
  - 原型是纯 JS + 字符串模板，没有任何后端通信。**不要**把原型代码搬进生产，只参考结构、样式和交互。
- **授权**：界面依赖 `docs/authorization-v2.md` 定义的权限点、角色、分级授权和接口。后端先落地，前端再接入（见文末「落地顺序」）。
- **不变**：
  - 技术栈保持原样：原生 TypeScript + DOM、无框架、`scripts/build-web.cjs` 构建。
  - 不引入新的运行时依赖。图标继续用现有的 `chatIcon()`（Lucide），缺的图标按现有方式补。

### 必须保留的现有行为

重做的是外观和信息架构，下列逻辑**原样保留**，只改它们渲染到哪里：

- 发送链路：
  - 文字发送、`send-operations` 图片发送（含上传进度、轮询、重试、取消、`restoreImageOperations`）；
  - 发出消息的状态机（`beginOutgoing` / `finishOutgoing` / `outgoingFailure`）。
- 同步与缓存：
  - durable sync（`requestDurableSync` 等）；
  - IndexedDB 聊天缓存（`openChatCache` 等）；
  - WS 重连和休眠恢复（`setupRealtimeResume`）。
- 消息渲染：
  - BBCode、OpenGraph、Steam 图片和视频（ArtPlayer）、Bilibili、网易云；
  - 贴纸、聊天效果；
  - 表情回应（`renderReactionBar`）。
- 历史：分页加载、按日期跳转、离开最新位置后的状态。
- 应用能力：
  - 桌面通知和提示音；
  - PWA 安装和 Service Worker；
  - 粘贴或拖入图片。
- 会话操作：关闭会话（`steam-chat.closed-*` 本地记录）和折叠会话列表。
- Steam 登录：扫码登录、密码登录、Steam Guard 的整个流程。

## 设计原则

1. **聊天优先**。登录后直接进入聊天，没有常驻导航栏。所有管理和设置都收进「控制台」浮层，按 Esc 返回聊天。
2. **单色 + 一个强调色**。界面基本是黑白灰，紫色只用于主按钮、焦点、选中和「完整」以外的授权提示。
3. **平铺消息**。消息不用气泡，按发送人分组，排在居中的 720px 栏里。
4. **只在有问题时提示**。存储、连接、权限的状态平时不占空间，异常时才在合适的位置出现。
5. **权限可见**。用户能看到自己为什么不能做某件事：按钮禁用并在 `title` 说明原因，必要时显示一行说明。不要静默隐藏关键入口。

## 设计令牌

全部定义在 `:root`，不要在组件里写死颜色。值见 `web/redesign-prototype/style.css` 顶部，可直接复制。

- 主题：
  - 浅色定义在 `:root, :root[data-theme="light"]`，深色定义在 `:root[data-theme="dark"]`。
  - 跟随系统时，用 `@media (prefers-color-scheme: dark)` 包住 `:root:not([data-theme="light"])`，把深色值再声明一次（原型用的是手动切换，生产要两者都支持）。
  - 主题设置保存在 `localStorage`（键名 `steam-chat.theme`，取值 `auto` / `light` / `dark`），入口在头像菜单里。
- 颜色令牌：
  - 背景与面板：`--bg`、`--panel`、`--panel-2`、`--side`、`--sunken`；
  - 线条：`--line`、`--line-2`；
  - 文字：`--text`、`--text-2`、`--text-3`；
  - 强调色：`--accent`、`--accent-ink`、`--accent-soft`、`--accent-text`；
  - 交互态：`--hover`、`--selected`；
  - 状态色：`--ok`、`--warn`、`--danger`，以及对应的 `*-soft`；
  - 好友在线状态：`--game`、`--online`、`--away`、`--offline`。
- 头像：
  - 背景和文字色由 `--h`（色相，按 SteamID 或用户名哈希得到 0–359）配合 `--av-s`、`--av-l`、`--av-ts`、`--av-tl` 计算。
  - 有真实头像图片时直接显示图片。
- 圆角：`--radius: 10px`、`--radius-sm: 7px`、`--radius-xs: 5px`。
- 字体：
  - 正文用系统字体栈，14px / 1.5；
  - SteamID、权限点、IP 用 `--mono`。

## 布局与断点

断点用**容器查询**，对 `#app` 声明 `container: app / inline-size`，不用媒体查询。这样 PWA 窄窗口、分屏和原型的手机框表现一致。

| 宽度 | 布局 |
| --- | --- |
| > 1100px | 会话列表 330px + 会话区；控制台浮层四周留 28px / 40px |
| ≤ 1100px | 控制台里的「列表 + 详情」左栏缩到 240px；权限行里不再显示权限来源文字 |
| ≤ 960px | 会话列表 290px；控制台浮层贴边 12px，导航栏 190px；权限行换行；隐藏 `.hide-sm` 列 |
| ≤ 720px | 单栏：会话列表和会话区二选一（`data-mobile="list\|thread"`）；控制台全屏，导航变成横向标签；「列表 + 详情」也变成二选一 |

不能出现横向滚动。安全区：全屏浮层和输入区底部要加 `env(safe-area-inset-bottom)`。

## 页面结构

```text
#app
├─ .shell[data-mobile]
│  ├─ aside.clist                  会话列表
│  │  ├─ .ctop                     头像菜单 · 搜索（Ctrl K）· 新建会话
│  │  ├─ .conv-tabs                全部 / 未读 / 好友 / 群组
│  │  ├─ .scope-note               （授权受限时）当前授权说明
│  │  ├─ .conv-list                会话
│  │  └─ .cstatus                  Steam 状态 · 当前账户 · 控制台 ›
│  └─ main.cthread                 会话区
│     ├─ .thread-head              名字（点开资料卡）· 日期跳转
│     ├─ .banner-warn              （异常时）存储告警
│     ├─ #messages                 消息
│     ├─ .detached                 （查看历史时）回到最新
│     ├─ footer.composer           输入区
│     └─ .drop-overlay             （拖入文件时）
├─ .sheet-scrim + .sheet           控制台浮层（左导航 + 页面）
├─ .modal-scrim + .modal           弹窗
├─ .palette                        快速跳转
└─ .lightbox                       看大图
```

### 与现有代码的对应

| 现有 | 新 |
| --- | --- |
| `renderShell` + `navButton` + `panel` | 新的 `renderShell`：只渲染 `.shell`；`renderConsole(page)` 渲染浮层；`renderModal`、`renderPalette` 单独渲染 |
| `renderLogin` / `renderSetup` / `authPage` | 合并成一个居中卡片，见「登录与初始化」 |
| `renderChatView`、`renderChatListSections`、`renderListItem`、`updateChatTabs` | `.clist`：4 个标签替代现有分区 |
| `renderThreadHeader`、`renderFriendDetails`、`setFriendDetailsOpen` | `.thread-head` + 资料卡浮层（不再是右侧栏） |
| `renderHistoryTools`、`updateHistoryControls` | 日期标签 + 弹层；「加载更早」改为滚动到顶自动加载；`.detached` 浮动条 |
| `storageHealthText` / `updateStorageHealth` | 只在异常时显示 `.banner-warn`；详细状态在「设置 → 消息存储」 |
| `renderComposer`、`renderImageDrafts`、`renderImageTransfers`、`renderPicker` | `footer.composer` |
| `renderMessage`、`markMessageRuns`、`renderReactionBar` | 平铺 `.msg`（结构见下） |
| `openContextMenu` | `.ctx-menu`（位置跟随鼠标，贴边时翻转） |
| `renderSteamView` + `renderSteamAccountsView` + `renderSteamAccountTable` | 控制台「Steam 账户」一页 |
| `renderUsersView` / `renderUserTable` / `renderUserDetail` | 控制台「用户」：列表 + 详情（4 个标签） |
| —（新） | 控制台「角色与权限」 |
| `renderAuditView` / `renderAuditTable` | 控制台「审计日志」 |
| `renderImageEmotesView` / `renderImageEmoteManager` | 控制台「图片表情」 |
| `renderSettingsView` + `appInstallationPanel` | 控制台「设置」 |
| `hasPermission`、5 处 `role === 'admin'` | 全部改用 `hasPermission(perm)` 和 `steamGrant` |

`View` 类型改为 `'chat' | 'accounts' | 'users' | 'roles' | 'audit' | 'emotes' | 'settings'`：

- `chat` 表示没有打开控制台，其他值表示打开控制台的对应页。
- `normalizeView` 把旧值映射过来：`steam` / `steamAccounts` → `accounts`，`account` → `settings`，`imageEmotes` → `emotes`。这样 `localStorage['steam-chat.view']` 里存的旧值仍然有效。
- 没有权限的页面一律回落到 `chat`。

### 保留的元素 ID

现有测试（`test/web-*.test.ts`、`test/browser/*.cjs`）依赖这些 ID。新结构里**保留同名 ID**，挂到对应的新元素上，以减少测试改动：

| ID | 新位置 |
| --- | --- |
| `#app` | 根节点 |
| `#chatLayout` | `.shell` |
| `#chatListSections` | `.conv-list` |
| `#chatListToggle` | `.thread-head` 左侧的折叠按钮（宽屏时显示） |
| `#threadHead` | `.thread-head` |
| `#messages` | 消息滚动容器 |
| `#historyOlder` | 隐藏的「加载更早」按钮：滚动到顶部时自动触发，键盘用户也能聚焦 |
| `#historyDate` | 日期弹层里的 `input[type=datetime-local]` |
| `#historyJump` | 日期弹层里的「跳转」按钮 |
| `#historyLatest` | `.detached` 里的「回到最新」按钮 |
| `#storageHealth` | `.banner-warn`（正常时 `hidden`） |
| `#offlineNote` | `.composer-note` |
| `#messageInput` | 输入框 |
| `#sendButton` | 发送按钮 |
| `#pickerToggle` | 表情按钮 |
| `#picker` | 表情弹层 |
| `#imageDrafts` | `.image-drafts` |
| `#imageTransfers` | `.transfers` |
| `#lightbox` / `#lightboxImage` / `#lightboxClose` | 看大图 |
| `#steamQrLogin` | 「添加账户」弹窗的扫码标签 |
| `#steamAccountTable` | 「Steam 账户」页的账户列表 |
| `#imageEmoteManager` | 「图片表情」页 |
| `#installApp` | 「设置 → 安装应用」按钮 |

class 名可以按新设计改，测试里用到的 class（`.list-item`、`.msg-row`、`.message-content`、`.reaction-chip` 等）要同步修改测试。

## 会话列表

- **头像按钮**（`.me-btn`）：打开菜单，菜单项如下：
  - 头部：显示名、@用户名、角色；
  - Steam 账户切换：需要 `steam.manage`，列出启用的账户；
  - 主题：跟随系统 / 浅色 / 深色；
  - 控制台；
  - 退出登录。
- **搜索**（`.jump`）：点击或按 Ctrl/⌘ K 打开快速跳转，见「快速跳转」。
- **新建会话**：输入 SteamID64 或从好友里选。授权 `scope = some` 时隐藏这个按钮。
- **标签**：
  - 全部 / 未读 / 好友 / 群组；
  - 范围受限时不显示「群组」；
  - 当前标签记在 `localStorage['steam-chat.list-tab']`。
- **授权说明**（`.scope-note`）：只在当前用户对活动账户的授权低于「完整」或范围为「指定好友」时显示。示例：「主号 · Dove：聊天 · 仅 3 位指定好友 · 至 2026-12-31」。
- **会话项**：
  - 头像（带在线状态点）；
  - 名字、时间；
  - 一行预览：图片显示「[图片]」，贴纸显示「[贴纸]」；
  - 未读数。

  选中项背景为 `--selected`。
- **右键或长按**：上下文菜单，菜单项为「打开会话」「标为已读」（有未读时）、「关闭会话」。
  - 长按 500ms 触发；
  - 菜单贴边时向内翻转。
- **底部状态**（`.cstatus`）：Steam 连接状态点 + 当前账户名 + 「控制台 ›」。整行可点，打开控制台。
  - 有 `steam.manage` 时进「Steam 账户」页；
  - 否则进「设置」页。
- **折叠**：宽屏下可以把列表折叠成 64px 的头像栏（保留现有功能和 `steam-chat.list-collapsed`）。
  - 折叠后名字显示在 `title` 里；
  - 切换按钮是 `.thread-head` 左侧的 `#chatListToggle`。
- **空状态**：
  - 没有会话：「还没有会话」+ 新建会话按钮（有权限时）；
  - 没有授权：见「权限状态」。

## 会话区

### 头部

- 左侧是名字和状态（正在玩 xxx / 在线 / 离开 / 离线），整块是一个按钮，点击打开**资料卡浮层**（`.profile-pop`）。资料卡内容：
  - 大头像、名字、状态、Steam 主页链接；
  - 正在玩的游戏卡片（封面、游戏名、富状态、商店链接）；
  - 资料表：SteamID（可复制）、关系、备注、当前账户、「我的授权」。

  资料卡替代现有的右侧资料栏。按 Esc 或点击外部关闭；关闭后焦点回到名字按钮。
- 右侧是**日期标签**（`.date-chip`），内容为「今天」/「昨天」/「10 月 26 日」，显示当前视口顶部消息的日期。点击打开日期弹层：
  - 快捷项：昨天 / 上周一 / 一个月前；
  - `datetime-local` 输入框和「跳转」按钮；
  - 一行说明。
- ≤ 720px 时左侧加返回按钮，回到会话列表。

### 消息

单条消息的结构：

```html
<article class="msg [is-cont] [is-self]" data-state="sending|failed|unknown|retry_wait">
  <span class="msg-av">头像（续行时为空）</span>
  <div class="msg-main">
    <header class="msg-head"><strong>名字</strong><span class="me-tag">我</span><time>14:20</time></header>
    <div class="msg-body">正文 / 图片 / OG 卡片 / 贴纸 / 效果</div>
    <div class="msg-foot">表情回应 · 发送状态</div>
  </div>
  <div class="msg-tools">添加回应 · 复制</div>
</article>
```

- 同一发送人、5 分钟内的连续消息合并为续行（`is-cont`），不重复头像和名字。有发送状态的消息不合并。
- 自己发的消息不改颜色、不靠右，只在名字后加「我」标签。
- 日期分隔用粗体文字（「今天」「10 月 26 日」），不画线。
- 图片最大宽 320px（≤ 720px 时 240px），圆角 12px，点击看大图。
- 悬停或聚焦消息时，右上角浮出工具条（添加回应、复制）。触屏上长按消息打开同样的操作。
- 滚动到顶部自动加载更早的消息，加载时顶部显示一行「向上滚动自动加载更早的消息」或加载指示。保留现有的滚动锚定逻辑。

### 发送状态

| 状态 | 图标 | 文案 | 操作 |
| --- | --- | --- | --- |
| `sending` | clock | 发送中 | — |
| `failed` | circle-alert（`--danger`） | 发送失败 | 重试 |
| `unknown` | circle-help（`--warn`） | 结果未确认，请先检查聊天记录 | — |
| `retry_wait` | refresh-cw（`--warn`） | 图片上传超时 · 12 秒后重试 · 第 2/5 次 | 立即重试 · 停止 |

文案来自现有的 `imageOperationLabel` 和发送状态机。没有「聊天」以上授权时不显示重试类按钮。

### 查看历史

- 跳转到某个日期后进入「查看历史」状态，底部浮出 `.detached`：「正在查看 10 月 26 日的历史」+「回到最新 ↓」。
- 在这个状态下收到新消息，不自动滚动，只更新浮动条里的未读计数。

### 存储告警

`storageHealthy()` 为 false 时，在头部下方显示 `.banner-warn`，例如「历史索引正在同步（32 条待处理），新消息仍会实时显示。」，右侧「详情」按钮打开「设置 → 消息存储」。正常时完全不显示。

### 输入区

- 结构：
  - `.composer-note`（需要时显示）；
  - `.transfers`（上传中的图片，带进度条和取消）；
  - `.composer-box`，里面是 `.image-drafts`（待发送图片缩略图，可移除）和一行 `.composer-row`（表情 · 图片 · 输入框 · 发送）；
  - `.composer-hint`（需要时显示）。

  整体最大宽 704px，居中。
- 快捷键：
  - Enter 发送，Shift+Enter 换行；
  - 输入法组合中（`isComposing`）不发送。
- 输入框随内容增高，最高 160px。
- 可以粘贴图片和拖入图片：
  - 拖入时整个会话区显示 `.drop-overlay`：「释放发送图片 · 发送给 xxx」；
  - 没有「完整」授权时不显示这个覆盖层，也不接受拖放。
- 表情弹层的标签：表情 / 贴纸 / 效果 / 自定义。
  - 「表情」包含 Steam 表情和 Unicode 表情，「聊天」授权可用。
  - 其余三个需要「完整」授权，否则显示锁定说明。
- 输入区说明（`.composer-note`）的优先级从高到低：
  1. 只读授权：不渲染输入框，只显示一行灰色说明「你在『主号 · Dove』上的授权为只读：可以浏览会话和历史，不能发送消息。」
  2. 群组：「这是 Steam 社区群组，尚未接入群聊频道。」，输入框禁用。
  3. Steam 离线：「Steam 未在线，暂时不能发送。草稿会保留，连接恢复后可继续。」，输入框禁用，草稿保留。
- 「聊天」授权时，在输入框下方显示一行提示：「聊天授权：可发送文字与 Steam 表情；图片、贴纸、效果和回应需要『完整』授权。」图片按钮禁用，`title` 说明原因。

### 空状态

- 没选会话：图标 + 「选择一个会话」+ 一行说明。
- 没有 Steam 授权：「此账号尚无聊天访问权限，请联系管理员分配 Steam 授权。」，会话列表也显示同样的说明。

## 快速跳转（Ctrl/⌘ K）

居中浮层：顶部输入框，下面是分组结果。

- **会话**：按名字、备注、SteamID 匹配，最多 8 条。
- **页面**：控制台里当前用户有权限的页面。
- **命令**：新建会话、切换主题、退出登录等，按权限过滤。

键盘：

- ↑ / ↓ 选择，Enter 执行，Esc 关闭；
- 默认选中第一项；
- 输入框始终保持焦点。

## 控制台浮层

- 打开方式：
  - 会话列表底部的「控制台 ›」；
  - 头像菜单；
  - 快速跳转。
- 外观：
  - 桌面上是一张大卡片，四周留白，背后是半透明遮罩，能隐约看到聊天；
  - ≤ 720px 时全屏，导航变成横向可滚动的标签（`.sheet-links`）。
- 左侧导航：Steam 账户 · 用户 · 角色与权限 · 审计日志 · 图片表情 · 设置。没有权限的项不显示：

  | 页面 | 显示条件 |
  | --- | --- |
  | Steam 账户 | `steam.manage` 或 `steam.account.manage` 或 `steam.grant.manage` |
  | 用户 | `user.view` |
  | 角色与权限 | `role.manage` 或 `user.view` |
  | 审计日志 | `audit.view` |
  | 图片表情 | `emote.manage` |
  | 设置 | 所有人 |
- 关闭：Esc、点遮罩、点右上角关闭按钮。关闭后焦点回到打开它的元素。
  - 有未保存的更改时，先弹确认框「放弃未保存的更改？」。
- 页面头部：标题 + 一行说明；主操作放在右侧，例如「新增用户」。

### 未保存的更改

「用户 → 权限 / Steam 授权」和「角色与权限」页的修改先放在本地草稿里：

- 有修改时，在面板底部浮出深色的 `.savebar`：「有未保存的更改 · 撤销 · 保存」。
- 保存时调用对应接口，成功后提示「已保存，已写入审计日志」；失败时保留草稿并显示错误。
- 切换用户、切换标签或关闭浮层时，如果有草稿，先确认是否放弃。

## 控制台页面

### Steam 账户

1. **当前连接**卡片：
   - 账户头像、状态（在线 / 未连接）、名字、SteamID；
   - 操作：
     - 「切换账户」：下拉菜单列出启用的账户；
     - 「退出 Steam」：需要确认；
     - 离线时显示「连接」。

     没有 `steam.manage` 时操作区显示「你没有登录或切换 Steam 的权限」。
   - 下方 4 项信息：最近登录、Token 更新、授权用户、消息存储。
2. **账户**列表（`#steamAccountTable`）：
   - 每行：头像、备注名、SteamID · 账户名提示、状态徽章（当前活动 / 已启用 / 已禁用）、授权人数、最近活跃。
   - 行内操作：「连接」（非活动的启用账户）；「⋯」菜单里有编辑资料、启用/禁用、退出登录、删除（需要确认）。
   - 卡片头部的「添加账户」按钮（需要 `steam.manage`）打开添加账户弹窗。
3. **授权概览**（需要 `steam.grant.manage`）：
   - 用户 × 账户矩阵，格子里是等级徽章；
   - 「指定好友」的格子显示「聊天 · 3 人」；
   - 7 天内到期的格子标黄；
   - 点击一行跳到该用户的「Steam 授权」标签；
   - 数据来自 `GET /api/steam/grants`。

**添加账户弹窗**有「扫码登录」和「密码登录」两个标签：

- 扫码登录（`#steamQrLogin`）：
  - 状态依次为 idle → waiting（显示二维码和 3 个步骤）→ scanned（「已扫码，请在手机上确认」）→ done；
  - 二维码过期时显示「二维码已过期」+ 刷新按钮；
  - 映射到现有的 `syncSteamQrLogin`。
- 密码登录：
  - 账户名和密码 → 提交 → 需要 Guard 时切换到验证码步骤：5 个格子，自动跳格，支持粘贴整串；
  - 错误时显示 `lastCodeWrong` 的提示。

### 用户

左侧是列表，右侧是详情。

- **列表**：
  - 顶部是搜索框（账号、昵称、备注），下面是筛选标签：全部 / 启用 / 禁用 / 锁定，各带数量。
  - 每行：头像、昵称 @账号、角色徽章（超级管理员用强调色）、非正常状态的徽章。
- **详情头部**：
  - 头像、昵称、@账号 · 角色 · 状态；查看自己时多一个「你」标记。
  - 操作：「编辑」「重置密码」和「⋯」菜单（启用/禁用、解除锁定、要求下次登录改密、删除）。
  - 没有 `user.manage` 时显示「只读查看」徽章。
  - 查看自己时不显示「⋯」。
- **概览**标签：昵称、账号、备注、创建时间、最近登录 · IP、最近活跃、密码修改时间、连续失败次数。
- **权限**标签：
  - 顶部是角色下拉框：需要 `role.manage`，且不是自己。
  - 下面按分组列出 12 个权限点。每行包含：
    - 名称、`code`、说明；
    - 三段开关：继承 / 授予 / 收回；
    - 有效结果：✓ 有效 / ✗ 无，并注明来源（来自角色 / 个人授予 / 个人收回 / 超级管理员）。
  - 设置了覆盖的行，在名称后标「个人覆盖」。
  - 不可编辑时整块禁用，并在顶部说明原因：
    - 「不能修改自己的角色与权限」；
    - 「超级管理员拥有全部权限」；
    - 「你没有『管理角色与权限』权限」。
- **Steam 授权**标签，每个账户一张卡片：
  - 卡片头部：账户名、SteamID，以及四段等级开关：无 / 只读 / 聊天 / 完整。
  - 等级不为「无」时，卡片里还有：
    - 会话范围：全部会话 / 指定好友。选「指定好友」时显示好友标签，可单个移除，「+ 添加好友」打开选择弹窗（可搜索、多选）。
    - 有效期下拉：永久 / 7 天 / 30 天 / 自定义日期。7 天内到期时显示黄色徽章。
    - 能力清单：查看会话与历史 / 发送文字与 Steam 表情 / 图片、贴纸、效果与回应。已有的打勾，没有的划掉。
  - 用户有 `steam.account.all` 时，顶部显示说明「以完整 · 全部会话访问所有账户，下列设置不生效」，卡片禁用。
  - 用户没有 `chat.use` 时，顶部显示黄色提示。
  - 账户已禁用时，卡片置灰并注明「账户已禁用，授权暂不生效」。
  - 没有 `steam.grant.manage` 时只读。
- **会话**标签：
  - 设备、IP、最近活跃；当前会话有标记。
  - 每行有「踢下线」；底部有「踢下线全部会话」（需要确认）。需要 `session.manage`。
- 弹窗：
  - 新增用户：账号、昵称、初始密码、备注、角色（需要 `role.manage`，否则固定为「成员」并禁用）、「首次登录要求改密」。
  - 编辑资料。
  - 重置密码：新密码，「要求下次登录修改」默认勾选。
  - 删除和禁用的确认框都写清后果，例如「其所有会话将立即失效」。

  这些弹窗替代所有 `window.prompt()` 和 `window.confirm()`。

### 角色与权限

顶部可在「按角色 / 权限对照表」之间切换。

- **按角色**：
  - 左侧是角色列表：图标、名称、「内置」徽章、成员数 · 权限数；「+」新建角色。
  - 右侧是角色详情：
    - 名称和说明；
    - 成员标签，点击跳到该用户；
    - 分组的权限勾选列表。
  - `super` 全部勾选且禁用，标「不可修改」；`member` 标「不可删除」。
  - 自定义角色有「重命名」「删除角色」；还有成员时，删除按钮旁说明「删除前需先把 N 名成员改为其他角色」。
- **权限对照表**：
  - 行是权限点（按分组），列是角色，格子是复选框，表头固定；
  - `super` 列禁用；
  - 修改同样经过 savebar 保存。
- **新建角色弹窗**：名称、说明、「复制权限自」（可选，下拉选已有角色）。

### 审计日志

- 工具栏：
  - 搜索框（操作者、动作、目标、IP）；
  - 时间范围：最近 7 天 / 30 天 / 全部；
  - 分类标签：全部 / Steam 授权 / 角色与权限 / 用户 / Steam / 会话。
- 每条记录一行：
  - 分类图标（不同分类用不同的 soft 底色）；
  - 动作的中文名；
  - 「操作者 → 目标」；
  - 时间、IP。
- 点击展开字段级差异表：字段 / 之前（红色删除线）/ 之后（绿色），数据来自 `detail.changes`。
  - 旧记录没有 `changes` 时，列出 detail 的键值。
  - **不显示原始 JSON**。
- action 到中文名的映射写成一张表，例如 `steam_account.grant_update` →「修改 Steam 授权」。未知 action 显示原值。

### 图片表情

左侧是分组列表，右侧是网格（`#imageEmoteManager`）。

- 网格第一格是上传区：拖入或选择图片，可多选。
- 每张素材显示缩略图、名称、大小；悬停时出现「编辑名称与分组」「删除」。
- 分组可重命名；分组不为空时不能删除，按钮禁用并在 `title` 说明。
- 卡片头部说明格式和大小限制。

需要 `emote.manage`；没有这个权限的用户在聊天的「自定义」表情里仍能使用素材。

### 设置

纵向排列的卡片，最大宽 760px：

1. **消息通知**：桌面通知开关、提示音（下拉 + 试听）、「仅在页面不在前台时提醒」。沿用现有的 `desktopNotificationControl`、`notificationSoundControls`。
2. **我的权限**：
   - 角色徽章；
   - 有效权限标签，悬停显示来源，个人授予的带「+」；
   - 每个有授权的 Steam 账户一行：等级徽章，以及范围和有效期。

   数据来自 `/api/auth/me` 的 `permissionDetails` 和 `steamGrant`；其他账户的授权需要后端在 me 接口里一并返回，或者只显示活动账户。
3. **账号安全**：
   - 修改密码表单（需要 `self.password.change`）；
   - 「退出其他设备」：调用现有的 `logout-all` 后重新登录当前设备；或者后端增加「保留当前会话」的参数。由实现时选定一种，在 PR 中说明。
4. **安装应用**（`#installApp`）：沿用 `setupAppInstallation`；不可安装时隐藏这张卡片。
5. **消息存储**：消息归档和历史索引的状态（`loadStorageHealth`）。

## 登录与初始化

- 页面中央是 360px 宽的卡片，内容依次为：
  - 圆角方形 logo；
  - 标题「登录 Steam Chat」；
  - 一行说明；
  - 账号、密码；
  - 错误行（`.form-error`，例如「账号或密码错误，再失败 2 次将锁定 15 分钟」，余量来自后端）；
  - 全宽主按钮。
- 初始化（`requiresSetup`）：同一张卡片，标题改为「创建管理员」，字段为账号、昵称、密码、确认密码。说明里注明这个账号会成为「超级管理员」。
- 强制改密（`forcePasswordChange`）：登录后显示同样样式的卡片，要求设置新密码，完成前不进入聊天。
- 启动失败（`bootstrap` 的 catch）：同样样式的卡片，显示错误和「重试」按钮。

## 权限状态汇总

| 情况 | 界面 |
| --- | --- |
| 没有 `chat.use` 或活动账户无授权 | 会话区显示「此账号尚无聊天访问权限」；会话列表为空并显示同样说明；控制台照常可用 |
| 只读 | 显示 `.scope-note`；输入区只有说明；表情回应按钮禁用；不显示重试 |
| 聊天 | 显示 `.scope-note`；输入区下方提示；图片按钮禁用；表情弹层只有「表情」可用；拖放不生效；回应禁用 |
| 完整 | 不显示授权说明 |
| 指定好友 | `.scope-note` 写明人数；隐藏「群组」标签和新建会话；快速跳转只搜名单内的会话 |
| 授权将在 7 天内到期 | `.scope-note` 用黄色 |
| Steam 离线 | `.cstatus` 显示红点和「未连接」；输入区禁用并保留草稿 |
| 存储异常 | `.banner-warn` |

前端的这些限制只是体验，后端会按 `docs/authorization-v2.md` 强制执行。前端收到 403 + `code: 'steam_grant_insufficient' | 'steam_peer_out_of_scope'` 时：

- 显示后端的错误文案；
- 立即重新拉取 `/api/auth/me`，因为授权可能刚刚被改过。

## 可访问性

- 所有图标按钮都要有 `aria-label` 和 `title`；禁用按钮的 `title` 写明原因。
- 弹窗、控制台、快速跳转：
  - 使用 `role="dialog"` 和 `aria-modal="true"`；
  - 打开时焦点移入，Tab 在内部循环；
  - Esc 关闭，关闭后焦点还原。
- 用户详情的标签用 `role="tablist"`、`role="tab"` 和 `aria-selected`，并支持左右方向键切换。
- 三段开关（`.seg`）用 `role="radiogroup"`，每个按钮用 `role="radio"` 和 `aria-checked`。
- 消息列表用 `role="log"` 和 `aria-live="polite"`。只播报新收到的消息，不播报加载的历史。
- 全局 toast 用 `role="status"`。
- 两个主题下，正文与背景的对比度都要 ≥ 4.5:1，`--text-3` 与背景 ≥ 3:1。原型里的值已满足。
- 焦点样式：`outline: 2px solid var(--accent); outline-offset: 2px`，不要去掉。
- 遵循 `prefers-reduced-motion`：关闭浮层、弹窗的位移动画，只保留淡入。

## 测试

需要更新的测试：

- `test/web-history.test.ts`、`web-image-paste.test.ts`、`web-image-progress.test.ts`、`web-message-render.test.ts`、`web-steam-qr.test.ts`
  - 按「保留的元素 ID」挂好 ID 后，主要改 class 选择器和结构断言。
- `test/browser/*.cjs`，以下几个受影响最大：
  - `collapse-conversation-list`、`close-conversation`：会话列表结构变了；
  - `history-scroll`、`sleep-recovery`：历史工具条改为弹层和浮动条；
  - `message-reactions`：回应入口移到悬浮工具条；
  - `steam-media-send`、`image-emotes`：表情弹层的结构变了。

需要新增的测试：

- 权限：
  - 用三个身份（超级管理员、聊天 + 指定好友 + 授予 `emote.manage`、只读）分别验证控制台导航项、输入区状态、表情弹层锁定、拖放是否可用；
  - 收到 403 后会重新拉取 `/api/auth/me`。
- 控制台：
  - Esc 和遮罩能关闭；
  - 有未保存草稿时先确认；
  - 旧 `steam-chat.view` 值的映射。
- 布局：390 / 960 / 1440 三种宽度下没有横向溢出，`data-mobile` 切换正确。
- 快速跳转：Ctrl K 打开、方向键、Enter 跳转。
- 主题：`auto` 跟随系统；`light` 和 `dark` 覆盖系统设置。

## 验收清单

- [ ] 与原型对照：1440×900、390×844，浅色和深色，以下画面一致：
  - 聊天、资料卡、日期弹层、表情弹层；
  - 控制台各页；
  - 弹窗；
  - 登录。
- [ ] 「必须保留的现有行为」逐项手测通过。
- [ ] 前端代码里没有 `role === 'admin'` 或 `role !== 'admin'`（`grep` 为空）。
- [ ] 三个身份的权限表现与「权限状态汇总」一致，后端拒绝时界面不崩溃。
- [ ] 全部 Lighthouse 可访问性检查无错误；键盘可以完成登录、切换会话、发送、打开控制台、保存授权。
- [ ] `npm test` 和 `test/browser/*.cjs` 全部通过。
- [ ] 构建产物不包含 `web/redesign-prototype/`、`web/prototype/`、`web/android-prototype/`。

## 落地顺序

1. 后端：`docs/authorization-v2.md` 的第 1–3 步。
2. 前端基础：设计令牌、主题、新的 `renderShell` 和控制台框架，`View` 映射，保留的 ID。先把旧页面内容原样放进控制台，保证可用。
3. 聊天区：会话列表、头部、资料卡、消息、历史、输入区、快速跳转。
4. 控制台各页：Steam 账户（含添加账户弹窗）→ 用户 → 角色与权限 → 审计 → 图片表情 → 设置。
5. 登录、初始化、强制改密。
6. 可访问性和测试补全，按验收清单逐项检查。

每一步单独提交，并保证测试通过。
