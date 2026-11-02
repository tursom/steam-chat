# 授权体系 v2 设计

## 背景

`docs/user-management-enhancement.md` 落地后，后台有 `admin` / `user` 两个固定角色、7 个权限点和「用户 × Steam 账户」的授权表。现在的问题：

- 角色写死在 `ROLE_PERMISSIONS` 里，不能新建角色，也不能给单个用户加减权限。
- 很多地方仍直接判断 `role === 'admin'`：
  - `canAccessSteamAccount`、`listSteamAccountsForUser`：管理员绕过授权表。
  - `requireSteamAccountAccess` / `wsAccessContext`：`includeLegacy` 只给管理员。
  - `steamStatusForSession`：`activeAccount` 对管理员总是返回。
  - `POST /api/image-emotes`：直接用 `requireAdminSession`。
  - session 签名 Cookie 里带 `role`，角色变化时 Cookie 失效。
  - 前端 `web/app.ts` 里有 5 处 `role === 'admin'`（约 858、870、959、1119、1735 行）。
- Steam 授权只有「有 / 无」两档。客服之类的账号要么什么都能发，要么完全看不到。
- 授权一定覆盖整个 Steam 账户，不能只开放部分好友。
- `user.manage` 可以通过 `PATCH /api/users/:id` 把任何人（包括自己）改成 `admin`，没有防提权。
- 发文字的 `POST /message`、WS `send_message` / `send_image` 没有检查 `chat.use`，只有 `/api/send-operations` 检查了。

界面原型在 `web/redesign-prototype/`（方向 C），授权相关界面见该原型的「用户 → 权限 / Steam 授权」「角色与权限」「设置 → 我的权限」。前端规格见 `docs/web-redesign.md`。

## 目标

1. 补全权限点，后端和前端都只按权限点判断，不再判断角色字符串。
2. 角色可自定义；用户可在角色之上做单项「授予 / 收回」覆盖。
3. Steam 授权分为 无 / 只读 / 聊天 / 完整 四级，可设有效期。
4. 授权可限定为「指定好友」，范围外的会话、历史、实时消息一律不可见。
5. 现有数据自动迁移，现有用户的实际能力不变；Android 客户端和旧接口不受影响。

## 非目标

- 不做群组聊天授权：范围受限的用户不能看到任何群组；全量授权用户对群组的行为保持现状。
- 不做「按权限点授权到具体对象」的通用 ACL，只有 Steam 账户和好友两级对象。
- 不做多个 Steam 账户同时在线（仍然只有一个运行时活动账户）。
- 不改 legacy 模式（未启用 session 认证、只用 token 的部署）的行为：legacy 等同于全部权限 + 完整授权。

## 权限点

| 权限点 | 名称 | 守护的内容 | 来源 |
| --- | --- | --- | --- |
| `user.view` | 查看用户 | `GET /api/users`、用户详情、某用户的授权和有效权限 | 新增，拆自 `user.manage` |
| `user.manage` | 管理用户 | 新建、编辑资料、启用/禁用、重置密码、删除用户 | 已有，蕴含 `user.view` |
| `role.manage` | 管理角色 | 角色增删改、用户换角色、个人覆盖 | 新增 |
| `session.manage` | 管理会话 | 查看、撤销他人的登录会话 | 已有 |
| `audit.view` | 查看审计 | `GET /api/audit-logs` | 已有 |
| `steam.manage` | 管理 Steam 连接 | 扫码/密码登录、Guard、切换、退出 | 已有 |
| `steam.account.manage` | 管理 Steam 账户资料 | 改备注、启用/禁用、删除账户 | 已有（不再包含授权） |
| `steam.grant.manage` | 分配 Steam 授权 | 改某用户的授权等级、范围、有效期；授权概览 | 新增，拆自 `steam.account.manage` |
| `steam.account.all` | 全部 Steam 账户 | 不查授权表，按「完整 / 全部会话」访问所有启用账户；含旧版无账户历史（`includeLegacy`） | 新增，替代 admin 绕过 |
| `chat.use` | 使用聊天 | 所有聊天读写接口的前置条件（还要有 Steam 授权） | 已有 |
| `emote.manage` | 管理图片表情 | `POST /api/image-emotes` | 新增，替代 `requireAdminSession` |
| `self.password.change` | 修改自己的密码 | `POST /api/auth/password` | 已有 |

