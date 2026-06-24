# Steam Chat 后台改造设计

## 目标

本次改造要把当前的 Steam Chat 从“启动时读取 `config.js` 并立即登录 Steam”改成“应用先启动，后台用户登录后再由管理员在 Web 页面完成 Steam 登录”。

核心目标：

- 不再依赖 `config.js` 保存 Steam 账号密码。
- 服务无 Steam token 时也能启动并打开 Web 后台。
- 增加 SQLite 多用户后台，管理员负责用户管理和 Steam 登录，普通用户只使用已连接的 Steam 会话聊天。
- 前端完全重写为后台应用，不再在现有聊天页面上追加登录和管理功能。
- 首次 Steam 登录成功后只持久化 `refresh.token`，不保存 Steam 明文密码或 Steam Guard 验证码。
- 保留现有聊天、好友、群组、历史、图片和 WebSocket 能力。

## 当前问题

当前入口在启动时调用 Steam 登录流程。如果项目根目录没有 `config.js`，会退回 `config.example.js`；示例配置没有真实 Steam 凭据时，登录流程会报错，应用也无法作为一个可配置的后台服务正常交付。

当前持久化路径也分散在项目根目录下：

- `refresh.token`
- `logs/chat.jsonl`
- `logs/images/`
- `logs/stickers/`

容器部署后这些状态必须进入统一数据目录，否则镜像重建或容器重建会丢失登录 token、聊天记录和媒体缓存。

## 运行模型

改造后的启动顺序：

1. 读取环境变量和数据目录配置。
2. 初始化 SQLite 用户库和应用密钥。
3. 启动 HTTP/WebSocket 服务。
4. 如果数据目录存在 `refresh.token`，后台自动尝试 Steam token 登录。
5. 如果没有 token，Web 后台保持可访问，管理员在页面发起 Steam 登录。

Steam 登录状态由后端统一维护：

- `logged_out`：未登录 Steam，聊天发送、好友、群组、表情等依赖 Steam 的接口返回 503。
- `logging_in`：正在提交 Steam 登录。
- `waiting_guard`：Steam 要求邮箱码或手机 2FA，等待管理员提交验证码。
- `online`：Steam 登录成功，聊天功能可用。
- `error`：最近一次登录失败，状态接口返回错误信息。
- `reconnecting`：已登录后断线，后台自动重连或等待管理员处理。

Web 页面在应用登录后始终可打开。未连接 Steam 时，聊天区域显示当前 Steam 状态；管理员可看到 Steam 登录表单，普通用户只能看到等待连接状态。

## 用户系统

使用 Node 26 内置 `node:sqlite`，不引入额外数据库容器或 native npm 依赖。

SQLite 文件位置：

```text
${STEAM_CHAT_DATA_DIR}/auth.sqlite
```

建议表结构：

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

密码规则：

- 用户名长度 3 到 64，只允许字母、数字、下划线、短横线和点。
- 密码最少 8 位。
- 使用 `crypto.scryptSync` 加随机盐保存密码哈希。
- 哈希字段保存为自描述格式，例如 `scrypt:v1:<salt>:<hash>`。
- 登录、重置密码、禁用、启用、角色变更时不记录明文密码。

首次访问时，如果 `users` 表为空，前端显示初始化管理员页面。初始化接口创建第一个启用的 `admin` 用户。之后该接口必须拒绝再次调用。

权限规则：

- `admin`：可管理后台用户，可执行 Steam 登录、Steam Guard 提交、Steam 退出。
- `user`：可使用已登录 Steam 会话聊天，可读取聊天所需的好友、群组、历史和媒体接口。
- 不能删除当前登录用户自己。
- 不能删除、禁用或降级最后一个启用的管理员。
- 禁用用户后，该用户已有 Cookie 必须失效。

## 应用会话

使用签名 Cookie，不引入服务端 session 表。

Cookie：

- 名称：`steam_chat_session`
- 属性：`HttpOnly`、`SameSite=Lax`、`Path=/`
- 过期时间：默认 7 天
- HTTPS 反代下设置 `Secure`

