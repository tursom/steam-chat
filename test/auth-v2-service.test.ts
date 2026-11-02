import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import type { HistoryStorage } from '../src/storage/history-storage';
import type { HistoryItem, UnknownRecord } from '../src/types';

const { createAuthStore, ALL_PERMISSIONS } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const { appendLog } = require('../src/storage/chat-log');
const ACCOUNT = '76561198000000000';
const ALICE = '76561198040000001';
const BOB = '76561198040000002';
const GROUP = '103582791429521412';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
const quiet = { info() {}, warn() {}, error() {} };

async function fixture(t: TestContext, options: { storage?: HistoryStorage; waiter?: () => Promise<unknown>; now?: () => number; community?: unknown; legacy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auth-v2-service-'));
  const store = createAuthStore({ dbPath: join(dir, 'auth.db'), now: options.now });
  const root = store.createInitialAdmin({ username: 'root', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123' }, root.id);
  const account = store.upsertSteamAccount({ steamId: ACCOUNT, setActive: true });
  const sessions = createSessionManager({ store });
  const rootCookie = sessions.createSetCookie(root).split(';')[0];
  const cookie = sessions.createSetCookie(user).split(';')[0];
  const sent: string[] = [];
  const steamUser = Object.assign(new EventEmitter(), {
    myFriends: { [ALICE]: 1, [BOB]: 1 }, users: {}, myGroups: { [GROUP]: 3 },
    chat: { sendFriendMessage(id: string, msg: string, callback: (error: Error | null, result?: unknown) => void) {
      sent.push(id);
      const modified_message = /^\s*\/sticker/i.test(msg) ? '[sticker type="1"][/sticker]'
        : /^\s*\/roomeffect/i.test(msg) ? '[roomeffect type="1"][/roomeffect]' : msg;
      callback(null, { modified_message });
    } },
    _sendUnified(_method: unknown, _data: unknown, callback: (body: unknown, header: unknown) => void) {
      callback({ messages: [] }, { proto: { eresult: 1 } });
    },
    _send(_header: unknown, _body: unknown, callback: (body: unknown, header: unknown) => void) {
      callback(Buffer.alloc(0), { proto: { eresult: 1 } });
    }
  });
  const status = { status: 'online', steamId: ACCOUNT };
  const service = createChatService({ config: { host: '127.0.0.1', port: 0, wsPath: '/ws', wsHeartbeatMs: 0 },
    authStore: options.legacy ? undefined : store, sessionManager: options.legacy ? undefined : sessions,
    logPath: join(dir, 'chat.jsonl'), imageEmoteDir: join(dir, 'emotes'),
    historyStorage: options.storage, waitForLogin: options.waiter,
    sendOperationOptions: { tickMs: 5 },
    steamUser, steamCommunity: options.community || { sendImageToUser(_id: unknown, _buffer: unknown, callback: (error: Error | null, result: string) => void) {
      sent.push('image'); callback(null, 'https://steamuserimages-a.akamaihd.net/test.png');
    } }, getEmoticons: async (): Promise<{ emoticons: unknown[]; stickers: unknown[] }> => ({ emoticons: [], stickers: [] }),
    steamLoginService: { getStatus: () => status, ensureOnline() {}, login: () => status, logout: () => status, submitGuard: () => status }, logger: quiet });
  await new Promise<void>(resolve => (service.server as Server).listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  t.after(async () => { await service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(path: string, method = 'GET', body?: unknown, auth = cookie) {
    return fetch(base + path, { method, headers: { Cookie: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }
  function grant(level = 'full', scope = 'all', peers: string[] = []) {
    store.replaceUserSteamGrants(user.id, [{ steamAccountId: account.id, level, scope, peers, expiresAt: null }], root.id);
  }
  async function seed() {
    for (const [index, id] of [ALICE, BOB, GROUP].entries()) await appendLog({ steamAccountId: ACCOUNT, id, name: id,
      message: `row-${index}`, date: `2026-06-23 10:00:0${index}.000` }, { logPath: join(dir, 'chat.jsonl') });
  }
  return { store, root, user, account, sessions, cookie, rootCookie, request, grant, seed, sent, service, base, steamUser };
}

async function denied(response: Response, code?: string, required?: string) {
  assert.equal(response.status, 403);
  const body = await response.json() as UnknownRecord;
  assert.equal(body.statusCode, 403);
  if (code) assert.equal(body.code, code);
  if (required) assert.equal(body.required, required);
  return body;
}

class Inbox {
  messages: UnknownRecord[] = [];
  private waiters: Array<(value: UnknownRecord) => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      const value = JSON.parse(raw.toString()) as UnknownRecord;
      const waiter = this.waiters.shift();
      if (waiter) waiter(value); else this.messages.push(value);
    });
  }
  next(): Promise<UnknownRecord> {
    if (this.messages.length) return Promise.resolve(this.messages.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket response timed out')), 3000);
      this.waiters.push(value => { clearTimeout(timer); resolve(value); });
    });
  }
  async request(payload: UnknownRecord) { this.ws.send(JSON.stringify(payload)); return this.next(); }
}
async function connect(t: TestContext, base: string, cookie: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  const inbox = new Inbox(ws);
  t.after(() => ws.terminate());
  assert.equal((await inbox.next()).type, 'ready');
  return inbox;
}

test('v2 me/login, Steam status and WS status expose effective permissions and active grant', async t => {
  const f = await fixture(t);
  f.grant('chat', 'some', [ALICE]);
  const roleList = await f.request('/api/roles', 'GET', undefined, f.rootCookie);
  assert.equal(roleList.headers.get('cache-control'), 'no-store');
  const roles = await roleList.json();
  assert.deepEqual(roles.permissions, ALL_PERMISSIONS);
  assert.equal(roles.permissions.length, 12);
  const me = await (await f.request('/api/auth/me')).json();
  assert.equal(me.user.role, 'user');
  assert.equal(me.user.roleId, 'member');
  assert.equal(me.permissionDetails.length, 12);
  assert.deepEqual(me.steam.steamGrant, { level: 'chat', scope: 'some', peerCount: 1, expiresAt: null, via: 'grant' });
  const status = await (await f.request('/api/steam/status')).json();
  assert.deepEqual(status.steamGrant, me.steam.steamGrant);
  const login = await (await f.request('/api/auth/login', 'POST', { username: 'worker', password: 'password123' })).json();
  assert.deepEqual(login.permissions, me.permissions);
  assert.deepEqual(login.permissionDetails, me.permissionDetails);
  assert.equal(login.steam.accessAllowed, true);
  const ws = await connect(t, f.base, f.cookie);
  const wsStatus = await ws.request({ type: 'get_steam_status' });
  assert.deepEqual(wsStatus.steamGrant, me.steam.steamGrant);
  assert.deepEqual(wsStatus.permissionDetails, me.permissionDetails);
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'chat.use', effect: 'revoke' }], f.root.id);
  const revoked = await (await f.request('/api/auth/me')).json();
  assert.equal(revoked.steam.accessAllowed, false);
  assert.equal(revoked.steam.steamGrant, null);
  assert.equal(revoked.steam.activeAccount, null);
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong');
  f.service.broadcast({ type: 'steam_status' });
  assert.equal((await ws.next()).accessAllowed, false);
});

test('v2 HTTP levels enforce text, sticker/effect, images, reactions and operation gates', async t => {
  const f = await fixture(t);
  const text = { id: ALICE, msg: 'hello' };
  f.grant('read');
  const ws = await connect(t, f.base, f.cookie);
  const readSend = await ws.request({ type: 'send_message', ...text });
  assert.equal(readSend.code, 'steam_grant_insufficient');
  assert.equal(readSend.required, 'chat');
  await denied(await f.request('/message', 'POST', text), 'steam_grant_insufficient', 'chat');
  assert.equal((await f.request(`/api/message-reactions?id=${ALICE}&before=1`)).status, 200);
  await denied(await f.request('/api/message-reactions', 'POST', { id: ALICE }), 'steam_grant_insufficient', 'full');
  f.grant('chat');
  assert.equal((await ws.request({ type: 'send_message', ...text })).type, 'message');
  assert.equal((await ws.next()).type, 'message_sent');
  const sticker = await ws.request({ type: 'send_message', id: ALICE, msg: '[sticker type="1"]' });
  assert.equal(sticker.required, 'full');
  ws.ws.close();
  assert.equal((await f.request('/', 'POST', text)).status, 200);
  assert.equal((await f.request('/message', 'POST', { ...text, msg: ':smile:' })).status, 200);
  for (const msg of ['/sticker 1', ' /ROOMeffect 1', 'prefix [sticker type="1"]', '[roomeffect type="1"]']) {
    await denied(await f.request('/message', 'POST', { ...text, msg }), 'steam_grant_insufficient', 'full');
  }
  for (const endpoint of ['/image', '/img', '/api/send-operations', '/api/send-operations/upload']) {
    await denied(await f.request(endpoint, 'POST', { id: ALICE, kind: 'image', img: PNG }), 'steam_grant_insufficient', 'full');
  }
  f.grant('full');
  assert.equal((await f.request('/message', 'POST', { ...text, msg: '/sticker 1' })).status, 200);
  assert.equal((await f.request('/image', 'POST', { id: ALICE, img: PNG })).status, 200);
  assert.equal((await f.request('/api/message-reactions', 'POST', { id: ALICE, timestamp: 1, ordinal: 1, reactionType: 1, reaction: 'smile', add: true })).status, 200);
  const operation = await (await f.request('/api/send-operations', 'POST', { id: ALICE, kind: 'image' })).json();
  assert.ok(operation.id);
  f.grant('full', 'some', [BOB]);
  for (const suffix of ['', '/image']) await denied(await f.request(`/api/send-operations/${operation.id}${suffix}`), 'steam_peer_out_of_scope');
  await denied(await f.request(`/api/send-operations/${operation.id}/start`, 'POST', { img: PNG }), 'steam_peer_out_of_scope');
  f.grant('chat');
  await denied(await f.request(`/api/send-operations/${operation.id}`), 'steam_grant_insufficient', 'full');
});

test('v2 scope filters legacy HTTP/WS reads and broadcasts, denies peer reads/writes, and permits empty scope', async t => {
  const f = await fixture(t);
  await f.seed();
  f.grant('full', 'some', [ALICE]);
  assert.deepEqual((await (await f.request('/api/friends')).json()).map((x: { id: string }) => x.id), [ALICE]);
  assert.deepEqual(await (await f.request('/api/groups')).json(), []);
  for (const endpoint of ['/history', '/api/history', '/conversations', '/api/conversations']) {
    assert.deepEqual((await (await f.request(endpoint)).json()).map((x: { id: string }) => x.id), [ALICE]);
  }
  for (const endpoint of [`/history?id=${BOB}`, `/api/history?id=${BOB}`, `/api/message-reactions?id=${BOB}&before=1`]) {
    await denied(await f.request(endpoint), 'steam_peer_out_of_scope');
  }
  await denied(await f.request('/message', 'POST', { id: BOB, msg: 'hidden' }), 'steam_peer_out_of_scope');
  await denied(await f.request('/image', 'POST', { id: BOB, img: PNG }), 'steam_peer_out_of_scope');
  const ws = await connect(t, f.base, f.cookie);
  const history = await ws.request({ type: 'get_history' });
  assert.deepEqual((history.items as HistoryItem[]).map(x => x.id), [ALICE]);
  const friends = await ws.request({ type: 'get_friends' });
  assert.deepEqual((friends.friends as { id: string }[]).map(x => x.id), [ALICE]);
  assert.deepEqual((await ws.request({ type: 'get_groups' })).groups, []);
  const deniedHistory = await ws.request({ type: 'get_history', id: BOB });
  assert.equal(deniedHistory.code, 'steam_peer_out_of_scope');
  assert.equal((await ws.request({ type: 'send_message', id: BOB, msg: 'hidden' })).code, 'steam_peer_out_of_scope');
  f.service.broadcast({ type: 'message', id: BOB, steamAccountId: ACCOUNT });
  f.service.broadcast({ type: 'message', id: ALICE, steamAccountId: '76561198000000009' });
  f.service.broadcast({ type: 'message', id: ALICE, steamAccountId: ACCOUNT });
  assert.equal((await ws.next()).id, ALICE);
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong', 'hidden events must not be queued before pong');
  f.grant('read', 'some', []);
  assert.equal((await (await f.request('/api/steam/status')).json()).accessAllowed, true);
  assert.deepEqual(await (await f.request('/history')).json(), []);
  f.service.broadcast({ type: 'message', id: ALICE, steamAccountId: ACCOUNT });
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong');
});

test('v2 role, override, user and grant APIs enforce distinct permissions, compatibility and audit changes', async t => {
  const f = await fixture(t);
  const adminRequest = (path: string, method = 'GET', body?: unknown) => f.request(path, method, body, f.rootCookie);
  await denied(await f.request('/api/roles'));
  const created = await adminRequest('/api/roles', 'POST', { name: 'Support', permissions: ['user.manage', 'chat.use'] });
  assert.equal(created.status, 201);
  const role = (await created.json()).role;
  assert.equal((await adminRequest(`/api/roles/${role.id}`, 'PATCH', { description: 'support team' })).status, 200);
  const changed = await adminRequest(`/api/users/${f.user.id}`, 'PATCH', { roleId: role.id, note: 'updated' });
  assert.equal(changed.status, 200);
  assert.equal((await (await f.request('/api/auth/me')).json()).user.roleId, role.id, 'ordinary role changes retain the cookie');
  assert.equal((await f.request('/api/users')).status, 200, 'user.manage implies user.view');
  await denied(await f.request(`/api/users/${f.root.id}`, 'PATCH', { roleId: 'member' }));
  const inUse = await adminRequest(`/api/roles/${role.id}`, 'DELETE');
  assert.equal(inUse.status, 409);
  assert.equal((await inUse.json()).memberCount, 1);
  assert.equal((await adminRequest('/api/roles/member', 'PATCH', { name: 'renamed' })).status, 400);
  assert.equal((await adminRequest('/api/roles/super', 'PATCH', { permissions: [] })).status, 400);
  assert.equal((await adminRequest('/api/roles', 'POST', { name: 'Invalid', permissions: ['unknown'] })).status, 400);
  const invalidJSON = await fetch(f.base + '/api/roles', { method: 'POST', headers: { Cookie: f.rootCookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(invalidJSON.status, 400);
  assert.equal((await adminRequest(`/api/users/${f.user.id}/permission-overrides`, 'PUT', { overrides: [{ permission: 'user.view', effect: 'revoke' }] })).status, 200);
  const details = await (await adminRequest(`/api/users/${f.user.id}/permissions`)).json();
  assert.deepEqual(details.overrides, [{ permission: 'user.view', effect: 'revoke' }]);
  assert.equal(details.details.find((x: { permission: string }) => x.permission === 'user.view').source, 'implied');
  f.grant('chat', 'some', [ALICE]);
  const legacy = await adminRequest(`/api/users/${f.user.id}/steam-accounts`, 'PUT', { steamAccountIds: [f.account.id] });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).grants[0].level, 'chat');
  const grants = await adminRequest(`/api/users/${f.user.id}/steam-accounts`, 'PUT', { grants: [{ steamAccountId: f.account.id, level: 'read', scope: 'all' }] });
  assert.equal(grants.status, 200);
  assert.equal((await grants.json()).grants[0].level, 'read');
  assert.equal((await f.request('/api/steam/grants')).status, 200, 'user.view can inspect overview');
  await denied(await f.request(`/api/users/${f.user.id}/steam-accounts`, 'PUT', { grants: [] }));
  const users = await (await adminRequest(`/api/users?roleId=${role.id}`)).json();
  assert.equal(users.users.length, 1);
  assert.equal(users.users[0].steamGrantSummary[0].level, 'read');
  assert.equal((await (await adminRequest(`/api/users/${f.user.id}`)).json()).user.passwordHash, undefined);
  const audit = await (await adminRequest('/api/audit-logs?category=role&query=role.update')).json();
  assert.equal(audit.auditLogs.length, 1, 'store mutation audit must not be duplicated in service');
  assert.deepEqual(audit.auditLogs[0].detail.changes, [{ field: 'description', before: '', after: 'support team' }]);
  const grantAudit = await (await adminRequest('/api/audit-logs?category=grant')).json();
  assert.ok(grantAudit.auditLogs.some((x: { action: string }) => x.action === 'steam_account.grant_update'));
  const userAudit = await (await adminRequest('/api/audit-logs?category=user&query=user.update')).json();
  assert.deepEqual(userAudit.auditLogs[0].detail.changes, [{ field: 'note', before: '', after: 'updated' }]);
  assert.equal((await adminRequest('/api/audit-logs?category=invalid')).status, 400);
});

test('v2 no chat.use closes all chat entrances while emote.manage remains independent', async t => {
  const f = await fixture(t);
  f.grant();
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'chat.use', effect: 'revoke' }, { permission: 'emote.manage', effect: 'grant' }], f.root.id);
  for (const endpoint of ['/api/friends', '/api/groups', '/api/emoticons', '/history', '/conversations', '/api/history/status',
    '/api/messages/sync', '/proxy/image?url=https://example.org/x.png', '/proxy/sticker/1', '/api/image-emotes', `/api/message-reactions?id=${ALICE}&before=1`]) {
    await denied(await f.request(endpoint));
  }
  for (const endpoint of ['/message', '/image', '/api/send-operations']) await denied(await f.request(endpoint, 'POST', { id: ALICE, msg: 'blocked', img: PNG }));
  const emote = await f.request('/api/image-emotes', 'POST', { action: 'createGroup', version: 0, name: 'Support' });
  assert.equal(emote.status, 200, 'emote.manage works without an admin role or chat.use');
  const ws = await connect(t, f.base, f.cookie);
  for (const type of ['get_history', 'get_conversations', 'get_friends', 'get_groups', 'get_emoticons', 'send_message', 'send_image']) {
    assert.equal((await ws.request({ type, id: ALICE, msg: 'blocked' })).statusCode, 403);
  }
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'self.password.change', effect: 'revoke' }], f.root.id);
  await denied(await f.request('/api/auth/password', 'POST', { oldPassword: 'password123', newPassword: 'password456' }));
});