规则：

- 权限点列表写成常量 `ALL_PERMISSIONS`（按上表顺序），前后端共用同一组字符串。未知字符串一律 400。
- `user.manage` 蕴含 `user.view`：在计算有效权限时自动补上，不需要单独勾选。
- `chat.use` 是聊天能力的总开关。有 Steam 授权但没有 `chat.use` 的用户：会话、历史、好友一律 403，`accessAllowed` 为 `false`。

## 角色

### 内置角色

| id | 名称 | 权限 | 可改权限 | 可删除 |
| --- | --- | --- | --- | --- |
| `super` | 超级管理员 | 全部（运行时计算，不存 `role_permissions`） | 否 | 否 |
| `member` | 成员 | `chat.use`、`self.password.change` | 是 | 否 |

- `super` 的权限永远等于当前 `ALL_PERMISSIONS`，以后新增权限点时自动拥有。
- `member` 是新建用户的默认角色。
- 迁移时 `admin` → `super`，`user` → `member`。

### 自定义角色

- id 由服务端生成：`r_` + 8 位随机小写字母数字，例如 `r_k3m9x2qa`。不可修改。
- 名称 1–32 字符，唯一（大小写不敏感）；说明 0–200 字符。
- 新建时可以从某个角色「复制权限」（原型「新建角色」弹窗里的选项），服务端只接收最终的权限列表。
- 角色下仍有用户时不能删除（409），需要先把用户换到其他角色。
- 原型里的「客服」「审计员」只是示例，**迁移不创建它们**。

## 个人覆盖与有效权限

每个用户可对任一权限点设置：

- `inherit`（不存记录）
- `grant`：额外授予
- `revoke`：收回

有效权限计算（`effectivePermissions(user)`）：

```text
if user.roleId == 'super':
  return ALL_PERMISSIONS                       # 超级管理员不受覆盖影响
base = role_permissions(user.roleId)
eff  = (base ∪ grants) − revokes
if 'user.manage' in eff: eff += 'user.view'
return eff (按 ALL_PERMISSIONS 顺序)
```

- 超级管理员不能设置覆盖：`PUT .../permission-overrides` 返回 400。如果把用户改为 `super`，同一事务里删除其全部覆盖。
- 修改覆盖不必让用户重新登录；有效权限每次请求都重新计算（见「会话」）。
- API 返回有效权限时附带来源，供界面显示「来自角色」「个人授予」「个人收回」：

```json
{ "permission": "emote.manage", "effective": true, "source": "grant" }
```

`source` 取值：`super`、`role`、`grant`、`revoke`、`none`、`implied`（由 `user.manage` 推出的 `user.view`）。

## Steam 授权

### 等级

| 等级 | 值 | 能力 |
| --- | --- | --- |
| 无 | `none` | 不存记录；不可访问 |
| 只读 | `read` | 会话列表、历史、同步、好友列表、实时消息、Steam 表情列表、图片/贴纸代理、读取表情回应 |
| 聊天 | `chat` | 只读 + 发送文字消息（含 Steam 表情 `:name:`）+ 重试自己的文字发送 |
| 完整 | `full` | 聊天 + 发送图片（含图片表情）、贴纸、聊天效果、添加/取消表情回应 |

- 等级之间严格递增，判断用 `levelAtLeast(grant, 'chat')` 这样的序比较：`none < read < chat < full`。
- 所有等级都要求同时有 `chat.use`。
- `steam.account.all` 的用户视为在每个启用账户上都有 `full` + `all`，不需要授权记录。界面上显示「全部（权限）」。

### 有效期