签名密钥：

- 首次启动时生成 32 字节随机密钥。
- 保存在 `app_meta.session_secret`。
- 数据目录持久化后，容器重建不会导致所有用户退出。

Cookie payload 包含：

```json
{
  "uid": 1,
  "role": "admin",
  "sv": 1,
  "iat": 1710000000000,
  "exp": 1710604800000
}
```

校验规则：

- HMAC 使用 `sha256`。
- 每个受保护请求都根据 `uid` 查询数据库。
- 用户不存在、被禁用、`session_version` 不匹配、Cookie 过期或签名不正确时返回 401。
- 重置密码、禁用用户、启用用户、变更角色时递增 `session_version`，使旧 Cookie 失效。

## HTTP API

所有响应使用 JSON。未认证返回 401，权限不足返回 403。

公开接口：

- `GET /healthz`
  - 仅表示应用进程和 HTTP 服务可用，不要求 Steam 已登录。
  - 返回：`{ "ok": true }`
- `GET /api/auth/me`
  - 未登录也可访问。
  - 返回是否需要初始化、当前登录用户和 Steam 状态摘要。
- `POST /api/auth/setup`
  - 仅在没有任何用户时可用。
  - 请求：`{ "username": "admin", "password": "..." }`
  - 成功后直接写入登录 Cookie。
- `POST /api/auth/login`
  - 请求：`{ "username": "...", "password": "..." }`
  - 成功后写入登录 Cookie。
- `POST /api/auth/logout`
  - 清除当前 Cookie。

登录用户接口：

- `POST /api/auth/password`
  - 当前用户修改自己的后台密码。
  - 请求：`{ "oldPassword": "...", "newPassword": "..." }`

管理员用户管理接口：

- `GET /api/users`
  - 返回用户列表，不返回密码哈希。
- `POST /api/users`
  - 请求：`{ "username": "...", "password": "...", "role": "user" }`
- `PATCH /api/users/:id`
  - 支持修改 `role`、`disabled`。
- `POST /api/users/:id/password`
  - 管理员重置指定用户密码。
- `DELETE /api/users/:id`
  - 删除非自身用户，并执行最后管理员保护。

Steam 管理接口：

- `GET /api/steam/status`
  - 返回当前 Steam 状态、是否需要 Guard、最近错误、当前 SteamID。
- `POST /api/steam/login`
  - 仅管理员。
  - 请求：`{ "accountName": "...", "password": "...", "logonID": 123 }`
  - `logonID` 可选；缺省时后端生成稳定随机值并保存在数据目录配置中。
  - 如果需要 Steam Guard，返回 `waiting_guard`。
- `POST /api/steam/guard`
  - 仅管理员。
  - 请求：`{ "code": "ABCDE" }`
  - 后端把验证码交给当前待处理的 Steam Guard callback。
- `POST /api/steam/logout`
  - 仅管理员。
  - 调用 Steam `logOff()`，删除数据目录里的 `refresh.token`，状态变为 `logged_out`。

聊天相关的既有接口和 WebSocket 协议保留，但必须先通过应用登录认证。未登录 Steam 时，依赖 Steam 的接口返回：

```json
{
  "error": "Steam is not logged in",
  "steamStatus": "logged_out"
}
```

## Steam 登录实现

将 Steam 生命周期从“构造时绑定固定 config”调整为“运行期按请求传入登录参数”。

后端新增 `SteamLoginService`，负责：

- 启动时读取 `${STEAM_CHAT_DATA_DIR}/refresh.token` 并尝试 token 登录。
- 管理 Steam 状态机。
- 监听 `steamGuard(domain, callback, lastCodeWrong)`。
- 保存待提交的 Guard callback，并通过状态接口暴露 `guardType`、`domain`、`lastCodeWrong`。
- 登录成功后监听 `refreshToken` 事件并写入数据目录。
- Steam 退出时删除 token。

Guard 类型规则：

- `domain` 为字符串时表示邮箱码，前端展示邮箱域名。
- `domain` 为 `null` 时表示手机 2FA。
- `lastCodeWrong` 为 `true` 时，前端提示等待新验证码后再提交，避免 2FA 循环。

