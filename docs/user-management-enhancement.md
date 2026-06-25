# 用户管理增强设计

## 背景

当前后台已经具备基础用户系统：

- 首次初始化管理员。
- 后台账号密码登录。
- `admin` / `user` 两级固定角色。
- 用户启用、禁用、删除、重置密码。
- 签名 Cookie 会话和 `session_version` 失效机制。

本设计是在 `docs/backend-redesign.md` 的用户系统基础上继续增强，不重做认证入口，不引入外部身份服务，也不把 Steam 密码、Steam Guard code 或 refresh token 写入配置文件。

## 目标

- 用户资料从“只有账号名”扩展为可运营的后台用户档案。
- 管理员可以看到用户状态、最近登录和最近活跃信息。
- 管理员可以审计关键管理动作。
- 管理员可以踢下线指定用户或使用户所有会话失效。
- 固定角色继续保留，但后端按权限点执行校验，避免业务逻辑散落判断角色字符串。
- 普通用户只能访问被授权的 Steam 账户，不能查看或操作未授权 Steam 账户的聊天、历史、好友、群组和素材。
- 为后续多 Steam 账户切换预留数据结构，但 v1 不实现多个 Steam 账户同时在线。

## 非目标

- 不支持自定义角色。
- 不支持头像、邮箱、手机号等用户资料。
- 不做审计日志导出。
- 不接入 LDAP、OAuth、OIDC 或外部 SSO。
- 不实现多个 Steam 会话并发在线；v1 仍保持一个运行时活动 Steam 会话。
- 不在数据库中保存 Steam 明文密码或 Steam Guard code。

## 角色和权限

角色保持固定：

- `admin`：后台管理员。
- `user`：普通聊天用户。

后端引入权限点映射，业务代码调用权限点而不是直接散落判断角色：

| 权限点 | admin | user | 说明 |
| --- | --- | --- | --- |
| `user.manage` | 是 | 否 | 新增、编辑、禁用、删除用户 |
| `session.manage` | 是 | 否 | 查看和踢下线用户会话 |
| `audit.view` | 是 | 否 | 查看审计日志 |
| `steam.manage` | 是 | 否 | 登录、退出、切换 Steam 账户 |
| `steam.account.manage` | 是 | 否 | 维护 Steam 账户资料和授权关系 |
| `chat.use` | 是 | 是 | 使用聊天能力；普通用户还必须通过 Steam 账户授权 |
| `self.password.change` | 是 | 是 | 修改自己的后台密码 |

`admin` 对所有 Steam 账户默认有访问权。`user` 只允许访问授权表中的 Steam 账户。

## 数据模型

继续使用 `${STEAM_CHAT_DATA_DIR}/auth.sqlite`。启动时执行幂等迁移，旧库自动补齐字段和表。

### users

在现有 `users` 表上增加字段：

```sql
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN created_by INTEGER;
ALTER TABLE users ADD COLUMN last_login_ip TEXT;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE users ADD COLUMN force_password_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
```

字段说明：

- `display_name`：后台展示名，可为空；为空时前端展示 `username`。
- `note`：管理员备注，仅管理员可见。
- `created_by`：创建该用户的管理员 ID；初始化管理员为空。
- `last_login_ip`：最近一次登录成功的客户端 IP，按现有 `trustProxy` 规则解析。
- `last_seen_at`：最近一次通过认证请求的时间。
- `password_changed_at`：最近一次密码变更时间。
- `force_password_change`：管理员重置密码后可要求用户下次登录后先改密。
- `failed_login_count` / `locked_until`：登录失败和临时锁定状态。

### user_sessions

当前签名 Cookie 是无状态会话，无法列出或单独踢下线。增强后改成“签名 Cookie + 会话表”：

```sql
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
```

Cookie payload 增加 `sid`：

```json
{
  "sid": "base64url-random-id",
  "uid": 1,
  "role": "admin",
  "sv": 1,
  "iat": 1710000000000,
  "exp": 1710604800000
}
```

校验规则：