test('v2 pending HTTP and WS sends recheck downgrade and peer revocation after login wait', async t => {
  let release!: () => void, entered!: () => void;
  let gate = Promise.resolve();
  let notify = () => {};
  const f = await fixture(t, { waiter: () => { notify(); return gate; } });
  f.grant('full', 'some', [ALICE]);
  const arm = () => {
    gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    notify = () => entered();
    return started;
  };
  const started = arm();
  const sending = f.request('/message', 'POST', { id: ALICE, msg: 'must stop' });
  await started;
  f.grant('read', 'some', [ALICE]);
  release();
  await denied(await sending, 'steam_grant_insufficient', 'chat');
  assert.deepEqual(f.sent, []);
  f.grant('full', 'some', [ALICE]);
  const ws = await connect(t, f.base, f.cookie);
  const wsStarted = arm();
  const response = ws.request({ type: 'send_message', id: ALICE, msg: 'must stop too' });
  await wsStarted;
  f.grant('full', 'some', [BOB]);
  release();
  assert.equal((await response).code, 'steam_peer_out_of_scope');
  assert.deepEqual(f.sent, []);
});

test('v2 text retry rechecks live grant before calling Steam again', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.steamUser.chat.sendFriendMessage = (_id, _msg, callback) => {
    calls++;
    f.grant('read');
    callback(new Error('network timeout'));
  };
  f.grant('chat');
  await denied(await f.request('/message', 'POST', { id: ALICE, msg: 'stop retry' }), 'steam_grant_insufficient', 'chat');
  assert.equal(calls, 1);
  f.grant('chat');
  const ws = await connect(t, f.base, f.cookie);
  const reply = await ws.request({ type: 'send_message', id: ALICE, msg: 'stop retry' });
  assert.equal(reply.code, 'steam_grant_insufficient');
  assert.equal(calls, 2);
});