安全要求：

- 请求日志、错误日志、前端状态都不能输出 Steam 密码、后台密码、Steam Guard code、refresh token。
- 同一时间只允许一个 Steam 登录流程。已有 `logging_in` 或 `waiting_guard` 时，再次登录请求返回 409。
- 管理员手动重新登录前，应先调用 Steam 退出或等待当前登录流程结束。

## 前端重写

前端必须按新的后台业务模型完全重写。旧的 `web/index.html`、`web/app.ts`、`web/style.css` 只作为功能参考，不作为增量改造基础；实现时允许删除旧 DOM 结构、旧全局状态机和旧样式组织。

重写目标：

- 首屏是后台应用入口，不是默认聊天界面。
- 先解决后台初始化和后台登录，再进入业务工作台。
- Steam 连接状态是后台工作台的一部分，而不是启动前置条件。
- 聊天能力作为已登录后台用户的一个业务模块存在。
- 管理员和普通用户看到的导航、按钮和操作必须按权限区分。

页面结构：

1. 初始化页
   - 仅在没有任何后台用户时展示。
   - 创建第一个管理员，成功后直接进入后台。
2. 后台登录页
   - 已初始化但未登录时展示。
   - 只处理后台用户登录，不处理 Steam 登录。
3. 应用外壳
   - 登录后展示统一后台布局。
   - 包含侧边导航、顶部状态区、当前后台用户入口、退出登录入口。
4. Steam 连接页
   - 管理员可提交 Steam 账号密码。
   - 需要 Steam Guard 时切换到验证码提交状态。
   - 普通用户只能查看当前 Steam 状态。
5. 用户管理页
   - 仅管理员可见。
   - 支持新增用户、重置密码、启用/禁用、删除。
6. 聊天页
   - 重新实现会话列表、好友/群组列表、消息区、输入区、图片发送、表情/贴纸选择。
   - Steam 未在线时展示不可用状态，并禁用发送、图片、表情等操作。

前端启动顺序：

1. 请求 `GET /api/auth/me`。
2. 如果需要初始化，渲染初始化页。
3. 如果未登录，渲染后台登录页。
4. 如果已登录，进入应用外壳。
5. 加载 `GET /api/steam/status` 和 `GET /api/config`。
6. 只有后台已登录后才建立 WebSocket。
7. Steam 未在线时保留页面可访问，但禁用依赖 Steam 的交互。

实现约束：

- v1 继续使用当前 TypeScript 静态构建链路，不强制引入前端框架或 bundler。
- 可以把 `web/app.ts` 拆成多个 TypeScript 模块，但输出仍由 `tsc` 生成到 `dist/web`。
- 所有前端请求默认携带同源 Cookie；401 时关闭 WebSocket 并回到后台登录页。
- 前端状态中不能保存或打印 Steam 密码、后台密码、Steam Guard code、refresh token。
- 移动端必须能完成初始化、后台登录、Steam Guard 提交和基础聊天。

## 测试要求

新增或调整以下测试：

- 用户初始化：无用户时允许 setup，有用户后拒绝 setup。
- 登录认证：密码正确写 Cookie，密码错误拒绝，禁用用户拒绝。
- Cookie 校验：签名错误、过期、`session_version` 不匹配都返回 401。
- 用户管理：管理员可新增、重置密码、禁用、启用、删除；普通用户返回 403。
- 最后管理员保护：不能删除、禁用或降级最后一个启用管理员。
- Steam 状态：无 token 时服务启动且状态为 `logged_out`。
- Steam token 登录：存在 `refresh.token` 时启动后自动尝试登录。
- Steam Guard：触发 `waiting_guard`，提交验证码后继续登录，错误验证码保留状态。
- 聊天接口：应用未登录返回 401；应用已登录但 Steam 未登录返回 503；Steam 在线后保持现有行为。
- WebSocket：未认证握手拒绝，认证后可连接。

验收命令：

```bash
npm run typecheck
npm test
```