- Cookie 签名、过期时间、`uid`、`role`、`session_version` 仍然校验。
- 额外查询 `user_sessions.id = sid`。
- 会话不存在、已撤销、已过期时返回 401。
- 每次认证成功节流更新 `user_sessions.last_seen_at` 和 `users.last_seen_at`。
- 管理员踢下线时设置 `revoked_at` 和 `revoked_by`。

### steam_accounts

新增 Steam 账户资源表：

```sql
CREATE TABLE IF NOT EXISTS steam_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  account_name_hint TEXT NOT NULL DEFAULT '',
  refresh_token TEXT,
  refresh_token_updated_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  last_active_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
```

字段说明：

- `steam_id`：SteamID64，是授权和日志隔离的主键。
- `label`：管理员维护的显示名称，例如“客服一号”。
- `account_name_hint`：可选账号提示，只保存脱敏后的账号名或管理员输入的备注，不保存密码。
- `refresh_token`：该 Steam 账户的 refresh token，用于后续免密码连接；接口响应、审计日志和普通错误日志都不能返回该字段。
- `refresh_token_updated_at`：最近一次写入 refresh token 的时间。
- `enabled`：禁用后不能被连接，普通用户也不能访问。
- `last_login_at` / `last_active_at`：最近连接和活动时间。

Steam refresh token 写入 `steam_accounts.refresh_token`。本项目仍不保存 Steam 明文密码和 Steam Guard code；refresh token 只作为 Steam 账户资源的敏感字段保存在本地 SQLite 中。

### user_steam_accounts

用户和 Steam 账户的授权关系：

```sql
CREATE TABLE IF NOT EXISTS user_steam_accounts (
  user_id INTEGER NOT NULL,
  steam_account_id INTEGER NOT NULL,
  granted_by INTEGER,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, steam_account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (steam_account_id) REFERENCES steam_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);
```

规则：

- 新建普通用户默认没有 Steam 账户访问权。
- 管理员默认可访问所有 Steam 账户，不需要写授权行。
- 禁用 Steam 账户后，所有普通用户对该账户的访问立即失效。
- 删除 Steam 账户时同时删除授权关系和该账户记录中的 refresh token。

### audit_logs