test('v2 installed SDK image transport rechecks grants before commit for direct and operation sends', async t => {
  for (const entry of ['/image', '/api/send-operations/upload']) await t.test(entry, async t => {
    const SteamCommunity = require('steamcommunity');
    const community = new SteamCommunity();
    const calls: string[] = [];
    const f = await fixture(t, { community });
    f.grant('full', 'some', [ALICE]);
    community.getSessionID = () => 'local-test-session';
    let uploaded!: () => void;
    const uploadReached = new Promise<void>(resolve => { uploaded = resolve; });
    community.request = (options: { uri: string }, complete: (error: unknown, response: unknown, body: unknown) => void) => {
      const phase = options.uri.includes('beginfileupload') ? 'begin' : options.uri.includes('commitfileupload') ? 'commit' : 'upload';
      calls.push(phase);
      if (phase === 'upload') f.grant('chat', 'some', [ALICE]);
      const body: unknown = phase === 'begin' ? { success: 1, hmac: 'local-test-hmac', timestamp: 1,
        result: { ugcid: '1', url_host: 'upload.invalid', url_path: '/local', use_https: true, request_headers: [] } }
        : phase === 'commit' ? { success: 1, result: { success: 1, details: { url: 'https://example.invalid/image.png' } } } : '';
      complete(null, { statusCode: 200, headers: {} }, body);
      if (phase === 'upload') uploaded();
    };
    const response = await f.request(entry, 'POST', { operationId: 'a'.repeat(32), kind: 'image', id: ALICE, img: PNG });
    if (entry === '/image') await denied(response, 'steam_grant_insufficient', 'full');
    else {
      assert.equal(response.status, 202);
      await uploadReached;
      await denied(await f.request(`/api/send-operations/${'a'.repeat(32)}`), 'steam_grant_insufficient', 'full');
    }
    assert.deepEqual(calls, ['begin', 'upload'], 'grant downgrade must prevent commit');
  });
});

