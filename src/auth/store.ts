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

export type PublicUser = {
  id: number;
  username: string;
  role: UserRole;
  disabled: boolean;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type UserRow = PublicUser & {
  passwordHash: string;
};

type AuthStoreOptions = {
  dbPath?: string;
  database?: DatabaseSync;
};

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const PASSWORD_MIN_LENGTH = 8;
const HASH_PREFIX = 'scrypt:v1';

function nowIso() {
  return new Date().toISOString();
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value || 0);
}

function asRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user';
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

function userFromRow(row: SQLRow | undefined): UserRow | null {
  if (!row) return null;
  return {
    id: asNumber(row.id),
    username: String(row.username || ''),
    passwordHash: String(row.password_hash || ''),
    role: asRole(row.role),
    disabled: Boolean(asNumber(row.disabled)),
    sessionVersion: asNumber(row.session_version),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    lastLoginAt: typeof row.last_login_at === 'string' ? row.last_login_at : null
  };
}

function publicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
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
  `);

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

  function createUser(input: UnknownRecord): PublicUser {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    const role = validateRole(input.role || 'user');
    const at = nowIso();
    try {
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, role, disabled, session_version, created_at, updated_at)
        VALUES (?, ?, ?, 0, 1, ?, ?)
      `).run(username, hashPassword(password), role, at, at);
      const user = getUserById(result.lastInsertRowid);
      if (!user) throw httpError(500, 'Created user cannot be loaded');
      return publicUser(user);
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

  function authenticate(username: unknown, password: unknown): PublicUser | null {
    const user = getUserByUsername(username);
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) return null;
    const at = nowIso();
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(at, at, user.id);
    return publicUser({ ...user, lastLoginAt: at, updatedAt: at });
  }

  function listUsers(): PublicUser[] {
    return db.prepare('SELECT * FROM users ORDER BY id ASC')
      .all()
      .map((row: SQLRow) => publicUser(userFromRow(row)!));
  }

  function updateUser(id: unknown, patch: UnknownRecord): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    const nextRole = Object.prototype.hasOwnProperty.call(patch, 'role') ? validateRole(patch.role) : user.role;
    const nextDisabled = Object.prototype.hasOwnProperty.call(patch, 'disabled') ? Boolean(patch.disabled) : user.disabled;
    if (user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || nextDisabled)) {
      ensureCanRemoveAdmin(user);
    }
    if (nextRole === user.role && nextDisabled === user.disabled) return publicUser(user);
    const at = nowIso();
    db.prepare(`
      UPDATE users
      SET role = ?, disabled = ?, session_version = session_version + 1, updated_at = ?
      WHERE id = ?
    `).run(nextRole, nextDisabled ? 1 : 0, at, user.id);
    const next = getUserById(user.id);
    if (!next) throw httpError(500, 'Updated user cannot be loaded');
    return publicUser(next);
  }

  function setPassword(id: unknown, password: unknown): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    const nextPassword = validatePassword(password);
    const at = nowIso();
    db.prepare(`
      UPDATE users
      SET password_hash = ?, session_version = session_version + 1, updated_at = ?
      WHERE id = ?
    `).run(hashPassword(nextPassword), at, user.id);
    const next = getUserById(user.id);
    if (!next) throw httpError(500, 'Updated user cannot be loaded');
    return publicUser(next);
  }

  function changeOwnPassword(id: unknown, oldPassword: unknown, newPassword: unknown): PublicUser {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    if (!verifyPassword(oldPassword, user.passwordHash)) throw httpError(401, 'Old password is incorrect');
    return setPassword(user.id, newPassword);
  }

  function deleteUser(id: unknown, currentUserId: unknown): void {
    const user = getUserById(id);
    if (!user) throw httpError(404, 'User not found');
    if (user.id === asNumber(currentUserId)) throw httpError(400, 'Cannot delete the current user');
    ensureCanRemoveAdmin(user);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
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

  return {
    db,
    dbPath,
    authenticate,
    changeOwnPassword,
    close() {
      db.close();
    },
    countUsers,
    createInitialAdmin,
    createUser,
    deleteUser,
    enabledAdminCount,
    getMeta,
    getOrCreateSessionSecret,
    getOrCreateSteamLogonID,
    getUserById,
    getUserByUsername,
    listUsers,
    requiresSetup,
    setMeta,
    setPassword,
    updateUser
  };
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  createAuthStore,
  hashPassword,
  publicUser,
  validatePassword,
  validateRole,
  validateUsername,
  verifyPassword
};
