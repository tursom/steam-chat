import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const allPermissions = ['user.view', 'user.manage', 'role.manage', 'session.manage', 'audit.view', 'steam.manage',
  'steam.account.manage', 'steam.grant.manage', 'steam.account.all', 'chat.use', 'emote.manage', 'self.password.change'];
const pages = ['accounts', 'users', 'roles', 'audit', 'emotes', 'settings'];

function harness() {
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  const requests: string[] = [];
  let payload: unknown = {};
  const sandbox: any = {
    document: { querySelector: (selector: string): object | null => selector === '#app' ? {} : null, querySelectorAll: (): unknown[] => [], addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (): null => null, setItem() {} },
    Headers, AbortController, URL, URLSearchParams, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (path: string) => {
      requests.push(path);
      return { ok: path === '/api/auth/me', status: path === '/api/auth/me' ? 200 : 403,
        json: async () => path === '/api/auth/me' ? payload : { code: path.slice(1), error: '授权已更改，请刷新' } };
    }
  };
  const marker = source.indexOf('\nbootstrap().catch');
  assert.ok(marker > 0, 'execute the complete browser program before its top-level bootstrap');
  runInNewContext(`${source.slice(0, marker)}
    invalidateChat = updateChatLists = updateChatAvailability = refreshReactionBars = () => {};
    refreshChatData = async () => {};
    updateSteamStatus = status => { state.steam = status; };
    globalThis.testApi = { state, normalizeView, canOpenView, grantAtLeast, currentSteamGrant, hasPermission, api };
  `, sandbox);
  return { ...sandbox.testApi, requests, respondWith: (value: unknown) => { payload = value; } };
}

test('persisted legacy views normalize to the new console pages', () => {
  const h = harness();
  for (const [old, current] of Object.entries({ steam: 'accounts', steamAccounts: 'accounts', account: 'settings', imageEmotes: 'emotes' })) {
    assert.equal(h.normalizeView(old), current);
    assert.equal(h.normalizeView(current), current);
  }
  for (const value of ['chat', ...pages]) assert.equal(h.normalizeView(value), value);
  for (const value of ['', null, undefined, 'admin', '__proto__', 'constructor']) assert.equal(h.normalizeView(value), 'chat');
});

for (const identity of [
  { label: 'super', permissions: allPermissions, level: 'full', scope: 'all', pages },
  { label: 'chat with scoped peers and personal emote permission', permissions: ['chat.use', 'emote.manage', 'self.password.change'],
    level: 'chat', scope: 'some', pages: ['emotes', 'settings'] },
  { label: 'read only', permissions: ['chat.use', 'self.password.change'], level: 'read', scope: 'all', pages: ['settings'] }
]) {
  test(`${identity.label}: effective permissions and grant level govern navigation and capabilities`, () => {
    const h = harness();
    // A misleading legacy role must never override the effective permissions.
    h.state.me = { id: 1, username: 'Fixture', role: identity.label === 'super' ? 'user' : 'admin' };
    h.state.permissions = identity.permissions;
    h.state.steam = { status: 'online', accessAllowed: true, steamGrant: { level: identity.level, scope: identity.scope, peerCount: 1, expiresAt: null } };
    assert.deepEqual(pages.filter(page => h.canOpenView(page)), identity.pages);
    assert.equal(h.grantAtLeast('read'), true);
    assert.equal(h.grantAtLeast('chat'), identity.level !== 'read');
    assert.equal(h.grantAtLeast('full'), identity.level === 'full');
    h.state.permissions = [];
    assert.equal(h.grantAtLeast('read'), false, 'chat.use remains required even with a Steam grant');
  });
}

test('account navigation honors each independent management permission and user.view opens roles read-only', () => {
  const h = harness();
  for (const permission of ['steam.manage', 'steam.account.manage', 'steam.grant.manage']) {
    h.state.permissions = [permission];
    assert.equal(h.canOpenView('accounts'), true, permission);
    assert.equal(h.canOpenView('users'), false);
  }
  h.state.permissions = ['user.view'];
  assert.equal(h.canOpenView('users'), true);
  assert.equal(h.canOpenView('roles'), true);
  assert.equal(h.canOpenView('audit'), false);
});

for (const code of ['steam_grant_insufficient', 'steam_peer_out_of_scope']) {
  test(`${code}: concurrent denials refresh me once and apply current permissions and grant`, async () => {
    const h = harness();
    h.state.view = 'chat'; h.state.me = { id: 1 }; h.state.permissions = allPermissions;
    h.state.steam = { status: 'online', accessAllowed: true };
    h.respondWith({ user: { id: 1, username: 'Reader' }, permissions: ['chat.use'],
      permissionDetails: [{ permission: 'chat.use', effective: true, source: 'role' }],
      steam: { status: 'online', accessAllowed: true, steamGrant: { level: 'read', scope: 'some', peerCount: 1, expiresAt: null } } });
    await Promise.all([1, 2].map(async () => {
      await assert.rejects(h.api(`/${code}`, { method: 'POST' }), /授权已更改，请刷新/);
    }));
    assert.deepEqual(h.requests, [`/${code}`, `/${code}`, '/api/auth/me']);
    assert.deepEqual(Array.from(h.state.permissions), ['chat.use']);
    assert.equal(h.state.permissionDetails[0].source, 'role');
    assert.equal(h.grantAtLeast('read'), true);
    assert.equal(h.grantAtLeast('chat'), false);
  });
}