test('v2 expiry and disabled accounts suspend reads and WS broadcasts without revoking the session', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  f.store.replaceUserSteamGrants(f.user.id, [{ steamAccountId: f.account.id, level: 'read', scope: 'some', peers: [ALICE],
    expiresAt: new Date(now + 1000).toISOString() }], f.root.id);
  const ws = await connect(t, f.base, f.cookie);
  assert.equal((await f.request('/api/friends')).status, 200);
  now += 1001;
  await denied(await f.request('/api/friends'), 'steam_grant_insufficient', 'read');
  f.service.broadcast({ type: 'message', steamAccountId: ACCOUNT, id: ALICE });
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong');
  assert.equal((await (await f.request('/api/steam/status')).json()).accessAllowed, false);
  f.grant('read');
  f.store.updateSteamAccount(f.account.id, { enabled: false });
  await denied(await f.request('/history'), 'steam_grant_insufficient', 'read');
  f.store.updateSteamAccount(f.account.id, { enabled: true });
  assert.equal((await f.request('/api/friends')).status, 200);
});

test('v2 account.all and Steam management visibility follow permissions for a non-admin role', async t => {
  const f = await fixture(t);
  await f.seed();
  const role = f.store.createRole({ name: 'All accounts', permissions: ['chat.use', 'steam.account.all'] }, f.root.id);
  f.store.updateUser(f.user.id, { roleId: role.id }, f.root.id);
  const me = await (await f.request('/api/auth/me')).json();
  assert.equal(me.user.role, 'user');
  assert.equal(me.steam.steamGrant.via, 'all');
  assert.equal(me.steam.steamGrant.level, 'full');
  assert.equal((await (await f.request('/history')).json()).length, 3);
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'chat.use', effect: 'revoke' }, { permission: 'steam.manage', effect: 'grant' }], f.root.id);
  const manage = await (await f.request('/api/steam/status')).json();
  assert.equal(manage.accessAllowed, false);
  assert.equal(manage.steamGrant, null);
  assert.equal(manage.activeAccount.id, f.account.id, 'steam.manage can inspect the active account without chat access');
  await denied(await f.request('/history'));
});