- `expires_at` 可为空（永久）。到期后视为 `none`，不需要定时任务删除记录；判断时比较 `expires_at > now`。
- 到期时间按 UTC ISO 存储，界面按本地日期显示「至 2026-12-31」。选「至某日」时取该日 23:59:59（本地时区）换算到 UTC。
- 7 天内到期的授权，在授权概览和用户详情里标黄（原型已示意）。
- 到期后已建立的 WS 连接：下一次 WS 请求或广播时就会被拒绝（因为每次都重新检查授权），不额外踢下线。

### 范围

| 范围 | 值 | 含义 |
| --- | --- | --- |
| 全部会话 | `all` | 该账户上的所有好友和群组 |
| 指定好友 | `some` | 只能看到 `user_steam_account_peers` 里列出的好友 SteamID64 |

范围为 `some` 时：

- 只能看到列出的好友：会话列表、历史、同步、好友列表、WS `message` 广播都要过滤。
- 看不到任何群组：`/api/groups` 返回空列表，会话列表里过滤掉群组。
- 不能向范围外的 SteamID 发送，也不能「按 SteamID 新建会话」（原型里新建会话按钮对范围受限用户隐藏）。
- 好友名单为空的 `some` 等同于没有任何会话可见，但 `accessAllowed` 仍为 `true`（用户能看到一个空列表，而不是「无权限」）。界面在保存时提示「未选择任何好友」。
- 好友名单上限 500 个。
- 列表里的 SteamID 不要求当前仍是好友（对方删好友后再加回来，授权仍有效）。

### 账户禁用

Steam 账户被禁用后，所有授权暂不生效（不删除记录）。账户重新启用后授权恢复。原型里禁用账户的授权卡片是灰色的。

## 数据模型

所有变更都放在 `createAuthStore` 启动时的迁移里，沿用 `addColumnIfMissing` 的幂等风格；新表用 `CREATE TABLE IF NOT EXISTS`。

### 新表

```sql
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,                -- 'super' | 'member' | 'r_xxxxxxxx'
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant', 'revoke')),
  updated_by INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_steam_account_peers (
  user_id INTEGER NOT NULL,
  steam_account_id INTEGER NOT NULL,
  peer_steam_id TEXT NOT NULL,        -- SteamID64，17 位数字
  PRIMARY KEY (user_id, steam_account_id, peer_steam_id),
  FOREIGN KEY (user_id, steam_account_id)
    REFERENCES user_steam_accounts(user_id, steam_account_id) ON DELETE CASCADE
);
```

### 已有表的新增列

```sql
-- users：新列，旧 role 列保留（见下）
ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id);

-- user_steam_accounts
ALTER TABLE user_steam_accounts ADD COLUMN level TEXT NOT NULL DEFAULT 'full'
  CHECK (level IN ('read', 'chat', 'full'));
ALTER TABLE user_steam_accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'
  CHECK (scope IN ('all', 'some'));
ALTER TABLE user_steam_accounts ADD COLUMN expires_at TEXT;
ALTER TABLE user_steam_accounts ADD COLUMN updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_steam_accounts ADD COLUMN updated_at TEXT;
```

说明：

- `level` 的默认值是 `full`、`scope` 的默认值是 `all`，这样 `ALTER TABLE` 之后，现有授权自动成为「完整 / 全部会话」，能力不变。新写入的记录总是显式给出这两个值。
- `none` 不存记录：设为「无」就删除这一行（级联删除好友名单）。
- SQLite 的 `ALTER TABLE ADD COLUMN` 支持带常量默认值的 `NOT NULL` 和 `CHECK`；`REFERENCES` 在新列上只能是 `DEFAULT NULL`，与上面一致。

### 保留旧 `users.role` 列

`users.role` 有 `CHECK (role IN ('admin', 'user'))`，SQLite 不能直接去掉约束，重建表风险大。做法：

- 保留 `role` 列，作为**派生的兼容字段**：`role_id = 'super'` 时写 `'admin'`，其他情况写 `'user'`。凡是写 `role_id` 的地方同时写 `role`。
- 任何授权判断都只读 `role_id` 和有效权限，不再读 `role`。
- `PublicUser.role` 继续输出（Android 和旧版前端可能用到），值同上。

### 迁移步骤（一次事务内，幂等）

