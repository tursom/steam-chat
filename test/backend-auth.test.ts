'use strict';

import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-chat-auth-'));
  return path.join(dir, 'auth.sqlite');
}

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' }
  } as IncomingMessage;
}

function cookiePair(setCookie: string) {
  return setCookie.split(';')[0];
}

test('auth setup creates the first admin once and login rejects bad or disabled users', (t: TestContext) => {
  const store = createAuthStore({ dbPath: tempDbPath() });
  t.after(() => store.close());

  assert.equal(store.requiresSetup(), true);
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  assert.equal(admin.role, 'admin');
  assert.equal(admin.disabled, false);
  assert.equal(store.requiresSetup(), false);
  assert.throws(() => store.createInitialAdmin({ username: 'next', password: 'password123' }), /already/);

  assert.equal(store.authenticate('admin', 'wrong'), null);
  assert.equal(store.authenticate('admin', 'password123').username, 'admin');
  const user = store.createUser({ username: 'worker', password: 'password123', role: 'user' });
  store.updateUser(user.id, { disabled: true });
  assert.equal(store.authenticate('worker', 'password123'), null);
});

test('session cookies reject tampering, expiry, and stale session_version', (t: TestContext) => {
  const store = createAuthStore({ dbPath: tempDbPath() });
  t.after(() => store.close());
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const sessions = createSessionManager({ store });
  const cookie = cookiePair(sessions.createSetCookie(admin));

  assert.equal(sessions.getSession(requestWithCookie(cookie))?.user.username, 'admin');
  assert.equal(sessions.getSession(requestWithCookie(`${cookie}x`)), null);

  const expiredSessions = createSessionManager({ store, maxAgeMs: -1000 });
  const expired = cookiePair(expiredSessions.createSetCookie(admin));
  assert.equal(expiredSessions.getSession(requestWithCookie(expired)), null);

  store.setPassword(admin.id, 'password456');
  assert.equal(sessions.getSession(requestWithCookie(cookie)), null);
});

test('user management protects the current user and the last enabled admin', (t: TestContext) => {
  const store = createAuthStore({ dbPath: tempDbPath() });
  t.after(() => store.close());
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123', role: 'user' });

  assert.throws(() => store.updateUser(admin.id, { role: 'user' }), /last enabled admin/);
  assert.throws(() => store.updateUser(admin.id, { disabled: true }), /last enabled admin/);
  assert.throws(() => store.deleteUser(admin.id, user.id), /last enabled admin/);
  assert.throws(() => store.deleteUser(admin.id, admin.id), /current user/);

  const admin2 = store.createUser({ username: 'admin2', password: 'password123', role: 'admin' });
  store.updateUser(admin.id, { role: 'user' });
  assert.equal(store.getUserById(admin.id).role, 'user');
  store.deleteUser(admin.id, admin2.id);
  assert.equal(store.getUserById(admin.id), null);
});

test('enhanced users support profile fields, permissions, login locking, sessions, and audit redaction', (t: TestContext) => {
  const store = createAuthStore({ dbPath: tempDbPath() });
  t.after(() => store.close());
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123', displayName: 'Root' });
  const user = store.createUser({
    username: 'worker',
    password: 'password123',
    role: 'user',
    displayName: 'Worker',
    note: 'night shift',
    createdBy: admin.id
  });

  assert.equal(store.hasPermission(admin, 'user.manage'), true);
  assert.equal(store.hasPermission(user, 'user.manage'), false);
  assert.equal(store.listUsers({ query: 'night' })[0].username, 'worker');
  assert.equal(store.listUsers({ role: 'user', status: 'enabled' }).length, 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(store.authenticate('worker', 'wrong'), null);
  }
  assert.equal(store.listUsers({ status: 'locked' })[0].username, 'worker');
  assert.throws(() => store.authenticate('worker', 'password123'), /temporarily locked/);

  store.setPassword(user.id, 'password456', { forcePasswordChange: true });
  const updated = store.getUserById(user.id);
  assert.equal(updated.forcePasswordChange, true);

  const sessions = createSessionManager({ store });
  const cookie = cookiePair(sessions.createSetCookie(admin));
  const session = sessions.getSession(requestWithCookie(cookie));
  assert.ok(session?.sessionId);
  assert.equal(store.listUserSessions(admin.id).length, 1);
  assert.equal(store.revokeSession(session?.sessionId, admin.id), true);
  assert.equal(sessions.getSession(requestWithCookie(cookie)), null);

  store.recordAudit({
    actorUserId: admin.id,
    action: 'user.password.reset',
    targetType: 'user',
    targetId: user.id,
    detail: { password: 'secret', nested: { refreshToken: 'token' } },
    ip: '203.0.113.1'
  });
  const audit = store.listAuditLogs({ action: 'user.password.reset' })[0];
  assert.equal(audit.detail.password, '[redacted]');
  assert.deepEqual(audit.detail.nested, { refreshToken: '[redacted]' });
});

test('steam accounts keep refresh tokens private and enforce explicit user grants', (t: TestContext) => {
  const store = createAuthStore({ dbPath: tempDbPath() });
  t.after(() => store.close());
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123', role: 'user' });
  const account = store.upsertSteamAccount({
    steamId: '76561198000000000',
    label: 'Support',
    accountNameHint: 'support***',
    refreshToken: 'refresh-secret',
    createdBy: admin.id,
    setActive: true
  });

  assert.equal(store.getActiveSteamAccount().id, account.id);
  assert.equal(store.getSteamAccountById(account.id).refreshToken, undefined);
  assert.equal(store.getSteamAccountById(account.id, true).refreshToken, 'refresh-secret');
  assert.equal(store.canAccessSteamAccount(admin.id, account.id), true);
  assert.equal(store.canAccessSteamAccount(user.id, account.id), false);

  store.replaceUserSteamAccounts(user.id, [account.id], admin.id);
  assert.equal(store.canAccessSteamAccount(user.id, account.id), true);
  assert.equal(store.listSteamAccountsForUser(user.id).length, 1);

  store.updateSteamAccount(account.id, { enabled: false });
  assert.equal(store.canAccessSteamAccount(user.id, account.id), false);
  assert.equal(store.listSteamAccountsForUser(user.id).length, 0);
});
