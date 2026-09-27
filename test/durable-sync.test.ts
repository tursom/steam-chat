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
import { accountPrefix, encodeCursor, historySyncKey, messageKey } from '../src/storage/history-key';
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

test('history sync: time order across peers, stable ties, late imports, restart, and independent live catch-up', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'history-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new RocksHistoryStore(join(dir, 'db'));
  const query = { steamAccountId: account, mode: 'history' as const };
  try {
    const empty = await store.sync(query);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.hasMore, false);
    assert.equal(typeof empty.nextCursor, 'string');
    assert.equal(empty.liveCursor, (await store.sync({ steamAccountId: account })).nextCursor);
    assert.equal((await store.sync({ ...query, cursor: empty.nextCursor })).nextCursor, empty.nextCursor);
    for (let n = 1; n <= 503; n++) await store.put(record(n, { id: n % 2 ? peer : other }));
    const tiedTime = record(503).sentAt;
    await store.put(record(504, { sentAt: tiedTime, ordinal: 2 }));
    await store.put(record(505, { sentAt: tiedTime, ordinal: 2, id: other }));
    await store.put(record(506, { sentAt: '2000-01-01T00:00:00.000Z' }));
    await store.put(record(900, { steamAccountId: other }));
    assert.equal((await store.sync({ steamAccountId: account, cursor: empty.liveCursor, limit: 1 })).items[0].message, 'message 1');
    const first = await store.sync({ ...query, cursor: empty.nextCursor, limit: 999 });
    assert.equal(first.items.length, 500);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.items.map((i) => i.message), Array.from({ length: 500 }, (_, i) => `message ${505 - i}`));
    assert.ok(first.items.every((i) => i.syncId === i.eventId && i.steamAccountId === account));
    assert.equal((await store.sync({ steamAccountId: account, cursor: first.liveCursor })).items.length, 0);
    await store.close();
    store = new RocksHistoryStore(join(dir, 'db'));

    // The page is queued before these writes. Both newer and older timestamps must
    // be caught by the FIRST page's live cursor, even if later history pages overlap.
    const [second] = await Promise.all([
      store.sync({ ...query, cursor: first.nextCursor, limit: 3 }),
      store.put(record(507)),
      store.put(record(508, { sentAt: '1999-01-01T00:00:00.000Z' })),
      store.put(record(509, { sentAt: tiedTime, ordinal: 3 }))
    ]);
    assert.deepEqual(second.items.map((i) => i.message), ['message 5', 'message 4', 'message 3']);
    assert.equal(second.liveCursor, first.liveCursor);
    const third = await store.sync({ ...query, cursor: second.nextCursor });
    assert.deepEqual(third.items.map((i) => i.message), ['message 2', 'message 1', 'message 506', 'message 508']);
    assert.equal(third.hasMore, false);
    assert.notEqual(third.liveCursor, first.liveCursor);
    const end = await store.sync({ ...query, cursor: third.nextCursor });
    assert.deepEqual(end.items, []);
    assert.equal(end.nextCursor, third.nextCursor);
    const live = await store.sync({ steamAccountId: account, cursor: first.liveCursor });
    assert.deepEqual(live.items.map((i) => i.message), ['message 507', 'message 508', 'message 509']);
    assert.equal(live.nextCursor, third.liveCursor);
    const combined = [...first.items, ...second.items, ...third.items, ...live.items];
    assert.equal(new Set(combined.map((i) => i.syncId)).size, 509);

    const generation = Buffer.from(first.nextCursor, 'base64url').subarray(1, 17).toString('hex');
    const missing = encodeCursor(generation, historySyncKey(messageKey(account, peer, 123, 0, 99999n)));
    const wrongType = encodeCursor(generation, Buffer.concat([accountPrefix(0x21, account), Buffer.alloc(20)]));
    for (const cursor of ['', 'bad', first.nextCursor + '=', first.liveCursor!, missing, wrongType]) {
      await assert.rejects(store.sync({ ...query, cursor }), reset);
    }
    await assert.rejects(store.sync({ steamAccountId: account, cursor: first.nextCursor }), reset);
    await assert.rejects(store.sync({ ...query, steamAccountId: other, cursor: first.nextCursor }), reset);
    for (const limit of [0, -1, 1.5, NaN]) await assert.rejects(store.sync({ ...query, limit }), /limit/);
    await assert.rejects(store.sync({ ...query, mode: 'other' as 'history' }), (e: any) => e.statusCode === 400);
    const fresh = new RocksHistoryStore(join(dir, 'fresh'));
    try { await assert.rejects(fresh.sync({ ...query, cursor: first.nextCursor }), reset); }
    finally { await fresh.close(); }
  } finally { await store.close(); }
});

