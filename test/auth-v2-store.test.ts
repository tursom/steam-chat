import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';
import type { PermissionDetail, PublicUser } from '../src/auth/store';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, ALL_PERMISSIONS, levelAtLeast, canAccessPeer, hashPassword } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');

function fixture(t: TestContext, options: { now?: () => number } = {}) {
  const store = createAuthStore({ dbPath: ':memory:', ...options });
  t.after(() => store.close());
  const admin = store.createInitialAdmin({ username: 'root', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123' }, admin.id);
  return { store, admin, user };
}

function fails(statusCode: number, code?: string) {
  return (error: { statusCode?: number; code?: string }) => error.statusCode === statusCode && (!code || error.code === code);
}

function request(cookie: string): IncomingMessage {
  return { headers: { cookie: cookie.split(';')[0] }, socket: {} } as IncomingMessage;
}

test('v1 database migrates roles, full/all grants and metadata once, and survives restart with empty member permissions', (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-v2-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'auth.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
      session_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
    CREATE TABLE steam_accounts (id INTEGER PRIMARY KEY, steam_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '',
      account_name_hint TEXT NOT NULL DEFAULT '', refresh_token TEXT, refresh_token_updated_at TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_login_at TEXT, last_active_at TEXT);
    CREATE TABLE user_steam_accounts (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      steam_account_id INTEGER NOT NULL REFERENCES steam_accounts(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, steam_account_id));
  `);
  const at = '2026-01-01T00:00:00.000Z';
  const password = hashPassword('password123');
  old.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)').run('root', password, 'admin', at, at);
  old.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (2, ?, ?, ?, ?, ?)').run('worker', password, 'user', at, at);
  old.prepare('INSERT INTO steam_accounts (id, steam_id, created_at, updated_at) VALUES (1, ?, ?, ?)').run('76561198000000000', at, at);
  old.prepare('INSERT INTO user_steam_accounts VALUES (2, 1, 1, ?)').run(at);
  old.close();
  let store = createAuthStore({ dbPath });
  try {
    assert.equal(store.getUserById(1).roleId, 'super');
    assert.equal(store.getUserById(2).roleId, 'member');
    assert.equal(store.getUserById(1).role, 'admin');
    assert.equal(store.getUserById(2).role, 'user');
    assert.deepEqual(store.getSteamGrant(2, 1), { level: 'full', scope: 'all', peers: new Set(), expiresAt: null, via: 'grant' });
    assert.equal(store.listUserSteamGrants(2)[0].updatedAt, at);
    assert.equal(store.listUserSteamGrants(2)[0].updatedBy, 1);
    assert.equal(store.getMeta('auth_schema_version'), '2');
    assert.equal(store.listRoles().length, 2);
    store.updateRole('member', { permissions: [] }, 1);
  } finally { store.close(); }
  store = createAuthStore({ dbPath });
  try {
    assert.deepEqual(store.effectivePermissions(2), []);
    assert.equal(store.listUserSteamGrants(2)[0].level, 'full');
    assert.equal(store.listRoles().length, 2);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { store.close(); }
});

test('effective permissions are ordered, live, sourced, and user.manage implies user.view even over a revoke', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  assert.equal(ALL_PERMISSIONS.length, 12);
  const role = store.createRole({ name: 'Operator', permissions: ['chat.use', 'user.manage'] }, admin.id);
  store.updateUser(user.id, { roleId: role.id }, admin.id);
  store.setPermissionOverrides(user.id, [
    { permission: 'chat.use', effect: 'revoke' },
    { permission: 'user.view', effect: 'revoke' },
    { permission: 'emote.manage', effect: 'grant' }
  ], admin.id);
  assert.deepEqual(store.effectivePermissions(user), ['user.view', 'user.manage', 'emote.manage']);
  const details = store.permissionDetails(user.id);
  const source = (permission: string) => details.find((detail: PermissionDetail) => detail.permission === permission);
  assert.equal(source('user.view').source, 'implied');
  assert.equal(source('user.manage').source, 'role');
  assert.equal(source('chat.use').source, 'revoke');
  assert.equal(source('emote.manage').source, 'grant');
  assert.equal(source('audit.view').source, 'none');
  assert.equal(store.hasPermission(user, 'chat.use'), false);
  assert.equal(store.hasPermission(user, 'role.manage'), false);
  assert.throws(() => store.hasPermission(user, 'invented'), fails(400));
  assert.equal(store.hasPermission('admin', 'user.manage'), false);
  store.updateRole(role.id, { permissions: ['audit.view'] }, admin.id);
  assert.deepEqual(store.effectivePermissions(user), ['audit.view', 'emote.manage']);
  store.db.prepare("INSERT INTO user_permission_overrides VALUES (?, 'chat.use', 'revoke', ?, ?)").run(admin.id, admin.id, new Date().toISOString());
  assert.deepEqual(store.effectivePermissions(admin), ALL_PERMISSIONS);
  assert.ok(store.permissionDetails(admin.id).every((detail: PermissionDetail) => detail.source === 'super'));
});

test('role CRUD validates names, permissions, builtins and membership, without resetting permissions on description edits', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  const role = store.createRole({ name: 'Support', description: 'Help desk', permissions: ['chat.use'] }, admin.id);
  assert.match(role.id, /^r_[a-z0-9]{8}$/);
  assert.equal(role.memberCount, 0);
  assert.equal(role.deletable, true);
  assert.throws(() => store.createRole({ name: 'support', permissions: [] }, admin.id), fails(409));
  for (const name of ['', 'a'.repeat(33)]) assert.throws(() => store.createRole({ name, permissions: [] }, admin.id), fails(400));
  assert.throws(() => store.createRole({ name: 'Other', permissions: ['invalid'] }, admin.id), fails(400));
  assert.throws(() => store.createRole({ name: 'Other', description: 'x'.repeat(201), permissions: [] }, admin.id), fails(400));
  assert.throws(() => store.updateRole('super', { description: 'edit' }, admin.id), fails(400));
  assert.throws(() => store.updateRole('member', { name: 'edit' }, admin.id), fails(400));
  assert.throws(() => store.deleteRole('member', admin.id), fails(400));
  assert.throws(() => store.deleteRole('super', admin.id), fails(400));
  assert.deepEqual(store.updateRole(role.id, { description: 'Updated' }, admin.id).permissions, ['chat.use']);
  store.updateUser(user.id, { roleId: role.id }, admin.id);
  assert.equal(store.getRole(role.id).memberCount, 1);
  assert.throws(() => store.deleteRole(role.id, admin.id), (error: { statusCode: number; memberCount: number }) => error.statusCode === 409 && error.memberCount === 1);
  store.updateUser(user.id, { roleId: 'member' }, admin.id);
  store.deleteRole(role.id, admin.id);
  assert.equal(store.getRole(role.id), null);
});

test('store prevents unauthenticated writes, role self changes, super modification and permission escalation', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  const managerRole = store.createRole({ name: 'User manager', permissions: ['user.manage'] }, admin.id);
  store.updateUser(user.id, { roleId: managerRole.id }, admin.id);
  const target = store.createUser({ username: 'target', password: 'password123' }, admin.id);
  assert.throws(() => store.updateUser(target.id, { roleId: 'member' }, user.id), fails(403));
  assert.throws(() => store.updateUser(target.id, { note: 'edit' }), fails(403));
  assert.throws(() => store.createUser({ username: 'bad', password: 'password123' }), fails(403));
  assert.throws(() => store.createUser({ username: 'bad', password: 'password123', roleId: 'super' }, user.id), fails(403));
  assert.throws(() => store.updateUser(admin.id, { note: 'edit' }, user.id), fails(403));
  assert.throws(() => store.setPassword(admin.id, 'password456', { actorId: user.id }), fails(403));
  assert.throws(() => store.deleteUser(admin.id, user.id), fails(403));
  store.updateUser(user.id, { note: 'own profile' }, user.id);
  store.setPermissionOverrides(user.id, [{ permission: 'role.manage', effect: 'grant' }], admin.id);
  assert.throws(() => store.updateUser(user.id, { roleId: 'member' }, user.id), fails(403, 'self_escalation'));
  assert.throws(() => store.setPermissionOverrides(user.id, [], user.id), fails(403, 'self_escalation'));
  assert.throws(() => store.createRole({ name: 'Escalate', permissions: ['audit.view'] }, user.id), fails(403));
  const powerful = store.createRole({ name: 'Auditor', permissions: ['audit.view'] }, admin.id);
  assert.throws(() => store.updateRole(powerful.id, { permissions: ['audit.view'] }, user.id), fails(403));
  assert.throws(() => store.updateUser(target.id, { roleId: powerful.id }, user.id), fails(403));
  assert.throws(() => store.updateUser(target.id, { roleId: 'super' }, user.id), fails(403));
  assert.throws(() => store.setPermissionOverrides(target.id, [{ permission: 'audit.view', effect: 'grant' }], user.id), fails(403));
  assert.throws(() => store.setPermissionOverrides(admin.id, [], admin.id), fails(403, 'self_escalation'));
  const second = store.createUser({ username: 'second', password: 'password123', roleId: 'super' }, admin.id);
  assert.throws(() => store.setPermissionOverrides(second.id, [], admin.id), fails(400));
  assert.throws(() => store.setPermissionOverrides(target.id, [{ permission: 'invalid', effect: 'grant' }], admin.id), fails(400));
  assert.throws(() => store.setPermissionOverrides(target.id, [{ permission: 'audit.view', effect: 'inherit' }], admin.id), fails(400));
  store.updateUser(target.id, { roleId: powerful.id }, admin.id);
  store.setPermissionOverrides(target.id, [{ permission: 'audit.view', effect: 'revoke' }], admin.id);
  assert.throws(() => store.setPermissionOverrides(target.id, [], user.id), fails(403));
});

test('last enabled super cannot be disabled; promotion clears overrides and ordinary role changes preserve sessions', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  assert.throws(() => store.updateUser(admin.id, { disabled: true }, admin.id), fails(409));
  assert.throws(() => store.updateUser(admin.id, { roleId: 'member' }, admin.id), fails(403, 'self_escalation'));
  assert.throws(() => store.deleteUser(admin.id, admin.id), fails(400));
  assert.equal(store.enabledSuperCount(), 1);
  const sessions = createSessionManager({ store });
  const cookie = sessions.createSetCookie(user);
  assert.equal(sessions.decode(cookie.split('=')[1].split(';')[0]).role, undefined);
  store.setPermissionOverrides(user.id, [{ permission: 'emote.manage', effect: 'grant' }], admin.id);
  assert.ok(sessions.getSession(request(cookie)));
  const role = store.createRole({ name: 'Reader', permissions: ['chat.use'] }, admin.id);
  store.updateUser(user.id, { roleId: role.id }, admin.id);
  assert.ok(sessions.getSession(request(cookie)));
  assert.equal(store.getUserById(user.id).sessionVersion, user.sessionVersion);
  assert.ok(store.hasPermission(sessions.getSession(request(cookie)).user, 'emote.manage'));
  store.updateUser(user.id, { roleId: 'super' }, admin.id);
  assert.equal(sessions.getSession(request(cookie)), null);
  assert.deepEqual(store.getPermissionOverrides(user.id), []);
  assert.equal(store.getUserById(user.id).overrideCount, 0);
  const promoted = store.getUserById(user.id);
  const superCookie = sessions.createSetCookie(promoted);
  store.updateUser(user.id, { roleId: 'member' }, admin.id);
  assert.equal(sessions.getSession(request(superCookie)), null);
  assert.equal(store.getUserById(user.id).role, 'user');
  const fresh = sessions.createSetCookie(store.getUserById(user.id));
  store.updateUser(user.id, { disabled: true }, admin.id);
  assert.equal(sessions.getSession(request(fresh)), null);
  assert.equal(store.hasPermission(user, 'chat.use'), false);
});

test('signed legacy cookies ignore role and permissions update without a new login', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  const sessions = createSessionManager({ store });
  const current = sessions.createSetCookie(user).split(';')[0].split('=')[1];
  const oldPayload = { ...sessions.decode(current), role: 'admin' };
  const cookie = `${sessions.cookieName}=${sessions.encode(oldPayload)}`;
  assert.equal(sessions.getSession(request(cookie)).user.roleId, 'member');
  assert.throws(() => sessions.requirePermission(request(cookie), 'emote.manage'), fails(403));
  store.setPermissionOverrides(user.id, [{ permission: 'emote.manage', effect: 'grant' }], admin.id);
  assert.equal(sessions.requirePermission(request(cookie), 'emote.manage').user.id, user.id);
  store.setPermissionOverrides(user.id, [{ permission: 'emote.manage', effect: 'revoke' }], admin.id);
  assert.ok(sessions.getSession(request(cookie)));
  assert.throws(() => sessions.requirePermission(request(cookie), 'emote.manage'), fails(403));
});

test('Steam grants enforce levels, peer scopes, expiry, disabled users/accounts and chat.use with injected time', (t: TestContext) => {
  let time = Date.parse('2026-06-01T00:00:00Z');
  const { store, admin, user } = fixture(t, { now: () => time });
  const account = store.upsertSteamAccount({ steamId: '76561198000000000' });
  const peer = '76561198040000001';
  const expiresAt = '2026-06-02T00:00:00.000Z';
  store.replaceUserSteamGrants(user.id, [{ steamAccountId: account.id, level: 'read', scope: 'some', peers: [peer, peer], expiresAt }], admin.id);
  const grant = store.getSteamGrant(user.id, account.id);
  assert.deepEqual(grant.peers, new Set([peer]));
  assert.equal(canAccessPeer(grant, peer), true);
  assert.equal(canAccessPeer(grant, '76561198040000002'), false);
  assert.equal(canAccessPeer(grant, '103582791429521412'), false);
  assert.equal(canAccessPeer(null, peer), false);
  assert.equal(store.canAccessSteamAccount(user.id, account.id), true);
  assert.equal(store.canAccessSteamAccount(user.id, account.id, 'chat'), false);
  assert.equal(store.canAccessSteamAccount(user.id, account.id, 'full'), false);
  assert.equal(levelAtLeast(grant, 'read'), true);
  assert.equal(levelAtLeast(null, 'read'), false);
  assert.equal(levelAtLeast('chat', 'read'), true);
  assert.equal(levelAtLeast('chat', 'full'), false);
  assert.equal(levelAtLeast('full', 'full'), true);
  store.updateSteamAccount(account.id, { enabled: false });
  assert.equal(store.getSteamGrant(user.id, account.id), null);
  assert.equal(store.getSteamGrant(admin.id, account.id), null);
  store.updateSteamAccount(account.id, { enabled: true });
  assert.ok(store.getSteamGrant(user.id, account.id));
  store.setPermissionOverrides(user.id, [{ permission: 'chat.use', effect: 'revoke' }], admin.id);
  assert.equal(store.getSteamGrant(user.id, account.id), null);
  assert.deepEqual(store.listSteamAccountsForUser(user.id), []);
  store.setPermissionOverrides(user.id, [], admin.id);
  time = Date.parse(expiresAt);
  assert.equal(store.getSteamGrant(user.id, account.id), null);
  assert.equal(store.listUserSteamGrants(user.id).length, 1);
  assert.equal(store.getSteamGrant(admin.id, account.id).via, 'all');
  store.replaceUserSteamGrants(user.id, [{ steamAccountId: account.id, level: 'chat', scope: 'some', peers: [] }], admin.id);
  assert.ok(store.getSteamGrant(user.id, account.id));
  assert.equal(canAccessPeer(store.getSteamGrant(user.id, account.id), peer), false);
  store.setPermissionOverrides(user.id, [{ permission: 'steam.account.all', effect: 'grant' }], admin.id);
  assert.equal(store.getSteamGrant(user.id, account.id).level, 'full');
  assert.equal(store.getSteamGrant(user.id, account.id).scope, 'all');
  store.updateUser(user.id, { disabled: true }, admin.id);
  assert.equal(store.getSteamGrant(user.id, account.id), null);
});

test('Steam grant validation is atomic and old IDs preserve existing restrictions including expired grants', (t: TestContext) => {
  let time = Date.parse('2026-06-01T00:00:00Z');
  const { store, admin, user } = fixture(t, { now: () => time });
  const account = store.upsertSteamAccount({ steamId: '76561198000000000' });
  const other = store.upsertSteamAccount({ steamId: '76561198000000001' });
  const base = { steamAccountId: account.id, level: 'chat', scope: 'some', peers: ['76561198040000001'], expiresAt: '2026-06-02T00:00:00.000Z' };
  store.replaceUserSteamGrants(user.id, [base], admin.id);
  for (const patch of [
    { steamAccountId: 999 }, { level: 'none' }, { level: 'invalid' }, { scope: 'invalid' },
    { scope: 'all' }, { peers: ['invalid'] }, { peers: [76561198040000001] },
    { peers: Array.from({ length: 501 }, (_, index) => String(76561198040000000n + BigInt(index))) },
    { expiresAt: 'invalid' }, { expiresAt: '2026-06-01T00:00:00Z' }
  ]) {
    assert.throws(() => store.replaceUserSteamGrants(user.id, [{ ...base, ...patch }], admin.id), fails(400));
    assert.equal(store.getSteamGrant(user.id, account.id).level, 'chat');
  }
  assert.throws(() => store.replaceUserSteamGrants(user.id, [base, base], admin.id), fails(400));
  assert.throws(() => store.replaceUserSteamGrants(user.id, [], user.id), fails(403));
  const before = store.listUserSteamGrants(user.id)[0];
  store.replaceUserSteamAccounts(user.id, [account.id, other.id], admin.id);
  assert.deepEqual(store.listUserSteamGrants(user.id)[0], before);
  assert.equal(store.getSteamGrant(user.id, other.id).level, 'full');
  time = Date.parse('2026-06-03T00:00:00Z');
  store.replaceUserSteamAccounts(user.id, [account.id], admin.id);
  assert.equal(store.getSteamGrant(user.id, account.id), null);
  assert.deepEqual(store.listUserSteamGrants(user.id)[0], before);
  assert.equal(store.getSteamGrant(user.id, other.id), null);
  store.replaceUserSteamGrants(user.id, [], admin.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM user_steam_account_peers').get().count, 0);
  assert.throws(() => store.createUser({ username: 'rollback', password: 'password123', steamGrants: [{ ...base, steamAccountId: 999 }] }, admin.id), fails(400));
  assert.equal(store.getUserByUsername('rollback'), null);
});

test('Steam grant managers cannot assign above their own level and all-account permission supplies full authority', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  const target = store.createUser({ username: 'target', password: 'password123' }, admin.id);
  const account = store.upsertSteamAccount({ steamId: '76561198000000000' });
  const grant = { steamAccountId: account.id, level: 'chat', scope: 'all' };
  store.setPermissionOverrides(user.id, [{ permission: 'steam.grant.manage', effect: 'grant' }], admin.id);
  store.replaceUserSteamGrants(user.id, [grant], admin.id);
  assert.throws(() => store.replaceUserSteamGrants(target.id, [{ ...grant, level: 'full' }], user.id), fails(403));
  assert.throws(() => store.replaceUserSteamAccounts(target.id, [account.id], user.id), fails(403));
  store.replaceUserSteamGrants(target.id, [grant], user.id);
  assert.equal(store.getSteamGrant(target.id, account.id).level, 'chat');
  store.setPermissionOverrides(user.id, [
    { permission: 'steam.grant.manage', effect: 'grant' }, { permission: 'steam.account.all', effect: 'grant' }
  ], admin.id);
  store.replaceUserSteamGrants(target.id, [{ ...grant, level: 'full' }], user.id);
  assert.equal(store.getSteamGrant(target.id, account.id).level, 'full');
  assert.throws(() => store.replaceUserSteamGrants(admin.id, [], user.id), fails(403));
  const overview = store.listSteamGrantOverview();
  assert.equal(overview.accounts[0].id, account.id);
  assert.equal(overview.users.find((item: PublicUser) => item.id === user.id).all, true);
  assert.equal(overview.users.find((item: PublicUser) => item.id === target.id).grants[account.id].level, 'full');
  assert.equal(store.listUsers({ roleId: 'member' }).length, 2);
  store.setPermissionOverrides(target.id, [{ permission: 'emote.manage', effect: 'grant' }], admin.id);
  store.replaceUserSteamGrants(target.id, [{ ...grant, scope: 'some', peers: ['76561198040000001'] }], admin.id);
  store.deleteUser(target.id, admin.id);
  assert.equal(store.listUserSteamGrants(target.id).length, 0);
  assert.deepEqual(store.getPermissionOverrides(target.id), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM user_steam_account_peers WHERE user_id = ?').get(target.id).count, 0);
});

test('audit filters classify actions without overlap, search literal substrings and emit safe changes', (t: TestContext) => {
  const { store, admin, user } = fixture(t);
  const actions: Record<string, string[]> = {
    grant: ['steam_account.grant_update', 'steam_account.grant_replace'],
    role: ['role.update', 'user.role.change', 'user.permission_overrides.update'],
    user: ['user.update', 'user.password.reset'],
    steam: ['steam.login', 'steam_account.update'],
    session: ['auth.login', 'session.revoke']
  };
  // Leave only deterministic records for the classification assertions.
  store.db.exec('DELETE FROM audit_logs');
  for (const action of Object.values(actions).flat()) store.recordAudit({ actorUserId: admin.id, action, targetType: 'user', targetId: 'target_%', ip: '203.0.113.5' });
  for (const [category, expected] of Object.entries(actions)) {
    assert.deepEqual(store.listAuditLogs({ category }).map((item: { action: string }) => item.action).sort(), expected.sort());
  }
  assert.equal(store.listAuditLogs({ query: 'ROOT' }).length, 11);
  assert.equal(store.listAuditLogs({ query: 'target_%' }).length, 11);
  assert.equal(store.listAuditLogs({ query: '203.0.113' }).length, 11);
  assert.equal(store.listAuditLogs({ category: 'steam', query: 'grant' }).length, 0);
  assert.equal(store.listAuditLogs({ category: 'role', query: 'role.change' }).length, 1);
  assert.throws(() => store.listAuditLogs({ category: 'unknown' }), fails(400));
  assert.throws(() => store.listAuditLogs({ category: 'constructor' }), fails(400));
  store.updateUser(user.id, { displayName: 'Name' }, admin.id);
  assert.deepEqual(store.listAuditLogs({ action: 'user.update' })[0].detail.changes, [{ field: 'displayName', before: '', after: 'Name' }]);
  store.setPermissionOverrides(user.id, [{ permission: 'emote.manage', effect: 'grant' }], admin.id);
  assert.deepEqual(store.listAuditLogs({ action: 'user.permission_overrides.update' })[0].detail.changes, [{ field: 'emote.manage', before: 'inherit', after: 'grant' }]);
  const account = store.upsertSteamAccount({ steamId: '76561198000000000' });
  store.replaceUserSteamGrants(user.id, [{ steamAccountId: account.id, level: 'read', scope: 'all' }], admin.id);
  const audit = store.listAuditLogs({ category: 'grant' })[0];
  assert.equal(audit.detail.steamAccountId, account.id);
  assert.deepEqual(audit.detail.changes[0], { field: 'level', before: 'none', after: 'read' });
  store.recordAudit({ action: 'user.update', detail: { changes: [{ field: 'password', before: 'secret', after: 'secret2' }] } });
  assert.deepEqual(store.listAuditLogs({ limit: 1 })[0].detail.changes, [{ field: 'password', before: '[redacted]', after: '[redacted]' }]);
});