```sql
INSERT OR IGNORE INTO roles (id, name, description, builtin, created_at, updated_at)
VALUES ('super', '超级管理员', '拥有全部权限，不可修改', 1, :now, :now),
       ('member', '成员', '新用户的默认角色', 1, :now, :now);

-- 只在 member 还没有任何权限时写入默认权限，避免覆盖管理员后来的修改
INSERT INTO role_permissions (role_id, permission)
SELECT 'member', p FROM (SELECT 'chat.use' AS p UNION ALL SELECT 'self.password.change')
WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = 'member');

UPDATE users SET role_id = CASE role WHEN 'admin' THEN 'super' ELSE 'member' END
WHERE role_id IS NULL;

UPDATE user_steam_accounts SET updated_at = granted_at, updated_by = granted_by
WHERE updated_at IS NULL;
```

迁移后在 `app_meta` 写 `auth_schema_version = 2`。迁移不可逆；发布说明里提醒先备份 `auth.db`。

## 会话

- 签名 Cookie 的 payload 目前有 `role`，`validateSession` 校验 `user.role !== payload.role` 时作废。改为：
  - 新签发的 Cookie 不再带 `role`。
  - 校验时忽略 payload 里的 `role`（兼容旧 Cookie，不强制重新登录）。
  - 仍校验 `session_version`。
- 以下操作递增 `session_version`（踢下线）：
  - 禁用用户；
  - 用户在 `super` 和非 `super` 之间切换。
- 以下操作**不**递增：
  - 改角色权限、个人覆盖；
  - 普通角色之间切换；
  - 改 Steam 授权。

  原因：权限和授权每次请求都实时计算，立即生效，不需要踢人。
- `AppSession.user` 增加 `roleId`；`requireAdmin` 删除，全部换成 `requirePermission`。

## 后端结构

`src/auth/store.ts` 新增或替换：

| 函数 | 说明 |
| --- | --- |
| `ALL_PERMISSIONS`、`UserPermission` 类型 | 上表 12 个权限点 |
| `listRoles()` / `getRole(id)` / `createRole()` / `updateRole()` / `deleteRole()` | 角色 CRUD；返回 `memberCount` |
| `effectivePermissions(userOrId)` | 按上面的公式计算 |
| `permissionDetails(userId)` | 带 `source` 的列表 |
| `hasPermission(user, permission)` | 改为基于 `effectivePermissions`，删除基于角色字符串的旧签名 |
| `setPermissionOverrides(userId, overrides, actorId)` | 整体替换 |
| `getSteamGrant(userId, steamAccountId)` | 返回 `{ level, scope, peers, expiresAt, via: 'grant' \| 'all' }` 或 `null`；已过期、账户禁用、无 `chat.use` 都返回 `null` |
| `canAccessSteamAccount(userId, accountId, minLevel = 'read')` | 基于 `getSteamGrant` |
| `canAccessPeer(grant, peerSteamId)` | `scope === 'all'` 或 peer 在名单里 |
| `replaceUserSteamGrants(userId, grants, actorId)` | 新接口，见下 |
| `replaceUserSteamAccounts(userId, ids, actorId)` | 保留，内部转换成 `full / all / 永久` 调用上面的函数（只增删，不降级已有记录的等级） |
| `listSteamGrantOverview()` | 授权概览矩阵数据 |
| `enabledSuperCount()` | 替代 `enabledAdminCount` |

`src/server/chat-service.ts` 的 `SteamAccessContext` 扩展为：

```ts
type SteamAccessContext = {
  session: AppSession | null;
  activeAccount: PublicSteamAccount | null;
  steamAccountId?: string;
  includeLegacy: boolean;          // = hasPermission(user, 'steam.account.all')；legacy 模式为 true
  grant: { level: 'read' | 'chat' | 'full'; scope: 'all' | 'some'; peers: Set<string> } | null;  // legacy 模式为 full/all
};
```

新增两个辅助函数，所有入口都通过它们检查：