新增本地审计日志表：

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
```

记录动作：

- 用户：创建、更新资料、启用、禁用、删除、角色变更、重置密码、强制改密状态变更。
- 会话：踢下线单个会话、踢下线用户全部会话、用户主动退出全部会话。
- Steam 账户：新增、更新、禁用、启用、删除、授权、取消授权、登录、退出、切换。

审计日志只记录必要元数据。密码、Steam Guard code、refresh token 必须脱敏或不进入 `detail_json`。

## Steam 账户访问控制

### 当前运行模型

v1 仍只有一个活动 Steam 会话。后端维护当前活动账户：

```text
app_meta.active_steam_account_id
```

所有依赖 Steam 账户上下文的接口都必须先解析当前活动账户：

1. 校验后台用户会话。
2. 读取当前 Steam 状态和 `active_steam_account_id`。
3. 如果接口依赖 Steam 在线，继续要求 Steam 状态为 `online`。
4. 校验当前用户是否可访问该 Steam 账户。
5. 执行业务逻辑。

普通用户未被授权访问当前活动账户时返回 403：

```json
{
  "error": "Steam account access denied"
}
```

如果当前没有活动 Steam 账户，依赖 Steam 的接口返回 503：

```json
{
  "error": "Steam account is not connected",
  "steamStatus": "logged_out"
}
```

### 需要保护的接口

以下接口必须校验 Steam 账户访问权：

- `GET /api/steam/status`
- `GET /api/friends`
- `GET /api/groups`
- `GET /api/emoticons`
- `GET /history`
- `GET /conversations`
- `GET /proxy/sticker/:type`
- `GET /proxy/image`
- `POST /message`
- `POST /image`
- WebSocket 握手后的所有聊天、历史、好友、群组、素材消息类型

管理员管理接口仍只校验管理员权限：

- Steam 登录、退出、切换账户。
- Steam 账户维护。
- 用户 Steam 账户授权维护。

### 聊天历史隔离

现有聊天历史是 JSONL 文件。为了避免用户读取未授权账户历史，新增日志字段：

```json
{
  "steamAccountId": "7656119...",
  "id": "target-steam-id",
  "message": "..."
}
```

规则：

- 新写入的历史必须带 `steamAccountId`。
- 查询历史和会话列表时必须传入当前活动账户，并只返回该账户记录。
- 旧历史没有 `steamAccountId`，迁移期只允许管理员查看。
- 当前活动账户首次成功识别后，可以由管理员触发一次“认领旧历史到该 Steam 账户”的维护动作；v1 可以先不做自动认领。

## 后端 API

### 当前用户

`GET /api/auth/me` 增加字段：

```json
{
  "needsSetup": false,
  "user": {
    "id": 1,
    "username": "admin",
    "displayName": "管理员",
    "role": "admin",
    "disabled": false,
    "forcePasswordChange": false
  },
  "permissions": ["user.manage", "steam.manage"],
  "steam": {
    "status": "online",
    "steamId": "7656119...",
    "activeAccount": {
      "id": 1,
      "steamId": "7656119...",
      "label": "客服一号"
    },
    "accessAllowed": true
  }
}
```

### 用户管理

新增或调整接口：

- `GET /api/users?query=&role=&status=`
  - 管理员可用。
  - 支持按账号、昵称、备注搜索。
  - `status` 支持 `enabled`、`disabled`、`locked`。
- `POST /api/users`
  - 新增 `displayName`、`note`、`steamAccountIds`。
- `PATCH /api/users/:id`
  - 支持 `displayName`、`note`、`role`、`disabled`、`forcePasswordChange`。
- `GET /api/users/:id/sessions`
  - 返回该用户未过期且未撤销的会话。
- `DELETE /api/users/:id/sessions/:sessionId`
  - 管理员踢下线单个会话。
- `DELETE /api/users/:id/sessions`
  - 管理员踢下线用户全部会话。
- `GET /api/users/:id/steam-accounts`
  - 查看普通用户已授权 Steam 账户。
- `PUT /api/users/:id/steam-accounts`
  - 用完整 `steamAccountIds` 覆盖授权关系。

保留现有接口：

- `POST /api/users/:id/password`
- `DELETE /api/users/:id`
- `POST /api/auth/password`
- `POST /api/auth/logout`

新增当前用户退出全部会话：

- `POST /api/auth/logout-all`
  - 撤销当前用户除当前请求外的所有会话，随后也可选择清除当前 Cookie。

### Steam 账户管理

新增接口：

- `GET /api/steam/accounts`
  - 管理员返回全部账户。
  - 普通用户返回自己被授权且启用的账户。
- `POST /api/steam/accounts/login`
  - 管理员用账号密码登录 Steam。
  - 请求包含 `accountName`、`password`、可选 `logonID`、可选 `label`。
  - 登录成功后用 SteamID64 upsert `steam_accounts`，写入 `refresh_token`，并设为当前活动账户。
- `POST /api/steam/accounts/:id/connect`
  - 管理员用该账户 `refresh_token` 连接 Steam。
  - 成功后设为当前活动账户。
- `PATCH /api/steam/accounts/:id`
  - 管理员更新 `label`、`accountNameHint`、`enabled`。
- `DELETE /api/steam/accounts/:id`
  - 管理员删除账户资料、授权关系和表内 refresh token。
  - 如果删除的是当前活动账户，必须先退出 Steam 或由后端自动执行退出。
- `POST /api/steam/accounts/:id/logout`
  - 管理员退出当前活动账户；只允许操作当前活动账户。

兼容现有接口：

- `POST /api/steam/login` 可以保留为 `POST /api/steam/accounts/login` 的兼容入口。
- `POST /api/steam/logout` 可以保留为退出当前活动账户的兼容入口。
- `GET /api/steam/status` 返回当前活动账户信息和当前用户访问结果。

## 前端设计

### 导航

管理员导航增加：

- `用户管理`
- `Steam 账户`
- `审计日志`

普通用户导航保持：

- `Steam 连接` 或状态页
- `聊天`
- `账号`

普通用户只看到自己可访问的 Steam 账户状态。未授权当前活动账户时，聊天页展示无权限状态，不加载好友、群组、历史和 WebSocket。

### 用户管理页

用户列表展示：

- 账号。
- 昵称。
- 角色。
- 启用、禁用、锁定状态。
- 已授权 Steam 账户数量。
- 最近登录时间和 IP。
- 最近活跃时间。

用户详情区支持：

- 修改昵称和备注。
- 修改角色。
- 启用、禁用。
- 重置密码。
- 要求下次登录改密。
- 管理 Steam 账户授权。
- 查看和踢下线会话。

### Steam 账户页

管理员可查看：

- SteamID64。
- 显示名称。
- 当前是否活动。
- 是否启用。
- 最近登录时间。
- 被授权用户数量。

操作：

- 登录新的 Steam 账户。
- 用已保存 token 连接已有账户。
- 编辑显示名称和账号提示。
- 启用、禁用。
- 删除账户。
- 查看已授权用户。

### 审计日志页

v1 只提供后台查看，不提供导出：

- 按动作、目标类型、操作者、时间范围筛选。
- 展示时间、操作者、动作、目标、IP、简要详情。
- 敏感字段永远不展示。

## 迁移策略

1. 启动时创建新表并给 `users` 补齐新增字段。
2. 引入 `schema_version` 或在 `app_meta` 中记录迁移版本，迁移保持幂等。
3. 现有 Cookie 没有 `sid`，升级后统一要求重新登录。
4. 现有 `${STEAM_CHAT_DATA_DIR}/refresh.token` 保留为兼容读取来源，首次成功登录并识别 SteamID 后写入 `steam_accounts.refresh_token` 和 `refresh_token_updated_at`。
5. token 迁移成功后删除旧路径 `refresh.token`，避免同一敏感凭据存在两份。
6. 首个识别出的 Steam 账户自动创建 `steam_accounts` 记录并设为当前活动账户。
7. 普通用户默认不自动获得该账户访问权，由管理员显式授权。
8. 旧聊天历史没有 `steamAccountId`，默认只允许管理员查看；后续可增加管理员手动认领工具。

## 安全要求

- 所有权限校验必须在后端执行，前端只做体验隐藏。
- 管理员不能删除或禁用最后一个启用管理员。
- 管理员不能删除当前登录用户自己。
- 用户被禁用、角色变更、重置密码、强制改密时，相关旧会话必须失效。
- 登录失败达到阈值后临时锁定账号；建议默认 5 次失败锁定 15 分钟。
- 审计日志和错误日志不得包含后台密码、Steam 密码、Steam Guard code、refresh token。
- `steam_accounts.refresh_token` 不得出现在任何 API 响应、前端状态、审计详情或结构化日志中。
- Steam 账户授权失败统一返回 403，不暴露未授权账户的详情。
- 普通用户不能通过历史、会话列表、WebSocket 或媒体代理旁路读取未授权账户数据。

## 测试要求

新增或调整测试：

- 用户资料字段迁移和读写。
- 固定角色到权限点映射。
- 登录失败计数和锁定。
- 会话表校验、踢下线、退出全部会话。
- 用户禁用、角色变更、重置密码后旧会话失效。
- Steam 账户创建、禁用、删除和表内 refresh token 读写。
- 普通用户访问未授权 Steam 账户返回 403。
- 普通用户不能读取未授权账户历史、会话列表、好友、群组、素材和 WebSocket 数据。
- 管理员默认可访问所有 Steam 账户。
- 审计日志记录关键管理动作并脱敏敏感字段。
- 旧库迁移后已有管理员仍可登录。

验收命令：

```bash
npm run typecheck
npm test
```

## 建议落地顺序

1. 数据迁移和权限点映射。
2. 会话表和踢下线能力。
3. 用户资料、登录安全和审计日志。
4. Steam 账户表、授权关系和当前活动账户校验。
5. 聊天历史增加 `steamAccountId` 并按账户过滤。
6. 前端用户详情、Steam 账户页和审计日志页。
7. 清理兼容接口和补齐测试。
