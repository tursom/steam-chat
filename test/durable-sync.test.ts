import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { WebSocket } from 'ws';
import { RocksHistoryStore } from '../src/storage/rocks-history';
import { createHistoryStorage } from '../src/storage/history-storage';
import { normalizeStoredMessage } from '../src/storage/history-message';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const account = '76561198000000001';
const peer = '76561198000000002';
const other = '76561198000000003';
const quiet = { info() {}, warn() {}, error() {} };
const record = (n: number, extra = {}) => normalizeStoredMessage({ steamAccountId: account, id: peer,
  name: 'Peer', message: `message ${n}`, sentAt: new Date(1700000000000 + n).toISOString(),
  eventId: n.toString(16).padStart(32, '0'), ...extra });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Timed out');
}
const reset = (error: any) => error.statusCode === 409 && error.resetRequired === true;

test('sync storage: >500 rows, ingestion order, retries, empty cursor, restart and generation/account binding', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new RocksHistoryStore(join(dir, 'db'));
  try {
    const empty = await store.sync({ steamAccountId: account });
    assert.equal(typeof empty.nextCursor, 'string');
    assert.equal(empty.hasMore, false);
    for (let n = 1; n <= 507; n++) await store.put(record(n, { id: n % 2 ? peer : other }));
    await store.put(record(600, { steamAccountId: other }));
    const first = await store.sync({ steamAccountId: account, cursor: empty.nextCursor, limit: 900 });
    assert.equal(first.items.length, 500);
    assert.equal(first.hasMore, true);
    assert.equal(new Set(first.items.map((i) => i.syncId)).size, 500);
    assert.ok(first.items.every((i) => i.syncId === i.eventId && i.steamAccountId === account));
    await store.close();
    store = new RocksHistoryStore(join(dir, 'db'));
    const last = await store.sync({ steamAccountId: account, cursor: first.nextCursor });
    assert.deepEqual(last.items.map((i) => i.message), Array.from({ length: 7 }, (_, i) => `message ${501 + i}`));
    assert.equal(last.hasMore, false);
    const older = record(700, { sentAt: '2000-01-01T00:00:00.000Z' });
    await store.put(older);
    await store.put(older);
    const late = await store.sync({ steamAccountId: account, cursor: last.nextCursor });
    assert.deepEqual(late.items, [{ ...older, syncId: older.eventId }]);
    const end = await store.sync({ steamAccountId: account, cursor: late.nextCursor });
    assert.equal(end.nextCursor, late.nextCursor);
    assert.deepEqual(end.items, []);
    await assert.rejects(store.sync({ steamAccountId: other, cursor: last.nextCursor }), reset);
    for (const cursor of ['', 'garbage', last.nextCursor + '=']) {
      await assert.rejects(store.sync({ steamAccountId: account, cursor }), reset);
    }
    for (const limit of [0, -1, 1.5, NaN]) await assert.rejects(store.sync({ steamAccountId: account, limit }), /limit/);
    const fresh = new RocksHistoryStore(join(dir, 'fresh'));
    try { await assert.rejects(fresh.sync({ steamAccountId: account, cursor: last.nextCursor }), reset); }
    finally { await fresh.close(); }
  } finally { await store.close(); }
});

