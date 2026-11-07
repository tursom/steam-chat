import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { HistoryRecordInput } from '../src/types';

const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const account = '76561198000000002';
const peer = '76561198000000001';
const other = '76561198000000003';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'text-check-'));
  const store = createAuthStore({ dbPath: join(directory, 'auth.sqlite') });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = store.createUser({ username: 'reader', password: 'password123' }, admin.id);
  const active = store.upsertSteamAccount({ steamId: account, setActive: true });
  store.replaceUserSteamGrants(user.id, [{ steamAccountId: active.id, level: 'read', scope: 'some', peers: [peer], expiresAt: null }], admin.id);
  const sessions = createSessionManager({ store });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  const at = new Date(Date.now() - 5 * 60_000);
  const actual = { sender: account, message: 'delivered earlier', server_timestamp: at, ordinal: 7 };
  let response: unknown = { messages: [...Array.from({ length: 40 }, () => ({ ...actual, message: 'other text' })), actual] };
  let beforeReply: () => void = () => {};
  let failure = false;
  let reads = 0;
  let sends = 0;
  let rejectText = false;
  const records: HistoryRecordInput[] = [];
  const status = { status: 'online', steamId: account };
  const steamUser = Object.assign(new EventEmitter(), { steamID: account, chat: {
    sendFriendMessage(_id: string, _text: string, callback: (error: unknown) => void) {
      sends++;
      if (rejectText) callback(Object.assign(new Error('RateLimitExceeded'), { eresult: 84 }));
      else throw new Error('checking must never send');
    },
    getFriendMessageHistory(id: string, options: unknown, callback: (error: unknown, response?: unknown) => void) {
      reads++;
      assert.equal(id, peer);
      assert.deepEqual(options, { maxCount: 100, wantBbcode: true });
      queueMicrotask(() => { beforeReply(); callback(failure ? new Error('private upstream response') : null, response); });
    }
  } });
  const service = createChatService({ authStore: store, sessionManager: sessions, steamUser,
    config: { host: '127.0.0.1', port: 0, wsHeartbeatMs: 0 }, logger: { info() {}, warn() {}, error() {} },
    historyStorage: { canSend: () => true, append(record: HistoryRecordInput) {
      records.push(record); return { ...record, eventId: 'actual-steam-event' };
    }, onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {} },
    steamLoginService: { getStatus: () => status, ensureOnline() {
      if (status.status !== 'online') throw Object.assign(new Error('Steam offline'), { statusCode: 503 });
    } }, getSelfName: async () => 'Self'
  });
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  t.after(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const body = { id: peer, msg: actual.message, sentAt: at.toISOString(), steamAccountId: account };
  const request = (changes: Record<string, unknown> = {}, authenticated = true, method = 'POST') => fetch(`${base}/api/messages/check`, {
    method, headers: { ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ ...body, ...changes }) } : {})
  });
  return { request, records, body, actual, counts: () => ({ reads, sends }), setResponse(value: unknown) { response = value; },
    send: () => fetch(`${base}/message`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    rejectText() { rejectText = true; }, offline() { status.status = 'offline'; },
    grantChat() { store.replaceUserSteamGrants(user.id, [{ steamAccountId: active.id, level: 'chat', scope: 'some', peers: [peer], expiresAt: null }], admin.id); },
    fail() { failure = true; }, beforeReply(callback: () => void) { beforeReply = callback; },
    revoke() { store.replaceUserSteamGrants(user.id, [], admin.id); },
    switchAccount() { store.upsertSteamAccount({ steamId: other, setActive: true }); steamUser.steamID = status.steamId = other; } };
}

test('manual text check reads Steam history for a read-only scoped user without sending', async t => {
  const f = await fixture(t);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await response.json();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].eventId, 'actual-steam-event');
  assert.equal(result.items[0].sentAt, f.body.sentAt);
  assert.equal(f.records.length, 1);
  assert.deepEqual(f.counts(), { reads: 1, sends: 0 });
});

test('manual check distinguishes no matching record from unavailable Steam history', async t => {
  const f = await fixture(t);
  f.setResponse({ messages: [] });
  assert.deepEqual(await (await f.request()).json(), { items: [] });
  f.fail();
  const failure = await f.request();
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private upstream response/);
  assert.deepEqual(f.counts(), { reads: 2, sends: 0 });
  assert.equal(f.records.length, 0);
});

test('text HTTP errors identify explicit rejection and pre-submission offline state as not sent', async t => {
  const f = await fixture(t);
  f.grantChat(); f.rejectText();
  const rejected = await f.send();
  assert.equal(rejected.status, 500);
  assert.equal((await rejected.json()).uncertain, false);
  assert.deepEqual(f.counts(), { reads: 0, sends: 1 });
  f.offline();
  const offline = await f.send();
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).uncertain, false);
  assert.deepEqual(f.counts(), { reads: 0, sends: 1 });
});

test('manual check validates request, original account, method, session and friend scope before reading', async t => {
  const f = await fixture(t);
  for (const changes of [{ msg: '' }, { sentAt: 'invalid' }, { sentAt: new Date(Date.now() + 300_000).toISOString() },
    { sentAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }, { id: 'invalid' }]) {
    assert.equal((await f.request(changes)).status, changes.id === 'invalid' ? 403 : 400);
  }
  assert.equal((await f.request({ steamAccountId: other })).status, 409);
  assert.equal((await f.request({ id: other })).status, 403);
  assert.equal((await f.request({}, false)).status, 401);
  assert.equal((await f.request({}, true, 'GET')).status, 405);
  assert.deepEqual(f.counts(), { reads: 0, sends: 0 });
});

for (const change of ['revoke', 'switchAccount'] as const) {
  test(`manual check rechecks ${change} after the Steam read`, async t => {
    const f = await fixture(t);
    f.beforeReply(() => f[change]());
    const response = await f.request();
    assert.ok([403, 409].includes(response.status));
    assert.equal(f.records.length, 0);
    assert.deepEqual(f.counts(), { reads: 1, sends: 0 });
  });
}