test('v2 legacy mode retains full/all HTTP and WS capabilities', async t => {
  const f = await fixture(t, { legacy: true });
  await f.seed();
  const status = await (await f.request('/api/steam/status')).json();
  assert.equal(status.accessAllowed, true);
  assert.deepEqual(status.steamGrant, { level: 'full', scope: 'all', peerCount: 0, expiresAt: null, via: 'all' });
  assert.equal((await f.request('/message', 'POST', { id: ALICE, msg: '/sticker 1' })).status, 200);
  assert.equal((await f.request('/image', 'POST', { id: BOB, img: PNG })).status, 200);
  assert.equal((await (await f.request('/api/friends')).json()).length, 2);
  const ws = await connect(t, f.base, '');
  assert.equal((await ws.request({ type: 'send_image', id: ALICE, img: PNG })).type, 'image_sent');
});

test('v2 image emote library uses emote.manage and sending its images still requires full', async t => {
  const f = await fixture(t);
  f.grant('chat');
  await denied(await f.request('/api/image-emotes', 'POST', { action: 'createGroup', version: 0, name: 'Support' }));
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'emote.manage', effect: 'grant' }], f.root.id);
  const group = await (await f.request('/api/image-emotes', 'POST', { action: 'createGroup', version: 0, name: 'Support' })).json();
  const catalog = await (await f.request('/api/image-emotes', 'POST', { action: 'addImage', version: group.version,
    groupId: group.groups[0].id, name: 'one pixel', data: 'data:image/png;base64,' + PNG })).json();
  const emoteId = catalog.images[0].id;
  assert.equal((await f.request('/api/image-emotes/file/' + emoteId)).status, 200);
  await denied(await f.request('/image', 'POST', { id: ALICE, emoteId }), 'steam_grant_insufficient', 'full');
  const ws = await connect(t, f.base, f.cookie);
  assert.equal((await ws.request({ type: 'send_image', id: ALICE, emoteId })).required, 'full');
  f.grant('full');
  assert.equal((await f.request('/image', 'POST', { id: ALICE, emoteId })).status, 200);
  assert.equal((await ws.request({ type: 'send_image', id: ALICE, emoteId })).type, 'image_sent');
});

