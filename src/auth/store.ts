'use strict';

import type { DatabaseSync } from 'node:sqlite';
import type { UnknownRecord } from '../types';
import { isRecord } from '../types';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync: NodeDatabaseSync } = require('node:sqlite');
const { AUTH_DB_PATH } = require('../paths');

type SQLRow = Record<string, unknown>;

export type UserRole = 'admin' | 'user';

export const ALL_PERMISSIONS = [
  'user.view', 'user.manage', 'role.manage', 'session.manage', 'audit.view',
  'steam.manage', 'steam.account.manage', 'steam.grant.manage', 'steam.account.all',
  'chat.use', 'emote.manage', 'self.password.change'
] as const;
export type UserPermission = typeof ALL_PERMISSIONS[number];
export type PermissionOverride = { permission: UserPermission; effect: 'grant' | 'revoke' };
export type PermissionDetail = { permission: UserPermission; effective: boolean; source: 'super' | 'role' | 'grant' | 'revoke' | 'none' | 'implied' };
export type PublicRole = {
  id: string; name: string; description: string; builtin: boolean;
  permissions: UserPermission[]; memberCount: number; editable: boolean; deletable: boolean;
  createdBy: number | null; createdAt: string; updatedAt: string;
};
export type SteamGrantLevel = 'read' | 'chat' | 'full';
export type SteamGrant = { level: SteamGrantLevel; scope: 'all' | 'some'; peers: Set<string>; expiresAt: string | null; via: 'grant' | 'all' };
export type UserSteamGrant = {
  steamAccountId: number; level: SteamGrantLevel; scope: 'all' | 'some'; peers: string[];
  expiresAt: string | null; updatedAt: string; updatedBy: number | null;
};
export type AuditChange = { field: string; before: unknown; after: unknown };
type Actor = number | Pick<PublicUser, 'id'>;

export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  note: string;
  role: UserRole;
  roleId: string;
  roleName: string;
  overrideCount: number;
  steamGrantSummary: Array<Omit<UserSteamGrant, 'peers' | 'updatedAt' | 'updatedBy'> & { peerCount: number }>;
  disabled: boolean;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  lastSeenAt: string | null;
  passwordChangedAt: string | null;
  forcePasswordChange: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  locked: boolean;
  createdBy: number | null;
  steamAccountCount: number;
};

type UserRow = PublicUser & {
  passwordHash: string;
};

export type PublicUserSession = {
  id: string;
  userId: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: number | null;
  ip: string | null;
  userAgent: string | null;
};

export type PublicSteamAccount = {
  id: number;
  steamId: string;
  label: string;
  accountNameHint: string;
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  refreshTokenUpdatedAt: string | null;
  authorizedUserCount: number;
  active: boolean;
};

type SteamAccountRow = PublicSteamAccount & {
  refreshToken: string | null;
};

export type PublicAuditLog = {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: UnknownRecord;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
};

type AuthStoreOptions = {
  dbPath?: string;
  database?: DatabaseSync;
  now?: () => number;
};

type RequestContext = {
  ip?: string | null;
  userAgent?: string | null;
};

type SessionCreateInput = RequestContext & {
  expiresAt: string;
};

type UserListFilters = {
  query?: unknown;
  role?: unknown;
  roleId?: unknown;
  status?: unknown;
};

type AuditListFilters = {
  category?: unknown;
  query?: unknown;
  action?: unknown;
  targetType?: unknown;
  actorUserId?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
};

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const PASSWORD_MIN_LENGTH = 8;
const HASH_PREFIX = 'scrypt:v1';
const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60 * 1000;
const TOUCH_THROTTLE_MS = 60 * 1000;

const ROLE_PERMISSIONS: Record<UserRole, UserPermission[]> = {
  admin: [...ALL_PERMISSIONS],
  user: [
    'chat.use',
    'self.password.change'
  ]
};

const SENSITIVE_DETAIL_KEYS = new Set([
  'password',
  'oldPassword',
  'newPassword',
  'refreshToken',
  'refresh_token',
  'steamGuard',
  'steamGuardCode',
  'code',
  'guardCode'
]);

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value || 0);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = asNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function futureIso(msFromNow: number) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function isFutureIso(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function validateUsername(username: unknown): string {
  const value = String(username || '').trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw httpError(400, 'Username must be 3-64 characters and contain only letters, numbers, underscores, hyphens, or dots');
  }
  return value;
}

function validatePassword(password: unknown): string {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  return value;
}

function validateRole(role: unknown): UserRole {
  if (role === 'admin' || role === 'user') return role;
  throw httpError(400, 'Role must be admin or user');
}

function validateShortText(value: unknown, field: string, maxLength: number): string {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw httpError(400, `${field} is too long`);
  return text;
}

function sanitizeSteamId(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[0-9]{3,32}$/.test(text)) throw httpError(400, 'steamId must be numeric');
  return text;
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => Math.floor(Number(item))).filter((item) => Number.isFinite(item) && item > 0);
  return [...new Set(ids)];
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `${HASH_PREFIX}:${salt}:${hash}`;
}

function verifyPassword(password: unknown, stored: unknown): boolean {
  const text = String(stored || '');
  const [scheme, version, salt, expected] = text.split(':');
  if (`${scheme}:${version}` !== HASH_PREFIX || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64).toString('base64url');
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseJsonObject(value: unknown): UnknownRecord {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function sanitizeAuditDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditDetail(item));
  if (!isRecord(value)) return value;
  const result: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_DETAIL_KEYS.has(key) || ((key === 'before' || key === 'after') && SENSITIVE_DETAIL_KEYS.has(String(value.field)))
      ? '[redacted]' : sanitizeAuditDetail(item);
  }
  return result;
}

function permissionsForRole(role: UserRole): UserPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function levelAtLeast(grant: Pick<SteamGrant, 'level'> | SteamGrantLevel | 'none' | null, minimum: SteamGrantLevel | 'none'): boolean {
  const levels = ['none', 'read', 'chat', 'full'];
  const level = typeof grant === 'string' ? grant : grant?.level || 'none';
  return levels.includes(level) && levels.includes(minimum) && levels.indexOf(level) >= levels.indexOf(minimum);
}

export function canAccessPeer(grant: Pick<SteamGrant, 'scope' | 'peers'> | null, peerSteamId: string): boolean {
  return !!grant && (grant.scope === 'all' || grant.peers.has(peerSteamId));
}

/**
 * Authorization v2 model API:
 * - Sensitive writes take actorId (or { id }); actors are always reloaded from DB.
 * - createUser also accepts the legacy input.createdBy actor; only createInitialAdmin
 *   can bootstrap without an actor. Password resets take options.actorId or arg 4.
 * - effectivePermissions/hasPermission accept a user or ID, never a role string.
 * - getSteamGrant returns live access with Set peers; listUserSteamGrants returns
 *   configured records with array peers, including expired/disabled-account grants.
 * - Role/override/grant updates and user.update/user.role.change audits are atomic.
 */