test('schema 1 sync backfill is bounded, restartable and preserves allocator order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  const old = new RocksHistoryStore(path);
  try {
    for (let n = 1; n <= 503; n++) await old.put(record(n, { sentAt: new Date(1800000000000 - n).toISOString() }));
  } finally { await old.close(); }
  const raw = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  try {
    await raw.transaction(async (txn) => {
      const meta = JSON.parse((await txn.get(Buffer.from([1, 1]))).toString());
      meta.value.schemaVersion = 1;
      await txn.put(Buffer.from([1, 1]), Buffer.from(JSON.stringify(meta)));
      for (const { key } of txn.getRange({ start: Buffer.from([0x22]), end: Buffer.from([0x23]) })) await txn.remove(key);
    });
    await raw.flush({ allowWriteStall: true });
  } finally { raw.close(); }
  const original = RocksDatabase.prototype.flush;
  RocksDatabase.prototype.flush = async function (options) {
    await original.call(this, options);
    throw new Error('interrupted after durable backfill batch');
  };
  const interrupted = new RocksHistoryStore(path);
  try { await assert.rejects(interrupted.ready(), /interrupted/); }
  finally { RocksDatabase.prototype.flush = original; await interrupted.close(); }
  const inspect = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  try {
    assert.ok(await inspect.get(Buffer.from([1, 3])));
    assert.equal([...inspect.getRange({ start: Buffer.from([0x22]), end: Buffer.from([0x23]) })].length, 500);
  } finally { inspect.close(); }
  const upgraded = new RocksHistoryStore(path);
  try {
    const first = await upgraded.sync({ steamAccountId: account, limit: 500 });
    assert.deepEqual(first.items.map((i) => i.message), Array.from({ length: 500 }, (_, i) => `message ${i + 1}`));
    const last = await upgraded.sync({ steamAccountId: account, cursor: first.nextCursor });
    assert.deepEqual(last.items.map((i) => i.message), ['message 501', 'message 502', 'message 503']);
    await upgraded.put(record(504, { sentAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal((await upgraded.sync({ steamAccountId: account, cursor: last.nextCursor })).items[0].message, 'message 504');
  } finally { await upgraded.close(); }
});

test('sync refuses to advance over a committed write while its durability flush fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-flush-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RocksHistoryStore(join(dir, 'db'));
  await store.ready();
  const original = RocksDatabase.prototype.flush;
  try {
    RocksDatabase.prototype.flush = async () => { throw new Error('flush failed'); };
    await assert.rejects(store.put(record(1)), /flush failed/);
    await assert.rejects(store.sync({ steamAccountId: account }), /flush failed/);
    RocksDatabase.prototype.flush = original;
    assert.equal((await store.sync({ steamAccountId: account })).items.length, 1);
  } finally { RocksDatabase.prototype.flush = original; await store.close(); }
});

test('actual HTTP/worker sync: offline granted account, pages, cursor errors, durable hints, image URL and live revocation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db');
  const seed = new RocksHistoryStore(dbPath);
  try {
    for (let n = 1; n <= 502; n++) await seed.put(record(n));
    await seed.put(record(600, { steamAccountId: other }));
  } finally { await seed.close(); }
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = auth.createUser({ username: 'reader', password: 'password123', role: 'user' });
  const active = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const second = auth.upsertSteamAccount({ steamId: other });
  const sessions = createSessionManager({ store: auth });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  const storage = createHistoryStorage({ dbPath, logPath: join(dir, 'chat.jsonl'), logger: quiet });
  const sourceUrl = 'https://images.steamusercontent.com/ugc/123/image.png';
  let loginWait: Promise<void> = Promise.resolve();
  let sends = 0;
  const service = createChatService({ historyStorage: storage, authStore: auth, sessionManager: sessions,
    waitForLogin: () => loginWait,
    steamUser: { sendFriendMessage: async () => { sends++; return {}; } },
    steamCommunity: { sendImageToUser(_id: string, buffer: Buffer, options: unknown, callback: (e: unknown, result: string) => void) {
      assert.equal(buffer.toString(), 'abc'); assert.deepEqual(options, {}); callback(null, sourceUrl);
    } },
    steamLoginService: { getStatus: () => ({ status: 'offline', steamId: null as string | null }), ensureOnline() {} },
    chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet });
  service.start();
  await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = (path: string, body?: unknown) => fetch(base + path, { headers: { Cookie: cookie },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  let ws: WebSocket | undefined;
  try {
    assert.equal((await fetch(base + '/api/messages/sync')).status, 401);
    assert.equal((await request('/api/messages/sync')).status, 403);
    auth.replaceUserSteamAccounts(user.id, [active.id, second.id], admin.id);
    const firstResponse = await request('/api/messages/sync?limit=999');
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
    const first = await firstResponse.json();
    assert.deepEqual(Object.keys(first).sort(), ['hasMore', 'items', 'nextCursor', 'steamAccountId']);
    assert.equal(first.items.length, 500);
    assert.equal(first.hasMore, true);
    assert.equal(first.steamAccountId, account);
    assert.equal((await (await request('/api/messages/sync')).json()).items.length, 100);
    const last = await (await request(`/api/messages/sync?cursor=${first.nextCursor}`)).json();
    assert.equal(last.items.length, 2);
    assert.equal(last.hasMore, false);
    for (const value of ['0', '-1', '1.5', 'NaN', '']) assert.equal((await request(`/api/messages/sync?limit=${value}`)).status, 400);
    for (const cursor of ['bad', '']) {
      const response = await request(`/api/messages/sync?cursor=${cursor}`);
      assert.equal(response.status, 409); assert.equal((await response.json()).resetRequired, true);
    }
    auth.setActiveSteamAccount(second.id);
    const cross = await request(`/api/messages/sync?cursor=${last.nextCursor}`);
    assert.equal(cross.status, 409); assert.equal((await cross.json()).resetRequired, true);
    auth.setActiveSteamAccount(active.id);
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    await until(() => storage.canSend());
    storage.append(record(700, { sentAt: '2000-01-01T00:00:00.000Z' }), { notify: false });
    await until(() => messages.some((m) => m.type === 'sync_available'));
    assert.equal(messages.some((m) => m.eventId === record(700).eventId), false);
    const late = await (await request(`/api/messages/sync?cursor=${last.nextCursor}`)).json();
    assert.equal(late.items[0].syncId, record(700).eventId);
    const sent = await (await request('/image', { id: peer, img: 'YWJj' })).json();
    assert.equal(sent.ok, true); assert.equal(sent.item.type, 'image'); assert.equal(sent.item.message, sourceUrl);
    await until(() => storage.status().rocksdb.durable >= 2 && storage.status().jsonl.durable >= 2);
    const imagePage = await (await request(`/api/messages/sync?cursor=${late.nextCursor}`)).json();
    assert.equal(imagePage.items[0].message, sourceUrl);
    assert.equal(imagePage.items[0].syncId, sent.item.eventId);
    const log = (await readFile(join(dir, 'chat.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(log.some((i) => i.eventId === sent.item.eventId && i.message === sourceUrl && i.type === 'image'));
    auth.replaceUserSteamAccounts(user.id, [], admin.id);
    await delay(30);
    const count = messages.length;
    storage.append(record(701));
    await until(() => storage.status().rocksdb.durable >= 3);
    await delay(30);
    assert.equal(messages.length, count);
    assert.equal((await request('/api/messages/sync')).status, 403);
    ws.send(JSON.stringify({ type: 'get_history_page', id: peer, requestId: 'denied' }));
    await until(() => messages.some((m) => m.requestId === 'denied'));
    assert.equal(messages.find((m) => m.requestId === 'denied').statusCode, 403);
    auth.replaceUserSteamAccounts(user.id, [active.id], admin.id);
    let release!: () => void;
    loginWait = new Promise<void>((resolve) => { release = resolve; });
    ws.send(JSON.stringify({ type: 'send_message', id: peer, msg: 'revoked while waiting', requestId: 'waiting' }));
    await delay(30);
    auth.replaceUserSteamAccounts(user.id, [], admin.id);
    release();
    await until(() => messages.some((m) => m.requestId === 'waiting'));
    assert.equal(messages.find((m) => m.requestId === 'waiting').statusCode, 403);
    assert.equal(sends, 0);
    auth.replaceUserSteamAccounts(user.id, [active.id], admin.id);
    const closed = once(ws, 'close');
    auth.revokeUserSessions(user.id, admin.id);
    storage.append(record(702));
    assert.equal((await closed)[0], 1008);
    assert.equal((await request('/api/messages/sync')).status, 401);
  } finally { ws?.terminate(); await service.stop(); await storage.close(); auth.close(); }
});

test('sync never falls back to legacy LAN/basic authentication', async () => {
  const service = createChatService({ chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet });
  service.start(); await once(service.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/messages/sync`);
    assert.equal(response.status, 401);
  } finally { await service.stop(); }
});