test('v2 logout-all can preserve the current cookie and default still revokes it', async t => {
  const f = await fixture(t);
  const other = f.sessions.createSetCookie(f.user).split(';')[0];
  const keep = await f.request('/api/auth/logout-all', 'POST', { keepCurrentSession: true });
  assert.equal(keep.status, 200);
  assert.equal(keep.headers.get('set-cookie'), null);
  assert.equal((await (await f.request('/api/auth/me')).json()).user.id, f.user.id);
  assert.equal((await (await f.request('/api/auth/me', 'GET', undefined, other)).json()).user, null);
  const all = await f.request('/api/auth/logout-all', 'POST');
  assert.equal(all.status, 200);
  assert.match(all.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal((await (await f.request('/api/auth/me')).json()).user, null);
});

function storageFixture() {
  const rows = [ALICE, BOB, GROUP].map((id, index): HistoryItem => ({ id, steamAccountId: ACCOUNT, type: 'message', message: `row-${index}`,
    name: id, date: `2026-06-23 10:00:0${index}.000`, ordinal: 0, echo: false }));
  let onMessage = (_item: HistoryItem) => {};
  let onDurable = (_item: HistoryItem) => {};
  const storage: HistoryStorage = {
    append: input => input as HistoryItem, canSend: () => true, close: async () => {},
    status: () => ({ jsonl: { state: 'healthy', queued: 0, writable: true, durable: 0, missed: 0 }, rocksdb: { state: 'healthy', queued: 0, writable: true, durable: 0, missed: 0 } }),
    history: async input => ({ items: rows.filter(item => item.id === input.id), nextCursor: 'history-cursor' }),
    conversations: async input => input.before ? { items: [] } : ({ items: rows.map(item => ({ id: item.id, name: item.name, updatedAt: item.date, preview: item.message,
      lastType: item.type, lastEcho: false, messageCount: 1 })), nextCursor: 'conversation-cursor' }),
    sync: async () => ({ items: rows.map((row, i) => ({ ...row, syncId: String(i + 1) })), nextCursor: 'after-hidden-rows', hasMore: false, steamAccountId: ACCOUNT }),
    onMessage: callback => { onMessage = callback; return () => {}; }, onDurable: callback => { onDurable = callback; return () => {}; }, onStatus: () => () => {}
  };
  return { storage, emit: (index: number) => { onMessage(rows[index]); onDurable(rows[index]); } };
}

test('v2 storage pages and sync filter rows without stalling cursors, including durable broadcasts', async t => {
  const storage = storageFixture();
  const f = await fixture(t, { storage: storage.storage });
  f.grant('read', 'some', [ALICE]);
  const sync = await (await f.request('/api/messages/sync')).json();
  assert.deepEqual(sync.items.map((x: HistoryItem) => x.id), [ALICE]);
  assert.equal(sync.nextCursor, 'after-hidden-rows');
  assert.equal(sync.hasMore, false);
  const conversations = await (await f.request('/api/conversations')).json();
  assert.deepEqual(conversations.items.map((x: { id: string }) => x.id), [ALICE]);
  assert.match(conversations.nextCursor, /^sc1\./, 'restricted conversation cursors must not disclose index peer IDs');
  const nextPage = await f.request('/api/conversations?before=' + encodeURIComponent(conversations.nextCursor));
  assert.equal(nextPage.status, 200);
  assert.deepEqual((await nextPage.json()).items, []);
  await denied(await f.request(`/api/history?id=${BOB}`), 'steam_peer_out_of_scope');
  const global = await (await f.request('/api/history')).json();
  assert.deepEqual(global.items.map((x: { id: string }) => x.id), [ALICE]);
  const ws = await connect(t, f.base, f.cookie);
  const page = await ws.request({ type: 'get_history_page', id: ALICE });
  assert.deepEqual((page.items as HistoryItem[]).map(x => x.id), [ALICE]);
  storage.emit(1);
  storage.emit(0);
  assert.equal((await ws.next()).id, ALICE);
  assert.equal((await ws.next()).type, 'sync_available');
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong');
  f.store.replaceUserSteamGrants(f.user.id, [], f.root.id);
  storage.emit(0);
  assert.equal((await ws.request({ type: 'ping' })).type, 'pong');
});

test('v2 HTTP and WS history recheck peer scope after storage awaits', async t => {
  const storage = storageFixture();
  const original = storage.storage.history;
  let entered = () => {}, release = () => {};
  storage.storage.history = async input => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return original(input);
  };
  const f = await fixture(t, { storage: storage.storage });
  f.grant('read', 'some', [ALICE]);
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = f.request(`/api/history?id=${ALICE}`);
  await started;
  f.grant('read', 'some', [BOB]);
  release();
  await denied(await response, 'steam_peer_out_of_scope');
  f.grant('read', 'some', [ALICE]);
  const ws = await connect(t, f.base, f.cookie);
  const wsStarted = new Promise<void>(resolve => { entered = resolve; });
  const wsResponse = ws.request({ type: 'get_history_page', id: ALICE });
  await wsStarted;
  f.grant('read', 'some', [BOB]);
  release();
  assert.equal((await wsResponse).code, 'steam_peer_out_of_scope');
});