function createAuthStore(options: AuthStoreOptions = {}) {
  const now = options.now || Date.now;
  const nowIso = () => new Date(now()).toISOString();
  const dbPath = options.dbPath || AUTH_DB_PATH;
  if (!options.database && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db: DatabaseSync = options.database || new NodeDatabaseSync(dbPath, { timeout: 5000 });

  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

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
  `);

  function columnsFor(table: string): Set<string> {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row: SQLRow) => String(row.name)));
  }

  function addColumnIfMissing(table: string, column: string, sql: string) {
    if (!columnsFor(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
  addColumnIfMissing('users', 'display_name', "display_name TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('users', 'note', "note TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('users', 'created_by', 'created_by INTEGER');
  addColumnIfMissing('users', 'last_login_ip', 'last_login_ip TEXT');
  addColumnIfMissing('users', 'last_seen_at', 'last_seen_at TEXT');
  addColumnIfMissing('users', 'password_changed_at', 'password_changed_at TEXT');
  addColumnIfMissing('users', 'force_password_change', 'force_password_change INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'failed_login_count', 'failed_login_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'locked_until', 'locked_until TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id INTEGER NOT NULL, permission TEXT NOT NULL, effect TEXT NOT NULL CHECK (effect IN ('grant', 'revoke')),
      updated_by INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, permission),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  addColumnIfMissing('users', 'role_id', 'role_id TEXT REFERENCES roles(id)');
  addColumnIfMissing('user_steam_accounts', 'level', "level TEXT NOT NULL DEFAULT 'full' CHECK (level IN ('read', 'chat', 'full'))");
  addColumnIfMissing('user_steam_accounts', 'scope', "scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'some'))");
  addColumnIfMissing('user_steam_accounts', 'expires_at', 'expires_at TEXT');
  addColumnIfMissing('user_steam_accounts', 'updated_by', 'updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumnIfMissing('user_steam_accounts', 'updated_at', 'updated_at TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_steam_account_peers (
      user_id INTEGER NOT NULL, steam_account_id INTEGER NOT NULL, peer_steam_id TEXT NOT NULL,
      PRIMARY KEY (user_id, steam_account_id, peer_steam_id),
      FOREIGN KEY (user_id, steam_account_id) REFERENCES user_steam_accounts(user_id, steam_account_id) ON DELETE CASCADE
    );
  `);
  const migrationAt = nowIso();
  db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, builtin, created_at, updated_at)
    VALUES ('super', '超级管理员', '拥有全部权限，不可修改', 1, ?, ?), ('member', '成员', '新用户的默认角色', 1, ?, ?)`)
    .run(migrationAt, migrationAt, migrationAt, migrationAt);
  // Seed once: an intentionally empty member role must stay empty on subsequent starts.
  if (getMeta('auth_schema_version') !== '2' && !db.prepare("SELECT 1 FROM role_permissions WHERE role_id = 'member'").get()) {
    for (const permission of ROLE_PERMISSIONS.user) {
      db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('member', ?)").run(permission);
    }
  }
  db.exec(`
    UPDATE users SET role_id = CASE role WHEN 'admin' THEN 'super' ELSE 'member' END WHERE role_id IS NULL;
    UPDATE users SET role = CASE role_id WHEN 'super' THEN 'admin' ELSE 'user' END;
    UPDATE user_steam_accounts SET updated_at = granted_at, updated_by = granted_by WHERE updated_at IS NULL;
  `);
  setMeta('auth_schema_version', '2');
  db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  function transaction<T>(operation: () => T): T {
    // SAVEPOINT also composes user creation and grant replacement atomically.
    db.exec('SAVEPOINT auth_write');
    try {
      const result = operation();
      db.exec('RELEASE auth_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO auth_write');
      db.exec('RELEASE auth_write');
      throw error;
    }
  }

  function steamAccountCountForUser(userId: unknown): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM user_steam_accounts WHERE user_id = ?').get(asNumber(userId));
    return asNumber(row?.count);
  }

  function userFromRow(row: SQLRow | undefined): UserRow | null {
    if (!row) return null;
    const lockedUntil = textOrNull(row.locked_until);
    return {
      id: asNumber(row.id),
      username: String(row.username || ''),
      passwordHash: String(row.password_hash || ''),
      displayName: String(row.display_name || ''),
      note: String(row.note || ''),
      role: row.role_id === 'super' ? 'admin' : 'user',
      roleId: String(row.role_id),
      roleName: String(db.prepare('SELECT name FROM roles WHERE id = ?').get(String(row.role_id))?.name || ''),
      overrideCount: asNumber(db.prepare('SELECT COUNT(*) AS count FROM user_permission_overrides WHERE user_id = ?').get(asNumber(row.id))?.count),
      steamGrantSummary: listUserSteamGrants(row.id).map(({ peers, updatedAt: _at, updatedBy: _by, ...grant }) => ({ ...grant, peerCount: peers.length })),
      disabled: Boolean(asNumber(row.disabled)),
      sessionVersion: asNumber(row.session_version),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
      lastLoginAt: textOrNull(row.last_login_at),
      lastLoginIp: textOrNull(row.last_login_ip),
      lastSeenAt: textOrNull(row.last_seen_at),
      passwordChangedAt: textOrNull(row.password_changed_at),
      forcePasswordChange: Boolean(asNumber(row.force_password_change)),
      failedLoginCount: asNumber(row.failed_login_count),
      lockedUntil,
      locked: isFutureIso(lockedUntil),
      createdBy: asNullableNumber(row.created_by),
      steamAccountCount: steamAccountCountForUser(row.id)
    };
  }

  function publicUser(user: UserRow): PublicUser {
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }

  function sessionFromRow(row: SQLRow | undefined): PublicUserSession | null {
    if (!row) return null;
    return {
      id: String(row.id || ''),
      userId: asNumber(row.user_id),
      createdAt: String(row.created_at || ''),
      lastSeenAt: String(row.last_seen_at || ''),
      expiresAt: String(row.expires_at || ''),
      revokedAt: textOrNull(row.revoked_at),
      revokedBy: asNullableNumber(row.revoked_by),
      ip: textOrNull(row.ip),
      userAgent: textOrNull(row.user_agent)
    };
  }

  function activeSteamAccountId(): number | null {
    const value = Number.parseInt(String(getMeta('active_steam_account_id') || ''), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function steamAccountFromRow(row: SQLRow | undefined): SteamAccountRow | null {
    if (!row) return null;
    const activeId = activeSteamAccountId();
    return {
      id: asNumber(row.id),
      steamId: String(row.steam_id || ''),
      label: String(row.label || ''),
      accountNameHint: String(row.account_name_hint || ''),
      refreshToken: textOrNull(row.refresh_token),
      refreshTokenUpdatedAt: textOrNull(row.refresh_token_updated_at),
      enabled: Boolean(asNumber(row.enabled)),
      createdBy: asNullableNumber(row.created_by),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
      lastLoginAt: textOrNull(row.last_login_at),
      lastActiveAt: textOrNull(row.last_active_at),
      authorizedUserCount: asNumber(row.authorized_user_count),
      active: activeId === asNumber(row.id)
    };
  }

  function publicSteamAccount(account: SteamAccountRow): PublicSteamAccount {
    const { refreshToken: _refreshToken, ...safeAccount } = account;
    return safeAccount;
  }

  function auditLogFromRow(row: SQLRow): PublicAuditLog {
    return {
      id: asNumber(row.id),
      actorUserId: asNullableNumber(row.actor_user_id),
      actorUsername: textOrNull(row.actor_username),
      action: String(row.action || ''),
      targetType: String(row.target_type || ''),
      targetId: String(row.target_id || ''),
      detail: parseJsonObject(row.detail_json),
      ip: textOrNull(row.ip),
      userAgent: textOrNull(row.user_agent),
      createdAt: String(row.created_at || '')
    };
  }

  function getUserById(id: unknown): UserRow | null {
    return userFromRow(db.prepare('SELECT * FROM users WHERE id = ?').get(asNumber(id)));
  }

  function getUserByUsername(username: unknown): UserRow | null {
    return userFromRow(db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()));
  }

  function countUsers(): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
    return asNumber(row?.count);
  }

  function enabledSuperCount(): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role_id = 'super' AND disabled = 0").get();
    return asNumber(row?.count);
  }

  function ensureCanRemoveAdmin(user: UserRow) {
    if (user.roleId === 'super' && !user.disabled && enabledSuperCount() <= 1) {
      throw httpError(409, 'Cannot remove the last enabled admin');
    }
  }

  function resolveUser(userOrId: unknown): UserRow | null {
    return getUserById(isRecord(userOrId) ? userOrId.id : userOrId);
  }

  function validatePermission(value: unknown): UserPermission {
    if (!ALL_PERMISSIONS.includes(value as UserPermission)) throw httpError(400, `Unknown permission: ${String(value)}`);
    return value as UserPermission;
  }

  function permissionList(value: unknown): UserPermission[] {
    if (!Array.isArray(value)) throw httpError(400, 'permissions must be an array');
    const selected = new Set(value.map(validatePermission));
    return ALL_PERMISSIONS.filter((permission) => selected.has(permission));
  }

  function rolePermissions(roleId: string): UserPermission[] {
    if (roleId === 'super') return [...ALL_PERMISSIONS];
    const rows = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(roleId);
    return ALL_PERMISSIONS.filter((permission) => rows.some((row) => row.permission === permission));
  }

  // Compatibility helper; store callers still see current role permissions after edits.
  function permissionsForRole(role: string): UserPermission[] {
    return rolePermissions(role === 'admin' ? 'super' : role === 'user' ? 'member' : role);
  }

  function getPermissionOverrides(userId: unknown): PermissionOverride[] {
    return db.prepare('SELECT permission, effect FROM user_permission_overrides WHERE user_id = ? ORDER BY permission')
      .all(asNumber(userId)).map((row) => ({ permission: row.permission as UserPermission, effect: row.effect as 'grant' | 'revoke' }));
  }

  function permissionDetails(userId: unknown): PermissionDetail[] {
    const user = resolveUser(userId);
    if (!user) throw httpError(404, 'User not found');
    const base = new Set(rolePermissions(user.roleId));
    const overrides = new Map(getPermissionOverrides(user.id).map((item) => [item.permission, item.effect]));
    const details: PermissionDetail[] = ALL_PERMISSIONS.map((permission) => {
      const effect = overrides.get(permission);
      const source = user.roleId === 'super' ? 'super' : effect || (base.has(permission) ? 'role' : 'none');
      return { permission, source, effective: source === 'super' || source === 'grant' || source === 'role' };
    });
    const view = details.find((detail) => detail.permission === 'user.view')!;
    if (!view.effective && details.some((detail) => detail.permission === 'user.manage' && detail.effective)) {
      view.effective = true;
      view.source = 'implied';
    }
    return details;
  }

  function effectivePermissions(userOrId: unknown): UserPermission[] {
    return permissionDetails(userOrId).filter((detail) => detail.effective).map((detail) => detail.permission);
  }

  function hasPermission(userOrId: unknown, permission: UserPermission): boolean {
    validatePermission(permission);
    const user = resolveUser(userOrId);
    return !!user && !user.disabled && effectivePermissions(user.id).includes(permission);
  }

  function requireActor(actorId: unknown, permission: UserPermission): UserRow {
    const actor = resolveUser(actorId);
    if (!actor || actor.disabled || !hasPermission(actor.id, permission)) throw httpError(403, 'Forbidden');
    return actor;
  }

  function protectSuper(user: UserRow, actor: UserRow) {
    if (user.roleId === 'super' && actor.roleId !== 'super') throw httpError(403, 'Only a super administrator can modify a super user');
  }

  function forbidSelf(user: UserRow, actor: UserRow) {
    if (user.id === actor.id) throw Object.assign(httpError(403, 'Cannot change your own role or permission overrides'), { code: 'self_escalation' });
  }

  function checkPermissionSubset(permissions: UserPermission[], actor: UserRow) {
    if (actor.roleId !== 'super' && permissions.some((permission) => !hasPermission(actor.id, permission))) {
      throw httpError(403, 'Cannot grant permissions you do not have');
    }
  }

  function getRole(id: unknown): PublicRole | null {
    const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(String(id));
    if (!row) return null;
    const memberCount = asNumber(db.prepare('SELECT COUNT(*) AS count FROM users WHERE role_id = ?').get(String(id))?.count);
    return {
      id: String(row.id), name: String(row.name), description: String(row.description), builtin: !!row.builtin,
      permissions: rolePermissions(String(row.id)), memberCount, editable: row.id !== 'super', deletable: !row.builtin && memberCount === 0,
      createdBy: asNullableNumber(row.created_by), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  function listRoles(): PublicRole[] {
    return db.prepare("SELECT id FROM roles ORDER BY CASE id WHEN 'super' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, created_at, id")
      .all().map((row) => getRole(row.id)!);
  }

  function validateRoleName(value: unknown, exceptId?: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 32) throw httpError(400, 'Role name must be 1-32 characters');
    const name = value.trim();
    const existing = db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(name);
    if (existing && existing.id !== exceptId) throw httpError(409, 'Role name already exists');
    return name;
  }

  function writeRolePermissions(id: string, permissions: UserPermission[]) {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    for (const permission of permissions) db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(id, permission);
  }

  function auditChanges(actorId: number, action: string, targetType: string, targetId: unknown, changes: AuditChange[], extra: UnknownRecord = {}) {
    recordAudit({ actorUserId: actorId, action, targetType, targetId, detail: { ...extra, changes } });
  }

  function changesBetween(before: UnknownRecord, after: UnknownRecord): AuditChange[] {
    return Object.keys(after).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map((field) => ({ field, before: before[field], after: after[field] }));
  }

  function createRole(input: UnknownRecord, actorId: Actor): PublicRole {
    const actor = requireActor(actorId, 'role.manage');
    const name = validateRoleName(input.name);
    const description = validateShortText(input.description, 'description', 200);
    const permissions = permissionList(input.permissions);
    checkPermissionSubset(permissions, actor);
    return transaction(() => {
      let id: string;
      do { id = `r_${crypto.randomBytes(8).toString('hex').slice(0, 8)}`; } while (getRole(id));
      const at = nowIso();
      db.prepare('INSERT INTO roles (id, name, description, builtin, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(id, name, description, actor.id, at, at);
      writeRolePermissions(id, permissions);
      recordAudit({ actorUserId: actor.id, action: 'role.create', targetType: 'role', targetId: id, detail: { name, permissions } });
      return getRole(id)!;
    });
  }

  function updateRole(id: string, patch: UnknownRecord, actorId: Actor): PublicRole {
    const actor = requireActor(actorId, 'role.manage');
    const role = getRole(id);
    if (!role) throw httpError(404, 'Role not found');
    if (id === 'super') throw httpError(400, 'Cannot modify the super role');
    const name = patch.name === undefined ? role.name : validateRoleName(patch.name, id);
    if (id === 'member' && name !== role.name) throw httpError(400, 'Cannot rename the member role');
    const description = patch.description === undefined ? role.description : validateShortText(patch.description, 'description', 200);
    const permissions = patch.permissions === undefined ? role.permissions : permissionList(patch.permissions);
    checkPermissionSubset(permissions, actor);
    return transaction(() => {
      db.prepare('UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, nowIso(), id);
      writeRolePermissions(id, permissions);
      auditChanges(actor.id, 'role.update', 'role', id, changesBetween({ name: role.name, description: role.description, permissions: role.permissions }, { name, description, permissions }));
      return getRole(id)!;
    });
  }

  function deleteRole(id: string, actorId: Actor): void {
    const actor = requireActor(actorId, 'role.manage');
    const role = getRole(id);
    if (!role) throw httpError(404, 'Role not found');
    if (role.builtin) throw httpError(400, 'Cannot delete a builtin role');
    if (role.memberCount) throw Object.assign(httpError(409, 'Role still has members'), { memberCount: role.memberCount });
    transaction(() => {
      db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      recordAudit({ actorUserId: actor.id, action: 'role.delete', targetType: 'role', targetId: id, detail: { name: role.name } });
    });
  }

  function setPermissionOverrides(userId: unknown, overrides: unknown, actorId: Actor): PermissionOverride[] {
    const actor = requireActor(actorId, 'role.manage');
    const user = getUserById(userId);
    if (!user) throw httpError(404, 'User not found');
    forbidSelf(user, actor);
    protectSuper(user, actor);
    if (user.roleId === 'super') throw httpError(400, 'Cannot set overrides for a super user');
    if (!Array.isArray(overrides)) throw httpError(400, 'overrides must be an array');
    const next = new Map<UserPermission, 'grant' | 'revoke'>();
    for (const item of overrides) {
      if (!isRecord(item) || (item.effect !== 'grant' && item.effect !== 'revoke')) throw httpError(400, 'Invalid permission override');
      const permission = validatePermission(item.permission);
      if (next.has(permission)) throw httpError(400, 'Duplicate permission override');
      next.set(permission, item.effect);
    }
    checkPermissionSubset([...next].filter(([, effect]) => effect === 'grant').map(([permission]) => permission), actor);
    // Removing a revoke can also grant a role permission the actor does not own.
    const prospective = new Set(rolePermissions(user.roleId));
    for (const [permission, effect] of next) effect === 'grant' ? prospective.add(permission) : prospective.delete(permission);
    checkPermissionSubset([...prospective].filter((permission) => !hasPermission(user.id, permission)), actor);
    return transaction(() => {
      const previous = new Map(getPermissionOverrides(user.id).map((item) => [item.permission, item.effect]));
      db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(user.id);
      for (const [permission, effect] of next) db.prepare('INSERT INTO user_permission_overrides (user_id, permission, effect, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, permission, effect, actor.id, nowIso());
      const changes = ALL_PERMISSIONS.filter((permission) => previous.get(permission) !== next.get(permission))
        .map((permission) => ({ field: permission, before: previous.get(permission) || 'inherit', after: next.get(permission) || 'inherit' }));
      auditChanges(actor.id, 'user.permission_overrides.update', 'user', user.id, changes);
      return getPermissionOverrides(user.id);
    });
  }

  function inputRoleId(input: UnknownRecord, fallback = 'member'): string {
    const id = Object.hasOwn(input, 'roleId') ? String(input.roleId) : Object.hasOwn(input, 'role') ? (validateRole(input.role) === 'admin' ? 'super' : 'member') : fallback;
    if (!getRole(id)) throw httpError(400, 'Unknown role');
    return id;
  }

  function createUser(input: UnknownRecord, actorId?: Actor): PublicUser {
    const actor = requireActor(actorId ?? input.createdBy ?? input.created_by, 'user.manage');
    return insertUser(input, actor);
  }

  function insertUser(input: UnknownRecord, actor: UserRow | null): PublicUser {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    const roleId = inputRoleId(input);
    const role = roleId === 'super' ? 'admin' : 'user';
    if (actor && roleId !== 'member') {
      requireActor(actor.id, 'role.manage');
      if (roleId === 'super' && actor.roleId !== 'super') throw httpError(403, 'Only a super administrator can assign super');
      checkPermissionSubset(rolePermissions(roleId), actor);
    }
    const displayName = validateShortText(input.displayName ?? input.display_name, 'displayName', 80);
    const note = validateShortText(input.note, 'note', 500);
    const createdBy = actor?.id || null;
    const at = nowIso();
    try {
      return transaction(() => {
        const result = db.prepare(`
          INSERT INTO users (
            username, password_hash, display_name, note, role, role_id, disabled, session_version,
            created_by, created_at, updated_at, password_changed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
        `).run(username, hashPassword(password), displayName, note, role, roleId, createdBy, at, at, at);
        const user = getUserById(result.lastInsertRowid);
        if (!user) throw httpError(500, 'Created user cannot be loaded');
        if (Object.hasOwn(input, 'steamGrants')) {
          replaceUserSteamGrants(user.id, input.steamGrants, createdBy!);
        } else if (Object.prototype.hasOwnProperty.call(input, 'steamAccountIds')) {
          replaceUserSteamAccounts(user.id, input.steamAccountIds, createdBy!);
        }
        return publicUser(getUserById(user.id)!);
      });
    } catch (error) {
      if (isRecord(error) && String(error.message || '').includes('UNIQUE')) {
        throw httpError(409, 'Username already exists');
      }
      throw error;
    }
  }

  function createInitialAdmin(input: UnknownRecord): PublicUser {
    if (countUsers() !== 0) throw httpError(409, 'Setup has already been completed');
    return insertUser({ ...input, role: 'admin', roleId: 'super' }, null);
  }

  function recordLoginFailure(user: UserRow) {
    const nextCount = user.failedLoginCount + 1;
    const lockedUntil = nextCount >= FAILED_LOGIN_LOCK_THRESHOLD ? futureIso(LOCK_MS) : null;
    db.prepare(`
      UPDATE users
      SET failed_login_count = ?, locked_until = ?, updated_at = ?
      WHERE id = ?
    `).run(nextCount, lockedUntil, nowIso(), user.id);
  }

  function authenticate(username: unknown, password: unknown, context: RequestContext = {}): PublicUser | null {
    const user = getUserByUsername(username);
    if (!user) return null;
    if (user.locked) throw httpError(423, 'User is temporarily locked');
    if (user.disabled) return null;
    if (!verifyPassword(password, user.passwordHash)) {
      recordLoginFailure(user);
      return null;
    }
    const at = nowIso();
    db.prepare(`
      UPDATE users
      SET last_login_at = ?, last_login_ip = ?, last_seen_at = ?,
          failed_login_count = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(at, context.ip || null, at, at, user.id);
    return publicUser(getUserById(user.id)!);
  }

  function listUsers(filters: UserListFilters = {}): PublicUser[] {
    let users = db.prepare('SELECT * FROM users ORDER BY id ASC')
      .all()
      .map((row: SQLRow) => publicUser(userFromRow(row)!));
    const query = String(filters.query || '').trim().toLowerCase();
    const rawRole = String(filters.roleId || filters.role || '').trim();
    const role = rawRole === 'admin' ? 'super' : rawRole === 'user' ? 'member' : rawRole;
    const status = String(filters.status || '').trim();
    if (query) {
      users = users.filter((user) => [
        user.username,
        user.displayName,
        user.note
      ].some((value) => value.toLowerCase().includes(query)));
    }
    if (role) users = users.filter((user) => user.roleId === role);
    if (status === 'enabled') users = users.filter((user) => !user.disabled && !user.locked);
    if (status === 'disabled') users = users.filter((user) => user.disabled);
    if (status === 'locked') users = users.filter((user) => user.locked);
    return users;
  }

  function updateUser(id: unknown, patch: UnknownRecord, actorId?: Actor): PublicUser {
    const actor = requireActor(actorId, 'user.manage');
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    protectSuper(user, actor);
    const nextRoleId = inputRoleId(patch, user.roleId);
    const nextRole = nextRoleId === 'super' ? 'admin' : 'user';
    if (Object.hasOwn(patch, 'roleId') || Object.hasOwn(patch, 'role')) {
      requireActor(actor.id, 'role.manage');
      forbidSelf(user, actor);
      if (nextRoleId === 'super' && actor.roleId !== 'super') throw httpError(403, 'Only a super administrator can assign super');
      checkPermissionSubset(rolePermissions(nextRoleId), actor);
    }
    const nextDisabled = Object.prototype.hasOwnProperty.call(patch, 'disabled') ? Boolean(patch.disabled) : user.disabled;
    const nextDisplayName = Object.prototype.hasOwnProperty.call(patch, 'displayName')
      ? validateShortText(patch.displayName, 'displayName', 80)
      : user.displayName;
    const nextNote = Object.prototype.hasOwnProperty.call(patch, 'note')
      ? validateShortText(patch.note, 'note', 500)
      : user.note;
    const nextForcePasswordChange = Object.prototype.hasOwnProperty.call(patch, 'forcePasswordChange')
      ? Boolean(patch.forcePasswordChange)
      : user.forcePasswordChange;
    if (user.roleId === 'super' && !user.disabled && (nextRoleId !== 'super' || nextDisabled)) {
      ensureCanRemoveAdmin(user);
    }
    const sessionBump = (nextRoleId === 'super') !== (user.roleId === 'super')
      || (nextDisabled && !user.disabled)
      || nextForcePasswordChange !== user.forcePasswordChange;
    if (
      nextRoleId === user.roleId
      && nextDisabled === user.disabled
      && nextDisplayName === user.displayName
      && nextNote === user.note
      && nextForcePasswordChange === user.forcePasswordChange
    ) {
      return publicUser(user);
    }
    const at = nowIso();
    return transaction(() => {
      db.prepare(`
        UPDATE users
        SET display_name = ?, note = ?, role = ?, role_id = ?, disabled = ?, force_password_change = ?,
            session_version = session_version + ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextDisplayName,
        nextNote,
        nextRole,
        nextRoleId,
        nextDisabled ? 1 : 0,
        nextForcePasswordChange ? 1 : 0,
        sessionBump ? 1 : 0,
        at,
        user.id
      );
      const next = getUserById(user.id);
      if (!next) throw httpError(500, 'Updated user cannot be loaded');
      if (nextRoleId === 'super') db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(user.id);
      if (nextRoleId !== user.roleId) auditChanges(actor.id, 'user.role.change', 'user', user.id, [{ field: 'role', before: user.roleName, after: next.roleName }]);
      const changes = changesBetween(
        { displayName: user.displayName, note: user.note, disabled: user.disabled, forcePasswordChange: user.forcePasswordChange },
        { displayName: nextDisplayName, note: nextNote, disabled: nextDisabled, forcePasswordChange: nextForcePasswordChange }
      );
      if (changes.length) auditChanges(actor.id, 'user.update', 'user', user.id, changes);
      return publicUser(getUserById(user.id)!);
    });
  }

  function unlockUser(id: unknown, actorId: Actor): PublicUser {
    const actor = requireActor(actorId, 'user.manage');
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    protectSuper(user, actor);
    return transaction(() => {
      db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(nowIso(), user.id);
      auditChanges(actor.id, 'user.unlock', 'user', user.id, changesBetween(
        { failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil }, { failedLoginCount: 0, lockedUntil: null }));
      return publicUser(getUserById(user.id)!);
    });
  }

  function setPassword(id: unknown, password: unknown, options: UnknownRecord = {}, actorId?: Actor): PublicUser {
    const actor = requireActor(actorId ?? options.actorId, 'user.manage');
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    protectSuper(user, actor);
    return writePassword(user, password, options);
  }

  function writePassword(user: UserRow, password: unknown, options: UnknownRecord = {}): PublicUser {
    const nextPassword = validatePassword(password);
    const forcePasswordChange = Object.prototype.hasOwnProperty.call(options, 'forcePasswordChange')
      ? Boolean(options.forcePasswordChange)
      : user.forcePasswordChange;
    const at = nowIso();
    db.prepare(`
      UPDATE users
      SET password_hash = ?, session_version = session_version + 1,
          password_changed_at = ?, force_password_change = ?, updated_at = ?
      WHERE id = ?
    `).run(hashPassword(nextPassword), at, forcePasswordChange ? 1 : 0, at, user.id);
    const next = getUserById(user.id);
    if (!next) throw httpError(500, 'Updated user cannot be loaded');
    return publicUser(next);
  }

  function changeOwnPassword(id: unknown, oldPassword: unknown, newPassword: unknown): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    if (!hasPermission(user.id, 'self.password.change')) throw httpError(403, 'Forbidden');
    if (!verifyPassword(oldPassword, user.passwordHash)) throw httpError(401, 'Old password is incorrect');
    return writePassword(user, newPassword, { forcePasswordChange: false });
  }

  function deleteUser(id: unknown, actorId: Actor): void {
    const actor = requireActor(actorId, 'user.manage');
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    protectSuper(user, actor);
    if (user.id === actor.id) throw httpError(400, 'Cannot delete the current user');
    ensureCanRemoveAdmin(user);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }

  function createSession(userId: unknown, input: SessionCreateInput): PublicUserSession {
    const user = getUserById(userId);
    if (!user) throw httpError(404, 'User not found');
    const at = nowIso();
    const sessionId = crypto.randomBytes(32).toString('base64url');
    db.prepare(`
      INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      user.id,
      at,
      at,
      input.expiresAt,
      input.ip || null,
      input.userAgent || null
    );
    return sessionFromRow(db.prepare('SELECT * FROM user_sessions WHERE id = ?').get(sessionId))!;
  }

  function getSessionById(sessionId: unknown): PublicUserSession | null {
    return sessionFromRow(db.prepare('SELECT * FROM user_sessions WHERE id = ?').get(String(sessionId || '')));
  }

  function validateSession(sessionId: unknown, userId: unknown): PublicUserSession | null {
    const session = getSessionById(sessionId);
    if (!session || session.userId !== asNumber(userId) || session.revokedAt || isFutureIso(session.expiresAt) === false) {
      return null;
    }
    return session;
  }

  function touchSession(sessionId: unknown, userId: unknown, context: RequestContext = {}): PublicUserSession | null {
    const session = validateSession(sessionId, userId);
    if (!session) return null;
    const lastSeenMs = Date.parse(session.lastSeenAt);
    if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < TOUCH_THROTTLE_MS) return session;
    const at = nowIso();
    db.prepare('UPDATE user_sessions SET last_seen_at = ?, ip = COALESCE(?, ip), user_agent = COALESCE(?, user_agent) WHERE id = ?')
      .run(at, context.ip || null, context.userAgent || null, session.id);
    db.prepare('UPDATE users SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(at, at, asNumber(userId));
    return getSessionById(session.id);
  }

  function listUserSessions(userId: unknown): PublicUserSession[] {
    return db.prepare(`
      SELECT * FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC
    `).all(asNumber(userId), nowIso()).map((row: SQLRow) => sessionFromRow(row)!);
  }

  function revokeSession(sessionId: unknown, revokedBy?: unknown): boolean {
    const session = getSessionById(sessionId);
    if (!session || session.revokedAt) return false;
    db.prepare('UPDATE user_sessions SET revoked_at = ?, revoked_by = ? WHERE id = ?')
      .run(nowIso(), asNullableNumber(revokedBy), session.id);
    return true;
  }

  function revokeUserSessions(userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown): number {
    const at = nowIso();
    const except = String(exceptSessionId || '');
    const result = except
      ? db.prepare(`
          UPDATE user_sessions
          SET revoked_at = ?, revoked_by = ?
          WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
        `).run(at, asNullableNumber(revokedBy), asNumber(userId), except)
      : db.prepare(`
          UPDATE user_sessions
          SET revoked_at = ?, revoked_by = ?
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(at, asNullableNumber(revokedBy), asNumber(userId));
    return asNumber(result.changes);
  }

  function getMeta(key: string): string | null {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
    return typeof row?.value === 'string' ? row.value : null;
  }

  function setMeta(key: string, value: string): void {
    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, nowIso());
  }

  function getOrCreateSessionSecret(): string {
    const existing = getMeta('session_secret');
    if (existing) return existing;
    const secret = crypto.randomBytes(32).toString('base64url');
    setMeta('session_secret', secret);
    return secret;
  }

  function getOrCreateSteamLogonID(): number {
    const existing = Number.parseInt(String(getMeta('steam.logon_id') || ''), 10);
    if (Number.isFinite(existing) && existing > 0) return existing;
    const generated = crypto.randomInt(1, 0x7fffffff);
    setMeta('steam.logon_id', String(generated));
    return generated;
  }

  function requiresSetup(): boolean {
    return countUsers() === 0;
  }

  function accountSelectSql(where: string) {
    return `
      SELECT steam_accounts.*,
        (SELECT COUNT(*) FROM user_steam_accounts WHERE steam_account_id = steam_accounts.id) AS authorized_user_count
      FROM steam_accounts
      ${where}
    `;
  }

  function getSteamAccountById(id: unknown, includeToken = false): SteamAccountRow | PublicSteamAccount | null {
    const row = steamAccountFromRow(db.prepare(accountSelectSql('WHERE steam_accounts.id = ?')).get(asNumber(id)));
    if (!row) return null;
    return includeToken ? row : publicSteamAccount(row);
  }

  function getSteamAccountBySteamId(steamId: unknown, includeToken = false): SteamAccountRow | PublicSteamAccount | null {
    const row = steamAccountFromRow(db.prepare(accountSelectSql('WHERE steam_accounts.steam_id = ?')).get(String(steamId || '').trim()));
    if (!row) return null;
    return includeToken ? row : publicSteamAccount(row);
  }

  function listSteamAccounts(includeDisabled = true): PublicSteamAccount[] {
    const where = includeDisabled ? '' : 'WHERE steam_accounts.enabled = 1';
    return db.prepare(`${accountSelectSql(where)} ORDER BY steam_accounts.id ASC`)
      .all()
      .map((row: SQLRow) => publicSteamAccount(steamAccountFromRow(row)!));
  }

  function listSteamAccountsForUser(userId: unknown): PublicSteamAccount[] {
    const user = getUserById(userId);
    if (!user) throw httpError(404, 'User not found');
    return listSteamAccounts(false).filter((account) => getSteamGrant(user.id, account.id) !== null);
  }

  function listUserSteamAccounts(userId: unknown): PublicSteamAccount[] {
    return db.prepare(`
      ${accountSelectSql('JOIN user_steam_accounts ON user_steam_accounts.steam_account_id = steam_accounts.id WHERE user_steam_accounts.user_id = ?')}
      ORDER BY steam_accounts.id ASC
    `).all(asNumber(userId)).map((row: SQLRow) => publicSteamAccount(steamAccountFromRow(row)!));
  }

  function upsertSteamAccount(input: UnknownRecord): PublicSteamAccount {
    const steamId = sanitizeSteamId(input.steamId ?? input.steam_id);
    const existing = getSteamAccountBySteamId(steamId, true) as SteamAccountRow | null;
    const at = nowIso();
    const label = Object.prototype.hasOwnProperty.call(input, 'label') ? validateShortText(input.label, 'label', 80) : undefined;
    const accountNameHint = Object.prototype.hasOwnProperty.call(input, 'accountNameHint')
      ? validateShortText(input.accountNameHint, 'accountNameHint', 120)
      : Object.prototype.hasOwnProperty.call(input, 'account_name_hint')
        ? validateShortText(input.account_name_hint, 'accountNameHint', 120)
        : undefined;
    const refreshToken = typeof input.refreshToken === 'string' && input.refreshToken ? input.refreshToken : undefined;
    const createdBy = asNullableNumber(input.createdBy ?? input.created_by);
    let account: SteamAccountRow | null;
    if (existing) {
      db.prepare(`
        UPDATE steam_accounts
        SET label = ?, account_name_hint = ?,
            refresh_token = COALESCE(?, refresh_token),
            refresh_token_updated_at = CASE WHEN ? IS NULL THEN refresh_token_updated_at ELSE ? END,
            enabled = CASE WHEN enabled IS NULL THEN 1 ELSE enabled END,
            updated_at = ?, last_login_at = ?
        WHERE id = ?
      `).run(
        label === undefined ? existing.label : label,
        accountNameHint === undefined ? existing.accountNameHint : accountNameHint,
        refreshToken || null,
        refreshToken || null,
        refreshToken ? at : null,
        at,
        at,
        existing.id
      );
      account = getSteamAccountById(existing.id, true) as SteamAccountRow | null;
    } else {
      const result = db.prepare(`
        INSERT INTO steam_accounts (
          steam_id, label, account_name_hint, refresh_token, refresh_token_updated_at,
          enabled, created_by, created_at, updated_at, last_login_at
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        steamId,
        label || '',
        accountNameHint || '',
        refreshToken || null,
        refreshToken ? at : null,
        createdBy,
        at,
        at,
        at
      );
      account = getSteamAccountById(result.lastInsertRowid, true) as SteamAccountRow | null;
    }
    if (!account) throw httpError(500, 'Steam account cannot be loaded');
    if (input.setActive) setActiveSteamAccount(account.id);
    return publicSteamAccount(getSteamAccountById(account.id, true) as SteamAccountRow);
  }

  function updateSteamAccount(id: unknown, patch: UnknownRecord): PublicSteamAccount {
    const account = getSteamAccountById(id, true) as SteamAccountRow | null;
    if (!account) throw httpError(404, 'Steam account not found');
    const label = Object.prototype.hasOwnProperty.call(patch, 'label')
      ? validateShortText(patch.label, 'label', 80)
      : account.label;
    const accountNameHint = Object.prototype.hasOwnProperty.call(patch, 'accountNameHint')
      ? validateShortText(patch.accountNameHint, 'accountNameHint', 120)
      : account.accountNameHint;
    const enabled = Object.prototype.hasOwnProperty.call(patch, 'enabled') ? Boolean(patch.enabled) : account.enabled;
    db.prepare(`
      UPDATE steam_accounts
      SET label = ?, account_name_hint = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(label, accountNameHint, enabled ? 1 : 0, nowIso(), account.id);
    return publicSteamAccount(getSteamAccountById(account.id, true) as SteamAccountRow);
  }

  function deleteSteamAccount(id: unknown): void {
    const account = getSteamAccountById(id, true) as SteamAccountRow | null;
    if (!account) throw httpError(404, 'Steam account not found');
    db.prepare('DELETE FROM steam_accounts WHERE id = ?').run(account.id);
    if (activeSteamAccountId() === account.id) setMeta('active_steam_account_id', '');
  }

  function setActiveSteamAccount(id: unknown): PublicSteamAccount {
    const account = getSteamAccountById(id, true) as SteamAccountRow | null;
    if (!account) throw httpError(404, 'Steam account not found');
    setMeta('active_steam_account_id', String(account.id));
    return publicSteamAccount(getSteamAccountById(account.id, true) as SteamAccountRow);
  }

  function getActiveSteamAccount(includeToken = false): SteamAccountRow | PublicSteamAccount | null {
    const id = activeSteamAccountId();
    return id ? getSteamAccountById(id, includeToken) : null;
  }

  function markSteamAccountActive(id: unknown): void {
    const account = getSteamAccountById(id, true) as SteamAccountRow | null;
    if (!account) throw httpError(404, 'Steam account not found');
    db.prepare('UPDATE steam_accounts SET last_active_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), account.id);
  }

  function listUserSteamGrants(userId: unknown): UserSteamGrant[] {
    return db.prepare('SELECT * FROM user_steam_accounts WHERE user_id = ? ORDER BY steam_account_id').all(asNumber(userId)).map((row) => ({
      steamAccountId: asNumber(row.steam_account_id), level: row.level as SteamGrantLevel, scope: row.scope as 'all' | 'some',
      peers: db.prepare('SELECT peer_steam_id FROM user_steam_account_peers WHERE user_id = ? AND steam_account_id = ? ORDER BY peer_steam_id')
        .all(asNumber(userId), asNumber(row.steam_account_id)).map((peer) => String(peer.peer_steam_id)),
      expiresAt: textOrNull(row.expires_at), updatedAt: String(row.updated_at || row.granted_at), updatedBy: asNullableNumber(row.updated_by)
    }));
  }

  function getSteamGrant(userId: unknown, steamAccountId: unknown): SteamGrant | null {
    const user = getUserById(userId);
    const account = getSteamAccountById(steamAccountId, true) as SteamAccountRow | null;
    if (!user || user.disabled || !account?.enabled || !hasPermission(user.id, 'chat.use')) return null;
    if (hasPermission(user.id, 'steam.account.all')) return { level: 'full', scope: 'all', peers: new Set(), expiresAt: null, via: 'all' };
    const grant = listUserSteamGrants(user.id).find((item) => item.steamAccountId === account.id);
    if (!grant || (grant.expiresAt !== null && !(Date.parse(grant.expiresAt) > now()))) return null;
    return { level: grant.level, scope: grant.scope, peers: new Set(grant.peers), expiresAt: grant.expiresAt, via: 'grant' };
  }

  function canAccessSteamAccount(userId: unknown, steamAccountId: unknown, minLevel: SteamGrantLevel = 'read'): boolean {
    if (!['read', 'chat', 'full'].includes(minLevel)) throw httpError(400, 'Invalid minimum grant level');
    return levelAtLeast(getSteamGrant(userId, steamAccountId), minLevel);
  }

  function validateGrants(grants: unknown, preserveExpiry = false): UserSteamGrant[] {
    if (!Array.isArray(grants)) throw httpError(400, 'grants must be an array');
    const seen = new Set<number>();
    return grants.map((item): UserSteamGrant => {
      if (!isRecord(item)) throw httpError(400, 'Invalid Steam grant');
      const id = Number(item.steamAccountId);
      if (!Number.isSafeInteger(id) || id <= 0 || !getSteamAccountById(id)) throw httpError(400, 'Steam account not found');
      if (seen.has(id)) throw httpError(400, 'Duplicate Steam account grant');
      seen.add(id);
      if (item.level !== 'read' && item.level !== 'chat' && item.level !== 'full') throw httpError(400, 'Invalid grant level');
      if (item.scope !== 'all' && item.scope !== 'some') throw httpError(400, 'Invalid grant scope');
      if (item.peers !== undefined && !Array.isArray(item.peers)) throw httpError(400, 'peers must be an array');
      const peers = [...new Set((item.peers || []) as unknown[])];
      if (peers.some((peer) => typeof peer !== 'string' || !/^\d{17}$/.test(peer))) throw httpError(400, 'Peers must be 17 digit SteamIDs');
      if (peers.length > 500) throw httpError(400, 'At most 500 peers are allowed');
      if (item.scope === 'all' && peers.length) throw httpError(400, 'All scope cannot include peers');
      let expiresAt: string | null = null;
      if (item.expiresAt !== undefined && item.expiresAt !== null) {
        if (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)) || (!preserveExpiry && Date.parse(item.expiresAt) <= now())) {
          throw httpError(400, 'expiresAt must be a future date or null');
        }
        expiresAt = new Date(item.expiresAt).toISOString();
      }
      return { steamAccountId: id, level: item.level, scope: item.scope, peers: (peers as string[]).sort(), expiresAt, updatedAt: nowIso(), updatedBy: null };
    });
  }

  function replaceUserSteamGrants(userId: unknown, grants: unknown, actorId: Actor): UserSteamGrant[] {
    return writeUserSteamGrants(userId, grants, actorId, false);
  }

  function writeUserSteamGrants(userId: unknown, grants: unknown, actorId: Actor, legacy: boolean): UserSteamGrant[] {
    const actor = requireActor(actorId, 'steam.grant.manage');
    const user = getUserById(userId);
    if (!user) throw httpError(404, 'User not found');
    protectSuper(user, actor);
    const next = validateGrants(grants, legacy);
    const previous = listUserSteamGrants(user.id);
    for (const grant of next) {
      if (actor.roleId !== 'super') {
        const own = getSteamGrant(actor.id, grant.steamAccountId);
        // account.all grants full authority even when chat.use is not enabled.
        if (!hasPermission(actor.id, 'steam.account.all')) {
          if (!levelAtLeast(own, grant.level)) throw httpError(403, 'Cannot assign a higher Steam grant than your own');
          if (own!.scope === 'some' && (grant.scope !== 'some' || grant.peers.some(peer => !own!.peers.has(peer)))) {
            throw httpError(403, '授权的好友范围不能超出你自己的授权范围');
          }
          if (own!.expiresAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(own!.expiresAt))) {
            throw httpError(403, '授权有效期不能超过你自己的授权有效期');
          }
        }
      }
    }
    return transaction(() => {
      const at = nowIso();
      for (const old of previous) {
        if (!next.some((grant) => grant.steamAccountId === old.steamAccountId)) {
          db.prepare('DELETE FROM user_steam_accounts WHERE user_id = ? AND steam_account_id = ?').run(user.id, old.steamAccountId);
        }
      }
      for (const grant of next) {
        const old = previous.find((item) => item.steamAccountId === grant.steamAccountId);
        if (old && !changesBetween(grantFields(old), grantFields(grant)).length) continue;
        db.prepare(`INSERT INTO user_steam_accounts (user_id, steam_account_id, granted_by, granted_at, level, scope, expires_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, steam_account_id) DO UPDATE SET level = excluded.level, scope = excluded.scope, expires_at = excluded.expires_at,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(user.id, grant.steamAccountId, actor.id, at, grant.level, grant.scope, grant.expiresAt, actor.id, at);
        db.prepare('DELETE FROM user_steam_account_peers WHERE user_id = ? AND steam_account_id = ?').run(user.id, grant.steamAccountId);
        for (const peer of grant.peers) db.prepare('INSERT INTO user_steam_account_peers (user_id, steam_account_id, peer_steam_id) VALUES (?, ?, ?)')
          .run(user.id, grant.steamAccountId, peer);
      }
      for (const accountId of new Set([...previous, ...next].map((grant) => grant.steamAccountId))) {
        const before = previous.find((grant) => grant.steamAccountId === accountId);
        const after = next.find((grant) => grant.steamAccountId === accountId);
        const changes = changesBetween(grantFields(before), grantFields(after));
        if (changes.length) auditChanges(actor.id, 'steam_account.grant_update', 'user', user.id, changes, { steamAccountId: accountId });
      }
      if (legacy) recordAudit({ actorUserId: actor.id, action: 'steam_account.grant_replace', targetType: 'user', targetId: user.id, detail: { steamAccountIds: next.map((grant) => grant.steamAccountId) } });
      return listUserSteamGrants(user.id);
    });
  }

  function grantFields(grant?: UserSteamGrant): UnknownRecord {
    return { level: grant?.level || 'none', scope: grant?.scope || 'all', peers: grant?.peers || [], expiresAt: grant?.expiresAt || null };
  }

  function replaceUserSteamAccounts(userId: unknown, steamAccountIds: unknown, actorId: Actor): PublicSteamAccount[] {
    if (!Array.isArray(steamAccountIds) || steamAccountIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw httpError(400, 'steamAccountIds must be an array of account IDs');
    const previous = listUserSteamGrants(userId);
    const grants = normalizeIdList(steamAccountIds).map((id): UserSteamGrant => previous.find((grant) => grant.steamAccountId === id)
      || { steamAccountId: id, level: 'full', scope: 'all', peers: [], expiresAt: null, updatedAt: nowIso(), updatedBy: null });
    writeUserSteamGrants(userId, grants, actorId, true);
    return listUserSteamAccounts(userId);
  }

  function listSteamGrantOverview() {
    return {
      accounts: listSteamAccounts(),
      users: listUsers().map((user) => ({
        id: user.id, username: user.username, displayName: user.displayName, all: hasPermission(user.id, 'steam.account.all'),
        grants: Object.fromEntries(user.steamGrantSummary.map(({ steamAccountId, ...grant }) => [steamAccountId, grant]))
      }))
    };
  }

  function recordAudit(input: UnknownRecord): PublicAuditLog {
    const action = validateShortText(input.action, 'action', 80);
    const targetType = validateShortText(input.targetType ?? input.target_type, 'targetType', 80);
    const targetId = validateShortText(input.targetId ?? input.target_id, 'targetId', 160);
    const detail = isRecord(input.detail) ? sanitizeAuditDetail(input.detail) : {};
    const at = nowIso();
    const result = db.prepare(`
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, detail_json, ip, user_agent, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asNullableNumber(input.actorUserId ?? input.actor_user_id),
      action,
      targetType,
      targetId,
      JSON.stringify(detail),
      textOrNull(input.ip),
      textOrNull(input.userAgent ?? input.user_agent),
      at
    );
    return listAuditLogs({ limit: 1 }).find((item) => item.id === asNumber(result.lastInsertRowid))!;
  }

  function listAuditLogs(filters: AuditListFilters = {}): PublicAuditLog[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    const action = String(filters.action || '').trim();
    const targetType = String(filters.targetType || '').trim();
    const actorUserId = Number(filters.actorUserId || 0);
    const from = String(filters.from || '').trim();
    const to = String(filters.to || '').trim();
    const category = String(filters.category || '').trim();
    const query = String(filters.query || '').trim();
    const grantAction = "audit_logs.action GLOB 'steam_account.grant_*'";
    const roleAction = "(audit_logs.action GLOB 'role.*' OR audit_logs.action IN ('user.role.change', 'user.permission_overrides.update'))";
    const categories: Record<string, string> = {
      grant: grantAction,
      role: roleAction,
      user: `(audit_logs.action GLOB 'user.*' AND NOT ${roleAction})`,
      steam: `((audit_logs.action GLOB 'steam.*' OR audit_logs.action GLOB 'steam_account.*') AND NOT (${grantAction}))`,
      session: "(audit_logs.action GLOB 'auth.*' OR audit_logs.action GLOB 'session.*')"
    };
    if (category) {
      if (!Object.hasOwn(categories, category)) throw httpError(400, 'Invalid audit category');
      clauses.push(categories[category]);
    }
    if (query) {
      clauses.push("(instr(lower(COALESCE(users.username, '')), lower(?)) > 0 OR instr(lower(audit_logs.action), lower(?)) > 0 OR instr(lower(audit_logs.target_id), lower(?)) > 0 OR instr(lower(COALESCE(audit_logs.ip, '')), lower(?)) > 0)");
      params.push(query, query, query, query);
    }
    if (action) {
      clauses.push('audit_logs.action = ?');
      params.push(action);
    }
    if (targetType) {
      clauses.push('audit_logs.target_type = ?');
      params.push(targetType);
    }
    if (Number.isFinite(actorUserId) && actorUserId > 0) {
      clauses.push('audit_logs.actor_user_id = ?');
      params.push(actorUserId);
    }
    if (from) {
      clauses.push('audit_logs.created_at >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('audit_logs.created_at <= ?');
      params.push(to);
    }
    const parsedLimit = Number.parseInt(String(filters.limit || ''), 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 100;
    params.push(limit);
    return db.prepare(`
      SELECT audit_logs.*, users.username AS actor_username
      FROM audit_logs
      LEFT JOIN users ON users.id = audit_logs.actor_user_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY audit_logs.id DESC
      LIMIT ?
    `).all(...params).map((row: SQLRow) => auditLogFromRow(row));
  }

  return {
    ALL_PERMISSIONS,
    db,
    dbPath,
    authenticate,
    canAccessSteamAccount,
    canAccessPeer,
    changeOwnPassword,
    close() {
      db.close();
    },
    countUsers,
    createInitialAdmin,
    createSession,
    createUser,
    createRole,
    deleteRole,
    deleteSteamAccount,
    deleteUser,
    enabledAdminCount: enabledSuperCount,
    enabledSuperCount,
    effectivePermissions,
    permissionDetails,
    getPermissionOverrides,
    getRole,
    getSteamGrant,
    getActiveSteamAccount,
    getMeta,
    getOrCreateSessionSecret,
    getOrCreateSteamLogonID,
    getSessionById,
    getSteamAccountById,
    getSteamAccountBySteamId,
    getUserById,
    getUserByUsername,
    hasPermission,
    listAuditLogs,
    listSteamAccounts,
    listRoles,
    listUserSteamGrants,
    listSteamGrantOverview,
    levelAtLeast,
    listSteamAccountsForUser,
    listUserSessions,
    listUserSteamAccounts,
    listUsers,
    markSteamAccountActive,
    permissionsForRole,
    recordAudit,
    replaceUserSteamAccounts,
    replaceUserSteamGrants,
    requiresSetup,
    revokeSession,
    revokeUserSessions,
    setActiveSteamAccount,
    setMeta,
    setPassword,
    setPermissionOverrides,
    touchSession,
    updateSteamAccount,
    updateUser,
    unlockUser,
    updateRole,
    upsertSteamAccount,
    validateSession
  };
}

module.exports = {
  ALL_PERMISSIONS,
  FAILED_LOGIN_LOCK_THRESHOLD,
  LOCK_MS,
  PASSWORD_MIN_LENGTH,
  ROLE_PERMISSIONS,
  USERNAME_PATTERN,
  createAuthStore,
  hashPassword,
  canAccessPeer,
  levelAtLeast,
  permissionsForRole,
  validatePassword,
  validateRole,
  validateUsername,
  verifyPassword
};