- `requireLevel(access, level)`：等级不够时抛 403，`code: 'steam_grant_insufficient'`，并带 `required`。
- `requirePeer(access, peerSteamId)`：不在范围内时抛 403，`code: 'steam_peer_out_of_scope'`。为了不泄露会话是否存在，对历史类读取同样返回 403，而不是空结果。

## HTTP API

所有新接口：

- 返回 `Cache-Control: no-store`；
- 写操作要求 JSON body；
- 写操作成功后写审计日志（见「审计」）。

### 当前用户

`GET /api/auth/me`（以及 login/setup 的响应）：

```json
{
  "ok": true,
  "user": { "id": 2, "username": "kefu01", "displayName": "客服一号", "role": "user", "roleId": "r_k3m9x2qa", "roleName": "客服", "...": "..." },
  "permissions": ["chat.use", "emote.manage", "self.password.change"],
  "permissionDetails": [{ "permission": "emote.manage", "effective": true, "source": "grant" }],
  "steam": {
    "...": "现有字段",
    "accessAllowed": true,
    "steamGrant": { "level": "chat", "scope": "some", "peerCount": 3, "expiresAt": "2026-12-31T15:59:59.000Z", "via": "grant" }
  }
}
```

- `permissions` 改为有效权限（以前是角色权限）。
- `steam.steamGrant` 是当前用户在**活动账户**上的授权；无权访问时为 `null`。
- 前端「设置 → 我的权限」和输入框状态都依赖它。
- `steam.activeAccount`：原来对 admin 总是返回，改为 `accessAllowed || hasPermission('steam.manage')`。

`GET /api/steam/status` 的 `steamGrant` 同上，WS 推送的 `steam_status`（如果有）也一并带上。

### 角色

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/roles` | `user.view` 或 `role.manage` | `{ roles: [{ id, name, description, builtin, permissions, memberCount, editable, deletable }], permissions: ALL_PERMISSIONS }` |
| POST | `/api/roles` | `role.manage` | body `{ name, description?, permissions: string[] }` → 201 `{ role }` |
| PATCH | `/api/roles/:id` | `role.manage` | body 任意子集 `{ name, description, permissions }`；`super` → 400；`member` 可改权限和说明、不能改名 |
| DELETE | `/api/roles/:id` | `role.manage` | 内置 → 400；有成员 → 409 `{ error, memberCount }` |

### 用户

| 方法 | 路径 | 权限 | 变化 |
| --- | --- | --- | --- |
| GET | `/api/users` | `user.view` | 原为 `user.manage`；每个用户增加 `roleId`、`roleName`、`overrideCount`、`steamGrantSummary: [{ steamAccountId, level, scope, peerCount, expiresAt }]`；`role` 过滤参数改名 `roleId`（旧值 `admin`/`user` 映射为 `super`/`member`） |
| POST | `/api/users` | `user.manage`；body 带非默认 `roleId` 时还要 `role.manage` | body 新增 `roleId`（默认 `member`），兼容旧 `role: 'admin'\|'user'`；`steamAccountIds` 仍可用（= 完整/全部）或改传 `steamGrants`（格式见下） |
| PATCH | `/api/users/:id` | `user.manage`；body 含 `roleId`/`role` 时还要 `role.manage` | 见「防提权」 |
| GET | `/api/users/:id/permissions` | `user.view` | `{ roleId, overrides: [{ permission, effect }], details: [...] }` |
| PUT | `/api/users/:id/permission-overrides` | `role.manage` | body `{ overrides: [{ permission, effect: 'grant'\|'revoke' }] }`，整体替换；`inherit` 就是不出现在列表里 |
| GET | `/api/users/:id/steam-accounts` | `user.view` | 返回 `{ steamAccounts, grants: [{ steamAccountId, level, scope, peers, expiresAt, updatedAt, updatedBy }] }`；`steamAccounts` 保持旧格式 |
| PUT | `/api/users/:id/steam-accounts` | `steam.grant.manage` | 两种 body，见下 |
| GET | `/api/steam/grants` | `steam.grant.manage` 或 `user.view` | 授权概览：`{ accounts: [...], users: [{ id, username, displayName, all: boolean, grants: {[accountId]: { level, scope, peerCount, expiresAt }} }] }` |

`PUT /api/users/:id/steam-accounts` body：

```jsonc
// 新格式：整体替换该用户的全部授权；未出现的账户 = none
{ "grants": [
  { "steamAccountId": 1, "level": "chat", "scope": "some", "peers": ["76561198040000001"], "expiresAt": "2026-12-31T15:59:59.000Z" },
  { "steamAccountId": 2, "level": "read", "scope": "all", "expiresAt": null }
] }

