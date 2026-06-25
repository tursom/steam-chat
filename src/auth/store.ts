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

export type UserPermission =
  | 'user.manage'
  | 'session.manage'
  | 'audit.view'
  | 'steam.manage'
  | 'steam.account.manage'
  | 'chat.use'
  | 'self.password.change';

export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  note: string;
  role: UserRole;
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
  status?: unknown;
};

type AuditListFilters = {
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
  admin: [
    'user.manage',
    'session.manage',
    'audit.view',
    'steam.manage',
    'steam.account.manage',
    'chat.use',
    'self.password.change'
  ],
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

function nowIso() {
  return new Date().toISOString();
}

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

function asRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user';
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
    result[key] = SENSITIVE_DETAIL_KEYS.has(key) ? '[redacted]' : sanitizeAuditDetail(item);
  }
  return result;
}

function permissionsForRole(role: UserRole): UserPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

function hasPermission(roleOrUser: UserRole | Pick<PublicUser, 'role'>, permission: UserPermission): boolean {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser.role;
  return ROLE_PERMISSIONS[role].includes(permission);
}

function createAuthStore(options: AuthStoreOptions = {}) {
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

  addColumnIfMissing('users', 'display_name', "display_name TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('users', 'note', "note TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('users', 'created_by', 'created_by INTEGER');
  addColumnIfMissing('users', 'last_login_ip', 'last_login_ip TEXT');
  addColumnIfMissing('users', 'last_seen_at', 'last_seen_at TEXT');
  addColumnIfMissing('users', 'password_changed_at', 'password_changed_at TEXT');
  addColumnIfMissing('users', 'force_password_change', 'force_password_change INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'failed_login_count', 'failed_login_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'locked_until', 'locked_until TEXT');

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
      role: asRole(row.role),
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

  function enabledAdminCount(): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get();
    return asNumber(row?.count);
  }

  function ensureCanRemoveAdmin(user: UserRow) {
    if (user.role === 'admin' && !user.disabled && enabledAdminCount() <= 1) {
      throw httpError(409, 'Cannot remove the last enabled admin');
    }
  }

  function replaceUserSteamAccounts(userId: unknown, steamAccountIds: unknown, grantedBy?: unknown): PublicSteamAccount[] {
    const user = getUserById(userId);
    if (!user) throw httpError(404, 'User not found');
    const ids = normalizeIdList(steamAccountIds);
    for (const id of ids) {
      if (!getSteamAccountById(id)) throw httpError(404, `Steam account not found: ${id}`);
    }
    const at = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM user_steam_accounts WHERE user_id = ?').run(user.id);
      const insert = db.prepare(`
        INSERT INTO user_steam_accounts (user_id, steam_account_id, granted_by, granted_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const id of ids) insert.run(user.id, id, asNullableNumber(grantedBy), at);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return listUserSteamAccounts(user.id);
  }

  function createUser(input: UnknownRecord): PublicUser {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    const role = validateRole(input.role || 'user');
    const displayName = validateShortText(input.displayName ?? input.display_name, 'displayName', 80);
    const note = validateShortText(input.note, 'note', 500);
    const createdBy = asNullableNumber(input.createdBy ?? input.created_by);
    const at = nowIso();
    try {
      const result = db.prepare(`
        INSERT INTO users (
          username, password_hash, display_name, note, role, disabled, session_version,
          created_by, created_at, updated_at, password_changed_at
        )
        VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
      `).run(username, hashPassword(password), displayName, note, role, createdBy, at, at, at);
      const user = getUserById(result.lastInsertRowid);
      if (!user) throw httpError(500, 'Created user cannot be loaded');
      if (Object.prototype.hasOwnProperty.call(input, 'steamAccountIds')) {
        replaceUserSteamAccounts(user.id, input.steamAccountIds, createdBy);
      }
      return publicUser(getUserById(user.id)!);
    } catch (error) {
      if (isRecord(error) && String(error.message || '').includes('UNIQUE')) {
        throw httpError(409, 'Username already exists');
      }
      throw error;
    }
  }

  function createInitialAdmin(input: UnknownRecord): PublicUser {
    if (countUsers() !== 0) throw httpError(409, 'Setup has already been completed');
    return createUser({ ...input, role: 'admin' });
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
    const role = String(filters.role || '').trim();
    const status = String(filters.status || '').trim();
    if (query) {
      users = users.filter((user) => [
        user.username,
        user.displayName,
        user.note
      ].some((value) => value.toLowerCase().includes(query)));
    }
    if (role === 'admin' || role === 'user') users = users.filter((user) => user.role === role);
    if (status === 'enabled') users = users.filter((user) => !user.disabled && !user.locked);
    if (status === 'disabled') users = users.filter((user) => user.disabled);
    if (status === 'locked') users = users.filter((user) => user.locked);
    return users;
  }

  function updateUser(id: unknown, patch: UnknownRecord): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    const nextRole = Object.prototype.hasOwnProperty.call(patch, 'role') ? validateRole(patch.role) : user.role;
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
    if (user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || nextDisabled)) {
      ensureCanRemoveAdmin(user);
    }
    const sessionBump = nextRole !== user.role
      || nextDisabled !== user.disabled
      || nextForcePasswordChange !== user.forcePasswordChange;
    if (
      nextRole === user.role
      && nextDisabled === user.disabled
      && nextDisplayName === user.displayName
      && nextNote === user.note
      && nextForcePasswordChange === user.forcePasswordChange
    ) {
      return publicUser(user);
    }
    const at = nowIso();
    db.prepare(`
      UPDATE users
      SET display_name = ?, note = ?, role = ?, disabled = ?, force_password_change = ?,
          session_version = session_version + ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextDisplayName,
      nextNote,
      nextRole,
      nextDisabled ? 1 : 0,
      nextForcePasswordChange ? 1 : 0,
      sessionBump ? 1 : 0,
      at,
      user.id
    );
    const next = getUserById(user.id);
    if (!next) throw httpError(500, 'Updated user cannot be loaded');
    return publicUser(next);
  }

  function setPassword(id: unknown, password: unknown, options: UnknownRecord = {}): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
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
    if (!verifyPassword(oldPassword, user.passwordHash)) throw httpError(401, 'Old password is incorrect');
    return setPassword(user.id, newPassword, { forcePasswordChange: false });
  }

  function deleteUser(id: unknown, currentUserId: unknown): void {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    if (user.id === asNumber(currentUserId)) throw httpError(400, 'Cannot delete the current user');
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
    if (user.role === 'admin') return listSteamAccounts(true);
    return db.prepare(`
      ${accountSelectSql('JOIN user_steam_accounts ON user_steam_accounts.steam_account_id = steam_accounts.id WHERE user_steam_accounts.user_id = ? AND steam_accounts.enabled = 1')}
      ORDER BY steam_accounts.id ASC
    `).all(user.id).map((row: SQLRow) => publicSteamAccount(steamAccountFromRow(row)!));
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

  function canAccessSteamAccount(userId: unknown, steamAccountId: unknown): boolean {
    const user = getUserById(userId);
    const account = getSteamAccountById(steamAccountId, true) as SteamAccountRow | null;
    if (!user || !account || !account.enabled) return false;
    if (user.role === 'admin') return true;
    const row = db.prepare(`
      SELECT 1 AS ok FROM user_steam_accounts
      WHERE user_id = ? AND steam_account_id = ?
    `).get(user.id, account.id);
    return Boolean(row);
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
    db,
    dbPath,
    authenticate,
    canAccessSteamAccount,
    changeOwnPassword,
    close() {
      db.close();
    },
    countUsers,
    createInitialAdmin,
    createSession,
    createUser,
    deleteSteamAccount,
    deleteUser,
    enabledAdminCount,
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
    listSteamAccountsForUser,
    listUserSessions,
    listUserSteamAccounts,
    listUsers,
    markSteamAccountActive,
    permissionsForRole,
    recordAudit,
    replaceUserSteamAccounts,
    requiresSetup,
    revokeSession,
    revokeUserSessions,
    setActiveSteamAccount,
    setMeta,
    setPassword,
    touchSession,
    updateSteamAccount,
    updateUser,
    upsertSteamAccount,
    validateSession
  };
}

module.exports = {
  FAILED_LOGIN_LOCK_THRESHOLD,
  LOCK_MS,
  PASSWORD_MIN_LENGTH,
  ROLE_PERMISSIONS,
  USERNAME_PATTERN,
  createAuthStore,
  hashPassword,
  hasPermission,
  permissionsForRole,
  validatePassword,
  validateRole,
  validateUsername,
  verifyPassword
};