test('schema 2 time-index backfill checkpoints 500 rows, fences old writers and preserves live cursors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'history-sync-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  const old = new RocksHistoryStore(path);
  let liveCursor: string;
  try {
    for (let n = 1; n <= 503; n++) await old.put(record(n, { id: n % 2 ? peer : other }));
    liveCursor = (await old.sync({ steamAccountId: account, mode: 'history' })).liveCursor!;
  } finally { await old.close(); }
  const raw = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  try {
    await raw.transaction(async (txn) => {
      const meta = JSON.parse((await txn.get(Buffer.from([1, 1]))).toString());
      meta.value.schemaVersion = 2;
      delete meta.value.historyIndexVersion;
      await txn.put(Buffer.from([1, 1]), Buffer.from(JSON.stringify(meta)));
      for (const { key } of txn.getRange({ start: Buffer.from([0x23]), end: Buffer.from([0x24]) })) await txn.remove(key);
    });
    await raw.flush({ allowWriteStall: true });
  } finally { raw.close(); }
  const original = RocksDatabase.prototype.flush;
  RocksDatabase.prototype.flush = async function (options) {
    await original.call(this, options);
    throw new Error('interrupted time backfill');
  };
  const interrupted = new RocksHistoryStore(path);
  try { await assert.rejects(interrupted.ready(), /interrupted time backfill/); }
  finally { RocksDatabase.prototype.flush = original; await interrupted.close(); }
  const inspect = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  try {
    const meta = JSON.parse((await inspect.get(Buffer.from([1, 1]))).toString()).value;
    assert.equal(meta.schemaVersion, 3);
    assert.equal(meta.syncIndexVersion, 1);
    assert.equal(meta.historyIndexVersion, undefined);
    assert.ok(await inspect.get(Buffer.from([1, 4])));
    assert.equal([...inspect.getRange({ start: Buffer.from([0x23]), end: Buffer.from([0x24]) })].length, 500);
  } finally { inspect.close(); }
  const upgraded = new RocksHistoryStore(path);
  try {
    const first = await upgraded.sync({ steamAccountId: account, mode: 'history', limit: 500 });
    assert.deepEqual(first.items.map((i) => i.message), Array.from({ length: 500 }, (_, i) => `message ${503 - i}`));
    assert.equal(first.liveCursor, liveCursor!);
    const last = await upgraded.sync({ steamAccountId: account, mode: 'history', cursor: first.nextCursor });
    assert.deepEqual(last.items.map((i) => i.message), ['message 3', 'message 2', 'message 1']);
    await upgraded.put(record(504));
    assert.equal((await upgraded.sync({ steamAccountId: account, cursor: liveCursor! })).items[0].message, 'message 504');
  } finally { await upgraded.close(); }
  const complete = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  try {
    assert.equal(await complete.get(Buffer.from([1, 4])), undefined);
    assert.equal(JSON.parse((await complete.get(Buffer.from([1, 1]))).toString()).value.historyIndexVersion, 1);
    assert.equal([...complete.getRange({ start: Buffer.from([0x23]), end: Buffer.from([0x24]) })].length, 504);
  } finally { complete.close(); }
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
      delete meta.value.syncIndexVersion;
      delete meta.value.historyIndexVersion;
      await txn.put(Buffer.from([1, 1]), Buffer.from(JSON.stringify(meta)));
      for (const { key } of txn.getRange({ start: Buffer.from([0x22]), end: Buffer.from([0x24]) })) await txn.remove(key);
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
    assert.equal(JSON.parse((await inspect.get(Buffer.from([1, 1]))).toString()).value.schemaVersion, 3);
    assert.equal([...inspect.getRange({ start: Buffer.from([0x22]), end: Buffer.from([0x23]) })].length, 500);
  } finally { inspect.close(); }
  const upgraded = new RocksHistoryStore(path);
  try {
    const first = await upgraded.sync({ steamAccountId: account, limit: 500 });
    assert.deepEqual(first.items.map((i) => i.message), Array.from({ length: 500 }, (_, i) => `message ${i + 1}`));
    const last = await upgraded.sync({ steamAccountId: account, cursor: first.nextCursor });
    assert.deepEqual(last.items.map((i) => i.message), ['message 501', 'message 502', 'message 503']);
    const history = await upgraded.sync({ steamAccountId: account, mode: 'history', limit: 500 });
    assert.deepEqual(history.items.map((i) => i.message), first.items.map((i) => i.message));
    assert.equal(history.liveCursor, last.nextCursor);
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
    await assert.rejects(store.sync({ steamAccountId: account, mode: 'history' }), /flush failed/);
    RocksDatabase.prototype.flush = original;
    assert.equal((await store.sync({ steamAccountId: account })).items.length, 1);
    const history = await store.sync({ steamAccountId: account, mode: 'history' });
    assert.equal(history.items.length, 1);
    assert.equal((await store.sync({ steamAccountId: account, cursor: history.liveCursor })).items.length, 0);
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
    const historyResponse = await request('/api/messages/sync?mode=history&limit=999');
    assert.equal(historyResponse.status, 200);
    assert.equal(historyResponse.headers.get('cache-control'), 'no-store');
    const historyFirst = await historyResponse.json();
    assert.deepEqual(Object.keys(historyFirst).sort(), ['hasMore', 'items', 'liveCursor', 'nextCursor', 'steamAccountId']);
    assert.deepEqual(historyFirst.items.map((i: any) => i.message), Array.from({ length: 500 }, (_, i) => `message ${502 - i}`));
    assert.equal(historyFirst.hasMore, true);
    assert.equal(historyFirst.liveCursor, last.nextCursor);
    const historyLast = await (await request(`/api/messages/sync?mode=history&cursor=${historyFirst.nextCursor}`)).json();
    assert.deepEqual(historyLast.items.map((i: any) => i.message), ['message 2', 'message 1']);
    assert.equal(historyLast.hasMore, false);
    for (const mode of ['', 'live', 'History', 'invalid']) assert.equal((await request(`/api/messages/sync?mode=${mode}`)).status, 400);
    for (const path of [`?mode=history&cursor=${last.nextCursor}`, `?cursor=${historyFirst.nextCursor}`, '?mode=history&cursor=bad']) {
      const response = await request('/api/messages/sync' + path);
      assert.equal(response.status, 409); assert.equal((await response.json()).resetRequired, true);
    }
    for (const value of ['0', '-1', '1.5', 'NaN', '']) assert.equal((await request(`/api/messages/sync?limit=${value}`)).status, 400);
    for (const cursor of ['bad', '']) {
      const response = await request(`/api/messages/sync?cursor=${cursor}`);
      assert.equal(response.status, 409); assert.equal((await response.json()).resetRequired, true);
    }
    auth.setActiveSteamAccount(second.id);
    const cross = await request(`/api/messages/sync?cursor=${last.nextCursor}`);
    assert.equal(cross.status, 409); assert.equal((await cross.json()).resetRequired, true);
    assert.equal((await request(`/api/messages/sync?mode=history&cursor=${historyFirst.nextCursor}`)).status, 409);
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
    const recent = await (await request('/api/messages/sync?mode=history&limit=1')).json();
    assert.equal(recent.items[0].message, 'message 502');
    assert.equal(recent.liveCursor, late.nextCursor);
    const older = await (await request(`/api/messages/sync?mode=history&cursor=${historyLast.nextCursor}`)).json();
    assert.deepEqual(older.items.map((i: any) => i.message), ['message 700']);
    assert.equal(older.hasMore, false);
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

test('HTTP history sync: empty-account cursors and authorization rechecks after storage awaits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'history-sync-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = auth.createUser({ username: 'reader', password: 'password123', role: 'user' });
  const active = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const second = auth.upsertSteamAccount({ steamId: other });
  auth.replaceUserSteamAccounts(user.id, [active.id, second.id], admin.id);
  const sessions = createSessionManager({ store: auth });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  const storage = createHistoryStorage({ dbPath: join(dir, 'db'), logPath: join(dir, 'chat.jsonl'), logger: quiet });
  const service = createChatService({ historyStorage: storage, authStore: auth, sessionManager: sessions,
    steamLoginService: { getStatus: () => ({ status: 'offline', steamId: null as string | null }), ensureOnline() {} },
    chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet });
  service.start(); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}/api/messages/sync`;
  const request = (query: string) => fetch(base + query, { headers: { Cookie: cookie } });
  const original = storage.sync.bind(storage);
  try {
    const emptyResponse = await request('?mode=history');
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.items, []);
    assert.equal(empty.hasMore, false);
    assert.equal(typeof empty.nextCursor, 'string');
    assert.equal(typeof empty.liveCursor, 'string');
    assert.equal((await (await request(`?mode=history&cursor=${empty.nextCursor}`)).json()).nextCursor, empty.nextCursor);
    storage.append(record(1));
    await until(() => storage.status().rocksdb.durable === 1);
    assert.equal((await (await request(`?cursor=${empty.liveCursor}`)).json()).items[0].message, 'message 1');
    assert.equal((await (await request(`?mode=history&cursor=${empty.nextCursor}`)).json()).items[0].message, 'message 1');

    // Delay delivery of a real worker result to change permissions in the await window.
    const withheld = async (change: () => void, expectedStatus: number) => {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      storage.sync = async query => {
        const page = await original(query);
        entered(); await gate; return page;
      };
      const response = request('?mode=history');
      try { await reached; change(); }
      finally { release(); storage.sync = original; }
      const result = await response;
      assert.equal(result.status, expectedStatus);
      assert.equal((await result.json()).items, undefined);
    };
    await withheld(() => auth.replaceUserSteamAccounts(user.id, [], admin.id), 403);
    auth.replaceUserSteamAccounts(user.id, [active.id, second.id], admin.id);
    await withheld(() => auth.setActiveSteamAccount(second.id), 403);
    auth.setActiveSteamAccount(active.id);
    await withheld(() => auth.revokeUserSessions(user.id, admin.id), 401);
  } finally { storage.sync = original; await service.stop(); await storage.close(); auth.close(); }
});

test('sync never falls back to legacy LAN/basic authentication', async () => {
  const service = createChatService({ chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet });
  service.start(); await once(service.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/messages/sync`);
    assert.equal(response.status, 401);
  } finally { await service.stop(); }
});