// 旧格式（Web 旧版本、脚本）：仍然接受
{ "steamAccountIds": [1, 2] }
```

校验：

- `level` 只能是 `read` / `chat` / `full`。
- `scope === 'all'` 时 `peers` 必须为空或省略。
- `peers` 每项是 17 位数字，去重后最多 500 个。
- `expiresAt` 必须是将来的时间或 `null`。
- 账户不存在 → 400。

### 图片表情

`POST /api/image-emotes` 的 `requireAdminSession` 改为 `requirePermission('emote.manage')`。`GET` 仍然只要 `chat.use`。

### 审计

`GET /api/audit-logs` 增加过滤参数 `category`，取值：

分类与原型「审计日志」页的筛选标签一一对应：

| category | 标签 | 包含的 action |
| --- | --- | --- |
| `grant` | Steam 授权 | `steam_account.grant_*` |
| `role` | 角色与权限 | `role.*`、`user.role.change`、`user.permission_overrides.update` |
| `user` | 用户 | 其余 `user.*` |
| `steam` | Steam | `steam.*`、`steam_account.*`（不含 `grant_*`） |
| `session` | 会话 | `auth.*`、`session.*` |

另外支持 `query` 参数：在操作者用户名、action、`target_id` 和 IP 中做子串匹配。

## 接口执行矩阵

「级别」指 Steam 授权等级，所有行都隐含要求 `chat.use`（Steam 管理类除外）。「范围」列为 ✓ 表示要按 `scope=some` 的好友名单过滤或拒绝。

### HTTP

| 接口 | 现在 | v2 级别 | 范围 |
| --- | --- | --- | --- |
| `GET /api/friends` | 账户访问 | `read` | 过滤列表 |
| `GET /api/groups` | 账户访问 | `read` | `some` 时返回 `[]` |
| `GET /api/emoticons` | 账户访问 | `read` | — |
| `GET /history`、`/api/history` | 账户访问 | `read` | `id` 不在名单 → 403；无 `id` 的全局查询 → 过滤 |
| `GET /conversations`、`/api/conversations` | 账户访问 | `read` | 过滤（去掉群组和名单外） |
| `GET /api/messages/sync` | 账户访问 | `read` | 过滤每条 `item.id`；游标照常前进（被过滤的条目不返回，但游标越过它们） |
| `GET /api/history/status` | 无 | 需要 `chat.use` | — |
| `GET /proxy/image`、`/proxy/sticker/*` | 账户访问 | `read` | — |
| `GET /api/message-reactions` | 账户访问 | `read` | 消息所属会话不在名单 → 403 |
| `POST /api/message-reactions` | 账户访问 | `full` | ✓ |
| `POST /`、`/message` | 账户访问（缺 `chat.use`） | `chat`；文本以 `/sticker`、`/roomeffect` 开头或含 `[sticker`、`[roomeffect` BBCode 时要 `full` | ✓ `body.id` |
| `POST /image`、`/img` | 账户访问（缺 `chat.use`） | `full` | ✓ |
| `POST /api/send-operations`、`/upload` | `chat.use` + 账户访问 | `full` | ✓ `body.id` |
| `/api/send-operations/:id/*` | owner 校验 | `full`（`sendAuthorization` 每次回调都重新检查） | ✓ |
| `GET /api/bilibili/resolve` | `chat.use` | 不变 | — |
| `GET /api/image-emotes*` | `chat.use` | 不变 | — |
| `POST /api/image-emotes` | admin | `emote.manage` | — |
| Steam 登录/Guard/切换/退出 | `steam.manage` | 不变 | — |
| `PATCH/DELETE /api/steam/accounts/:id` | `steam.account.manage` | 不变 | — |

### WebSocket

| 类型 | v2 级别 | 范围 |
| --- | --- | --- |
| `ping` | 只要会话有效 | — |
| `send_message` / `msg` | `chat`；贴纸/效果文本要 `full` | ✓ `payload.id` |
| `send_image` / `img` | `full` | ✓ |
| `get_history*` / `history` | `read` | 同 HTTP |
| `get_conversations*` / `conversations` | `read` | 同 HTTP |
| `get_emoticons` | `read` | — |
| `get_friends` | `read` | 过滤 |
| `get_groups` | `read` | `some` 时 `[]` |
| 广播 `message` | `read` | `canWsReceive(ws, item)`：除了现在的账户检查，再检查 `canAccessPeer(grant, item.id)` |

实现要点：

- `canWsReceiveActiveAccount(ws)` 改成 `canWsReceive(ws, item?)`。`broadcast` 对 `type === 'message'` 的 payload 传入 `item`，其他类型的广播只检查账户。
- 所有现有的 `authorize` 回调（发送过程中重新检查权限的闭包）都要包含等级和范围检查，保证发送中途被降级或移出名单时立即停止。
- 贴纸/效果的判断写成一个函数 `requiresFullLevel(text)`：

  ```ts
  /^\s*\/(sticker|roomeffect)(\s|$)/i.test(text) || /\[(sticker|roomeffect)\b/i.test(text)
  ```

  在 `sendTextMessage` 进入 `withSteamRetry` 之前调用。
- 错误响应格式沿用现有的 `{ error, statusCode }`，增加 `code` 和 `required`，前端据此显示「需要『完整』授权」之类的文案。

## 防提权与一致性

全部在 store 层执行，接口层不重复判断：

1. 改变用户角色（`roleId`）需要 `role.manage`；只有 `user.manage` 的人带着 `roleId` 调 PATCH → 403。
2. 不能修改自己的角色和个人覆盖（403 `code: 'self_escalation'`）。用户仍可以改自己的资料和密码。
3. 不能授予自己没有的权限：
   - 非超级管理员新建或编辑角色时，`permissions` 必须是自己有效权限的子集；
   - 非超级管理员设置 `grant` 覆盖时，同样必须是自己有效权限的子集；
   - 只有超级管理员能把用户设为 `super` 或修改 `super` 用户。
4. 至少保留一个启用的超级管理员：以下操作若会让启用的 `super` 数量变为 0，返回 409：
   - 禁用、删除最后一个 `super`；
   - 把最后一个 `super` 改成其他角色。
5. 分配 Steam 授权需要 `steam.grant.manage`。非超级管理员只能分配不高于自己在该账户上的等级；有 `steam.account.all` 的人视为 `full`。
6. 删除角色前检查成员数；删除用户时级联删除覆盖和授权（外键已处理）。
7. 角色名、权限点、等级、范围值全部白名单校验。

## 审计

新增或调整的 action：

| action | target | detail |
| --- | --- | --- |
| `role.create` | role | `{ name, permissions }` |
| `role.update` | role | `{ changes }` |
| `role.delete` | role | `{ name }` |
| `user.role.change` | user | `{ changes: [{ field: 'role', before: '成员', after: '客服' }] }` |
| `user.permission_overrides.update` | user | `{ changes: [{ field: 'emote.manage', before: 'inherit', after: 'grant' }] }` |
| `steam_account.grant_update` | user | `{ steamAccountId, changes: [...] }`，每个账户一条 |
| `steam_account.grant_replace` | user | 保留给旧格式 PUT |
| `user.update` | user | 改为 `{ changes }`，不再直接存整个 body |

`changes` 的统一格式：

```json
{ "changes": [ { "field": "level", "before": "read", "after": "chat" },
               { "field": "peers", "before": ["7656…01"], "after": ["7656…01", "7656…02"] },
               { "field": "expiresAt", "before": null, "after": "2026-12-31T15:59:59.000Z" } ] }
```

- 前端的审计详情（原型「审计日志」展开后的 字段 / 之前 / 之后 表）直接渲染 `changes`。
- 旧记录没有 `changes` 时，前端退回到列出 detail 的键值。
- `sanitizeAuditDetail` 继续过滤敏感键。

## 兼容性

- **Android**：只依赖 `steam.accessAllowed`、`activeAccount` 和历史/同步接口。
  - 范围过滤在服务端完成，Android 无需改动就只会看到名单内的会话。
  - 只读用户发送会得到 403 + `code: 'steam_grant_insufficient'`；Android 现有错误提示会显示服务端的 `error` 文本，所以服务端文案要可读（例如「当前授权为只读，不能发送消息」）。
  - Android 侧按等级隐藏输入框是后续工作，不在本次范围。
- **旧版 Web**（部署过渡期浏览器里缓存的 `app.js`）：
  - `user.role` 仍是 `admin` / `user`；
  - `permissions` 仍是数组；
  - `PUT steam-accounts` 仍接受 `steamAccountIds`。

  不会崩溃，只是看不到新功能。
- **Legacy 模式**（没有 `sessionManager`）：`grant` 恒为 `full / all`，`includeLegacy = true`，行为不变。

## 测试要求

在 `test/backend-auth.test.ts` 和 `test/backend-service.test.ts` 的现有风格上补充：

- 迁移：
  - 旧库（只有 `role`、旧 `user_steam_accounts`）启动后，`role_id`、`level=full`、`scope=all` 正确；
  - 二次启动幂等；
  - `member` 权限被修改后再次启动不被重置。
- 有效权限：
  - 角色 ∪ 授予 − 收回；
  - `super` 忽略覆盖；
  - `user.manage` 推出 `user.view`；
  - `source` 正确。
- 角色 CRUD：
  - 内置角色的限制；
  - 有成员不能删；
  - 名称唯一。
- 防提权：
  - 第 1–5 条每条至少一个用例；
  - 「最后一个超级管理员」的禁用、删除、降级。
- 会话：
  - 旧 Cookie（带 `role`）仍有效；
  - `super` ↔ 非 `super` 时会话失效；
  - 改权限不失效但立即生效。
- Steam 等级：
  - `read` 发文字 403；
  - `chat` 发文字成功、发图片 403；
  - `chat` 发 `/sticker xxx` 和 `[roomeffect …]` 403；
  - `full` 全部成功；
  - 表情回应 GET 要 `read`、POST 要 `full`。
- 有效期：过期授权等同 `none`（用可注入的时钟）。
- 范围：
  - 好友、会话、历史、同步被过滤；
  - 名单外的 `history?id=` 返回 403；
  - 群组为空；
  - 发给名单外 403；
  - WS 广播只发给名单内的连接；
  - 发送中途把对方移出名单，`authorize` 回调抛错。
- 账户禁用：授权暂停，重新启用后恢复。
- 兼容：
  - `PUT steam-accounts {steamAccountIds}` 仍可用，并且不会把已有的 `chat` 授权升成 `full`；
  - `/api/auth/me` 仍有 `role`；
  - legacy 模式不受影响。
- `chat.use` 被收回：所有聊天读写 403，`accessAllowed=false`。

## 落地顺序

1. **后端模型**：迁移、`effectivePermissions`、角色 CRUD、覆盖、分级授权存储、防提权。保持所有旧接口格式。
2. **后端执行**：
   - 替换所有 `role === 'admin'` 和 `requireAdmin*`；
   - 加 `requireLevel` / `requirePeer`；
   - 补 `chat.use` 漏检；
   - 广播过滤；
   - `steamGrant` 输出。

   这一步结束时旧前端仍可用。
3. **新接口**：`/api/roles`、`/permissions`、`/permission-overrides`、新格式 grants、`/api/steam/grants`、审计 `changes` 和 `category`。
4. **前端**：按 `docs/web-redesign.md` 重做界面，接入上面的接口。
5. **Android**（后续，可选）：按 `steamGrant.level` 隐藏发送入口。

每一步单独提交，并保证 `npm test` 通过。
