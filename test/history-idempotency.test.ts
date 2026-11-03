import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { HistoryIdempotency, jsonlRecords } from '../src/storage/history-idempotency';
import { AppendOnlyJsonlWriter } from '../src/storage/history-jsonl';
import { createHistoryStorage, type HistoryStorage } from '../src/storage/history-storage';
import { canonicalMessage, normalizeStoredMessage, steamReplayIdentity, type StoredMessage } from '../src/storage/history-message';
import { RocksHistoryStore } from '../src/storage/rocks-history';
import { SteamImageAliases } from '../src/storage/history-steam-alias';
import { steamEventKey } from '../src/storage/history-message';
import type { HistoryRecordInput } from '../src/types';
const { createSteamMessageLogger } = require('../src/steam/message-logger');
const { createChatService } = require('../src/server/chat-service');

const account = '76561198000000001';
const peer = '76561198000000002';
const at = '2026-01-02T03:04:05.000Z';
const quiet = { info() {}, warn() {}, error() {} };
const record = (extra: Partial<HistoryRecordInput> = {}): HistoryRecordInput => ({
  steamAccountId: account, id: peer, message: 'Visit https://example.test/a', sentAt: at, ordinal: 0, ...extra
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for idempotent writers');
}
async function rows(filename: string): Promise<any[]> {
  return (await fs.readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function drained(storage: HistoryStorage, count: number) {
  await until(() => storage.status().jsonl.durable === count && storage.status().rocksdb.durable === count);
}
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-idempotency-'));
  const options = { logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'), logger: quiet, retryMs: 20 };
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, options };
}

test('old random IDs bootstrap from sealed JSONL and Rocks without rewriting historical duplicates', async t => {
  const { dir, options } = await fixture(t);
  const first = normalizeStoredMessage(record({ eventId: '1'.repeat(32) }));
  const duplicate = normalizeStoredMessage(record({ eventId: '2'.repeat(32), name: 'Later lookup' }));
  const archive = path.join(dir, 'chat-20260102-0123456789abcdef.jsonl');
  const original = `${canonicalMessage(first)}\n${canonicalMessage(duplicate)}\n`;
  await fs.writeFile(archive, original);
  const db = new RocksHistoryStore(options.dbPath);
  await db.put(first); await db.put(duplicate); await db.close();
  let storage = createHistoryStorage(options);
  t.after(() => storage.close());
  const committed: string[] = [];
  storage.onDurable(item => committed.push(item.eventId!));
  storage.append(record({ message: 'Visit [url="https://example.test/a"]https://example.test/a[/url]', name: 'New lookup' }), { notify: false });
  await drained(storage, 1);
  assert.equal(await fs.readFile(archive, 'utf8'), original);
  assert.deepEqual(await rows(options.logPath), []);
  assert.deepEqual(committed, [first.eventId]);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 2);
  await storage.close();
  storage = createHistoryStorage(options);
  storage.append(record(), { notify: false });
  await drained(storage, 1);
  assert.deepEqual(await rows(options.logPath), []);
  assert.equal((await storage.sync({ steamAccountId: account })).items.length, 2);
});

test('live/history races, cache expiry, URL variants and restart leave one primary event', async t => {
  const { options } = await fixture(t);
  let storage = createHistoryStorage(options);
  t.after(async () => { t.mock.timers.reset(); await storage.close(); });
  const first = await storage.append(record());
  await drained(storage, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(31000);
  await Promise.all(Array.from({ length: 8 }, async (_, index) => storage.append(record({
    message: index % 2 ? 'Visit [url=https://example.test/a]https://example.test/a[/url]' : record().message,
    name: `Lookup ${index}`
  }), { notify: index % 2 === 0 })));
  await drained(storage, 9);
  t.mock.timers.reset();
  await storage.close();
  storage = createHistoryStorage(options);
  storage.append(record(), { notify: false });
  await drained(storage, 1);
  assert.deepEqual((await rows(options.logPath)).map(item => item.eventId), [first.eventId]);
  const page = await storage.history({ steamAccountId: account, id: peer });
  assert.deepEqual(page.items.map(item => item.eventId), [first.eventId]);
});

test('old outgoing image without a sidecar bootstraps its random ID into the existing alias protocol', async t => {
  const { options } = await fixture(t);
  const message = '[img src=https://media.example.test/a][/img]';
  const old = normalizeStoredMessage(record({ echo: true, message }));
  await fs.writeFile(options.logPath, `${canonicalMessage(old)}\n`);
  const db = new RocksHistoryStore(options.dbPath);
  await db.put(old); await db.close();
  const storage = createHistoryStorage(options);
  t.after(() => storage.close());
  const steamEvent = steamEventKey(account, peer, true, message, new Date(at), 0)!;
  const replay = await storage.appendSteamImage!(record({ echo: true, message, steamEventKey: steamEvent }), { notify: false });
  assert.equal(replay.eventId, old.eventId);
  await drained(storage, 1);
  assert.equal((await rows(options.logPath)).length, 1);
  assert.equal((await new SteamImageAliases(`${options.logPath}.steam-image-aliases-v1`).get(steamEvent))!.eventId, old.eventId);
});

test('account-scoped date-only legacy JSONL without event IDs also prevents replay appends', async t => {
  const { options } = await fixture(t);
  const old = { ...record({ sentAt: undefined }), date: '2026-01-02 03:04:05.000' };
  const original = `${JSON.stringify(old)}\n`;
  await fs.writeFile(options.logPath, original);
  const storage = createHistoryStorage(options);
  t.after(() => storage.close());
  storage.append(old, { notify: false });
  await drained(storage, 1);
  assert.equal(await fs.readFile(options.logPath, 'utf8'), original);
});

test('same body with distinct event metadata and metadata-poor repeated sends survive index rebuild', async t => {
  const { options } = await fixture(t);
  let storage = createHistoryStorage(options);
  t.after(() => storage.close());
  const inputs = [record(), record({ ordinal: 1 }), record({ sentAt: '2026-01-02T03:04:05.001Z' }),
    record({ echo: true }), record({ id: '76561198000000003' }), record({ steamAccountId: '76561198000000003' }),
    record({ message: '[url=https://example.test/a]Different label[/url]' }),
    record({ message: 'Distinct body at the same timestamp and ordinal' }),
    record({ ordinal: null }), record({ ordinal: null }), record({ sentAt: undefined }), record({ sentAt: undefined }),
    record({ ordinal: '', steamEventKey: 'a'.repeat(64) }), record({ ordinal: '', steamEventKey: 'a'.repeat(64) })];
  for (const input of inputs) storage.append(input);
  await drained(storage, inputs.length);
  await storage.close();
  // Both sidecars are disposable indexes. Rebuild from primary records alone;
  // synthesized ordinal=0/time must not erase the metadata-poor repetitions.
  for (const base of [options.logPath, options.dbPath]) {
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${base}.idempotency-v1.sqlite${suffix}`, { force: true });
  }
  storage = createHistoryStorage(options);
  storage.append(record({ ordinal: null }));
  storage.append(record({ ordinal: null }));
  storage.append(record(), { notify: false });
  await drained(storage, 3);
  const all = await rows(options.logPath);
  assert.equal(all.length, inputs.length + 2);
  assert.equal(all.filter(item => item.steamMetadata === false).length, 8);
  assert.equal(new Set((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId)).size, inputs.length + 1);
});

test('a real worker exits after JSONL fsync and before ACK; restart and retry append no second line', async t => {
  const { options } = await fixture(t);
  const storage = createHistoryStorage({ ...options, workerPath: path.join(__dirname, 'fixtures/history-lost-ack-worker.js') });
  t.after(() => storage.close());
  const first = await storage.append(record());
  await drained(storage, 1);
  assert.equal(await fs.readFile(`${options.logPath}.lost-ack`, 'utf8'), 'ACK deliberately lost');
  assert.deepEqual((await rows(options.logPath)).map(item => item.eventId), [first.eventId]);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 1);
});

for (const broken of ['jsonl', 'rocksdb'] as const) {
  test(`${broken} index failure cannot block the other lane; queued records recover independently`, async t => {
    const { options } = await fixture(t);
    const obstruction = `${broken === 'jsonl' ? options.logPath : options.dbPath}.idempotency-v1.sqlite`;
    await fs.mkdir(obstruction);
    const storage = createHistoryStorage(options);
    t.after(() => storage.close());
    const healthy = broken === 'jsonl' ? 'rocksdb' : 'jsonl';
    storage.append(record());
    await until(() => storage.status()[healthy].durable === 1);
    assert.equal(storage.canSend(), true);
    storage.append(record({ ordinal: 1 }));
    await until(() => storage.status()[healthy].durable === 2);
    assert.equal(storage.status()[broken].durable, 0);
    await fs.rmdir(obstruction);
    await drained(storage, 2);
    assert.equal((await rows(options.logPath)).length, 2);
    assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 2);
  });
}

test('reservation before primary failure is retried after reopen, while a completed uncertain write is discovered', async t => {
  const { dir } = await fixture(t);
  const stored: StoredMessage[] = [];
  const filename = path.join(dir, 'index.sqlite');
  let failure: 'before' | 'after' | undefined = 'before';
  const source = async function* () { yield* stored; };
  const write = async (item: StoredMessage) => {
    if (failure === 'before') throw new Error('disk unavailable before write');
    stored.push(item);
    if (failure === 'after') throw new Error('fsync or index commit uncertain');
  };
  let index = new HistoryIdempotency(filename, source, write);
  const original = normalizeStoredMessage(record());
  await assert.rejects(index.append(original), /before write/);
  index.close();
  index = new HistoryIdempotency(filename, source, write);
  failure = 'after';
  await assert.rejects(index.append(normalizeStoredMessage(record())), /uncertain/);
  failure = undefined;
  assert.equal((await index.append(normalizeStoredMessage(record()))).eventId, original.eventId);
  assert.equal(stored.length, 1);
  index.close();
});

test('interrupted bootstrap rolls back and retries; a failed durability scan never suppresses a pending write', async t => {
  const { dir } = await fixture(t);
  const old = normalizeStoredMessage(record());
  let interrupted = true;
  let writes = 0;
  const source = async function* () {
    yield old;
    if (interrupted) throw new Error('primary scan/fsync failed');
  };
  const index = new HistoryIdempotency(path.join(dir, 'index.sqlite'), source, async () => { writes++; });
  t.after(() => index.close());
  await assert.rejects(index.append(normalizeStoredMessage(record())), /scan\/fsync/);
  await assert.rejects(index.append(normalizeStoredMessage(record())), /scan\/fsync/);
  interrupted = false;
  assert.equal((await index.append(normalizeStoredMessage(record()))).eventId, old.eventId);
  assert.equal(writes, 0);
});

test('SQLite completion update failure after primary success is recovered from primary evidence', async t => {
  const { dir } = await fixture(t);
  const filename = path.join(dir, 'index.sqlite');
  const primary: StoredMessage[] = [];
  const index = new HistoryIdempotency(filename, async function* () { yield* primary; }, async item => { primary.push(item); });
  t.after(() => index.close());
  await index.ready();
  const fault = new DatabaseSync(filename);
  t.after(() => fault.close());
  fault.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF present ON events WHEN NEW.present = 1
    BEGIN SELECT RAISE(FAIL, 'completion failure'); END;`);
  const first = normalizeStoredMessage(record());
  await assert.rejects(index.append(first), /completion failure/);
  fault.exec('DROP TRIGGER fail_completion');
  assert.equal((await index.append(normalizeStoredMessage(record()))).eventId, first.eventId);
  assert.equal(primary.length, 1);
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'modern'} Steam backfill sorts descending input by timestamp then ordinal while realtime races it`, async t => {
    const { options } = await fixture(t);
    const storage = createHistoryStorage(options);
    t.after(() => storage.close());
    const steamUser = Object.assign(new EventEmitter(), { chat: new EventEmitter() });
    const history = [{ message: 'newest', time: 1710000001, ordinal: 0 },
      { message: 'same second, second ordinal', time: 1710000000, ordinal: 2 },
      { message: 'oldest', time: 1710000000, ordinal: 1 }];
    if (legacy) Object.assign(steamUser, { getChatHistory(_id: string, callback: Function) {
      callback(null, history.map(item => ({ ...item, steamID: peer, timestamp: item.time })));
    } });
    else Object.assign(steamUser.chat, { getFriendMessageHistory(_id: string, options: unknown, callback: Function) {
      assert.deepEqual(options, { maxCount: 100, wantBbcode: true });
      callback(null, { messages: history.map(item => ({ ...item, sender: peer, server_timestamp: new Date(item.time * 1000) })) });
    } });
    const dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
    steamUser.chat.emit('friendMessage', { steamid_friend: peer, message: 'oldest', ordinal: 1, server_timestamp: new Date(1710000000 * 1000) });
    await dispose.close();
    await drained(storage, 4);
    const messages = (await rows(options.logPath)).map(item => item.message);
    assert.deepEqual(messages, ['oldest', 'same second, second ordinal', 'newest']);
    assert.deepEqual(history.map(item => item.message), ['newest', 'same second, second ordinal', 'oldest']);
  });
}

test('logger with storage retains repeated metadata-poor echoes instead of merging by body', async t => {
  const { options } = await fixture(t);
  const storage = createHistoryStorage(options);
  t.after(() => storage.close());
  const steamUser = new EventEmitter();
  const dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
  steamUser.emit('friendMessageEcho', peer, 'intentional repeat');
  steamUser.emit('friendMessageEcho', peer, 'intentional repeat');
  await dispose.close();
  await drained(storage, 2);
  assert.equal((await rows(options.logPath)).length, 2);
});

test('identity requires complete metadata and only folds redundant URL markup', () => {
  assert.equal(steamReplayIdentity(record()), steamReplayIdentity(record({ message: 'Visit [url]https://example.test/a[/url]' })));
  const incomplete: Partial<HistoryRecordInput>[] = [{ ordinal: null }, { sentAt: undefined }, { steamMetadata: false }, { ordinal: '' }];
  for (const change of incomplete) {
    assert.equal(steamReplayIdentity(record(change)), undefined);
  }
  assert.notEqual(steamReplayIdentity(record()), steamReplayIdentity(record({ message: 'Visit [url=https://example.test/b]https://example.test/a[/url]' })));
});

test('replay resolves before append response, onMessage and recent cache after expiry and restart', async t => {
  const { options } = await fixture(t);
  const old = normalizeStoredMessage(record({ eventId: 'a'.repeat(32), name: 'Original name' }));
  await fs.writeFile(options.logPath, `${canonicalMessage(old)}\n`);
  const db = new RocksHistoryStore(options.dbPath);
  await db.put(old); await db.close();
  let storage = createHistoryStorage(options);
  t.after(async () => { t.mock.timers.reset(); await storage.close(); });
  for (const restart of [false, true]) {
    if (restart) { await storage.close(); storage = createHistoryStorage(options); }
    const visible: any[] = [];
    const off = storage.onMessage(item => visible.push(item));
    const first = await storage.append(record({ name: 'New name' }));
    const cached = await storage.append(record({ name: 'Yet another name' }));
    assert.equal(first.eventId, old.eventId);
    assert.equal(first.name, old.name);
    assert.equal(cached.eventId, old.eventId);
    assert.deepEqual(visible.map(item => [item.eventId, item.name]), [[old.eventId, old.name]]);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(31000);
    const expired = await storage.append(record());
    t.mock.timers.reset();
    assert.equal(expired.eventId, old.eventId);
    assert.deepEqual(visible.map(item => item.eventId), [old.eventId, old.eventId]);
    await drained(storage, 3);
    assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId), [old.eventId]);
    off();
  }
  assert.deepEqual((await rows(options.logPath)).map(item => item.eventId), [old.eventId]);
});

test('server send response and its message broadcast use the complete old canonical event', async t => {
  const { options } = await fixture(t);
  const old = normalizeStoredMessage(record({ echo: true, eventId: 'a'.repeat(32), name: 'Original self name' }));
  await fs.writeFile(options.logPath, `${canonicalMessage(old)}\n`);
  const db = new RocksHistoryStore(options.dbPath);
  await db.put(old); await db.close();
  const storage = createHistoryStorage(options);
  const steamUser = Object.assign(new EventEmitter(), { chat: {
    sendFriendMessage: async () => ({ modified_message: old.message, ordinal: 0, server_timestamp: new Date(at) })
  } });
  const service = createChatService({ historyStorage: storage, steamUser, logger: quiet,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} } });
  t.after(async () => { await service.stop(); await storage.close(); });
  await until(() => storage.canSend());
  const visible: any[] = [];
  storage.onMessage(item => visible.push(item));
  const response = await service.sendTextMessage(peer, old.message);
  assert.equal(canonicalMessage(response), canonicalMessage(old));
  assert.deepEqual(visible.map(canonicalMessage), [canonicalMessage(old)]);
  await drained(storage, 1);
  assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId), [old.eventId]);
});

for (const survivor of ['jsonl', 'rocksdb'] as const) {
  test(`healthy lanes reuse the old ${survivor}-only ID, including after deleting both indexes`, async t => {
    const { dir, options } = await fixture(t);
    const old = normalizeStoredMessage(record({ eventId: 'a'.repeat(32), name: 'Surviving copy' }));
    const archive = path.join(dir, 'chat-20260102.jsonl');
    const original = `${canonicalMessage(old)}\n`;
    if (survivor === 'jsonl') await fs.writeFile(archive, original);
    else {
      const db = new RocksHistoryStore(options.dbPath);
      await db.put(old); await db.close();
    }
    let storage = createHistoryStorage(options);
    t.after(() => storage.close());
    for (const rebuild of [false, true]) {
      if (rebuild) {
        await storage.close();
        for (const base of [options.logPath, options.dbPath]) for (const suffix of ['', '-wal', '-shm']) {
          await fs.rm(`${base}.idempotency-v1.sqlite${suffix}`, { force: true });
        }
        storage = createHistoryStorage(options);
      }
      const visible: string[] = [];
      const off = storage.onMessage(item => visible.push(item.eventId!));
      const replay = await storage.append(record({ name: 'Fresh lookup' }));
      assert.equal(replay.eventId, old.eventId);
      assert.equal(replay.name, old.name);
      assert.deepEqual(visible, [old.eventId]);
      await drained(storage, 1);
      assert.deepEqual((await storage.history({ steamAccountId: account, id: peer })).items.map(item => item.eventId), [old.eventId]);
      const logRows = [...(survivor === 'jsonl' ? await rows(archive) : []), ...await rows(options.logPath)];
      assert.deepEqual(logRows.map(item => item.eventId), [old.eventId]);
      off();
    }
    if (survivor === 'jsonl') assert.equal(await fs.readFile(archive, 'utf8'), original);
  });
}

test('archive collision filenames and reversed primary iteration choose the same representative as Rocks', async t => {
  const { dir, options } = await fixture(t);
  const a = normalizeStoredMessage(record({ eventId: '1'.repeat(32), name: 'A' }));
  const b = normalizeStoredMessage(record({ eventId: '2'.repeat(32), name: 'B' }));
  const archive = path.join(dir, 'chat-20260102.jsonl');
  const collision = path.join(dir, 'chat-20260102-0123456789abcdef.jsonl');
  await fs.writeFile(archive, `${canonicalMessage(a)}\n`);
  await fs.writeFile(collision, `${canonicalMessage(b)}\n`);
  const db = new RocksHistoryStore(options.dbPath);
  await db.put(b); await db.put(a); await db.close();
  for (const [offset, input] of [[a, b], [b, a]].entries()) {
    const index = new HistoryIdempotency(path.join(dir, `order-${offset}.sqlite`), async function* () { yield* input; }, async () => assert.fail('Already present'));
    await index.ready();
    assert.equal(index.get(steamReplayIdentity(a)!)!.eventId, a.eventId);
    index.close();
  }
  let storage = createHistoryStorage(options);
  t.after(() => storage.close());
  for (const rebuild of [false, true]) {
    if (rebuild) {
      await storage.close();
      for (const base of [options.logPath, options.dbPath]) for (const suffix of ['', '-wal', '-shm']) {
        await fs.rm(`${base}.idempotency-v1.sqlite${suffix}`, { force: true });
      }
      storage = createHistoryStorage(options);
    }
    assert.equal((await storage.append(record())).eventId, a.eventId);
    await drained(storage, 1);
    assert.deepEqual(await rows(options.logPath), []);
    assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId).sort(), [a.eventId, b.eventId]);
  }
});

for (const reopen of [false, true]) {
  test(`recovered primary B overrides failed reservation A (${reopen ? 'reopen' : 'same process rescan'})`, async t => {
    const { dir } = await fixture(t);
    const filename = path.join(dir, 'recovered.sqlite');
    const primary: StoredMessage[] = [];
    const a = normalizeStoredMessage(record({ eventId: '1'.repeat(32) }));
    const b = normalizeStoredMessage(record({ eventId: '2'.repeat(32), name: 'Restored from other copy' }));
    let fail = true;
    const source = async function* () { yield* primary; };
    const write = async (item: StoredMessage) => { if (fail) throw new Error('primary unavailable'); primary.push(item); };
    let index = new HistoryIdempotency(filename, source, write);
    await assert.rejects(index.append(a), /primary unavailable/);
    primary.push(b); fail = false;
    if (reopen) { index.close(); index = new HistoryIdempotency(filename, source, write); }
    try {
      assert.equal((await index.append(normalizeStoredMessage(record()))).eventId, b.eventId);
      assert.deepEqual(primary.map(item => item.eventId), [b.eventId]);
    } finally { index.close(); }
  });
}

for (const reservedLane of ['jsonl', 'rocksdb'] as const) {
  test(`parent resolution prefers actual primary B over ${reservedLane} reservation A`, async t => {
    const { options } = await fixture(t);
    const a = normalizeStoredMessage(record({ eventId: '1'.repeat(32) }));
    const b = normalizeStoredMessage(record({ eventId: '2'.repeat(32), name: 'Actual primary' }));
    const reservedPath = reservedLane === 'jsonl' ? options.logPath : options.dbPath;
    const reservation = new HistoryIdempotency(`${reservedPath}.idempotency-v1.sqlite`, async function* () {}, async () => { throw new Error('write failed'); });
    await assert.rejects(reservation.append(a), /write failed/);
    reservation.close();
    if (reservedLane === 'jsonl') {
      const db = new RocksHistoryStore(options.dbPath);
      await db.put(b); await db.close();
    } else await fs.writeFile(options.logPath, `${canonicalMessage(b)}\n`);
    const storage = createHistoryStorage(options);
    t.after(() => storage.close());
    const visible: string[] = [];
    storage.onMessage(item => visible.push(item.eventId!));
    assert.equal((await storage.append(record())).eventId, b.eventId);
    await drained(storage, 1);
    assert.deepEqual(visible, [b.eventId]);
    assert.deepEqual((await rows(options.logPath)).map(item => item.eventId), [b.eventId]);
    assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId), [b.eventId]);
  });
}

test('legacy rows without explicit IDs tolerate name changes and retain every original byte', async t => {
  const { dir, options } = await fixture(t);
  const original = [record({ name: 'Z name' }), record({ name: 'A name' })].map(item => JSON.stringify(item)).join('\n') + '\n';
  await fs.writeFile(options.logPath, original);
  let storage = createHistoryStorage(options);
  t.after(() => storage.close());
  const first = await storage.append(record());
  await drained(storage, 1);
  assert.equal(first.name, 'A name');
  assert.equal(await fs.readFile(options.logPath, 'utf8'), original);
  await storage.close();
  storage = createHistoryStorage(options);
  assert.equal((await storage.append(record())).eventId, first.eventId);
  await drained(storage, 1);
  assert.equal(await fs.readFile(options.logPath, 'utf8'), original);
  assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId), [first.eventId]);
  // The relaxed rule belongs only to ID-less records, in either scan order.
  const parsed: Array<StoredMessage & { legacyEventId?: boolean }> = [];
  for await (const item of jsonlRecords(options.logPath)) parsed.push(item);
  for (const reverse of [false, true]) {
    const explicit: StoredMessage & { legacyEventId?: boolean } = { ...parsed[0], legacyEventId: undefined, name: 'Conflicting explicit ID' };
    const input = reverse ? [explicit, parsed[0]] : [parsed[0], explicit];
    const index = new HistoryIdempotency(path.join(dir, `explicit-${reverse}.sqlite`), async function* () { yield* input; }, async () => {});
    try { await assert.rejects(index.ready(), /eventId conflict/); } finally { index.close(); }
  }
});

test('identity admission is bounded and close drains already accepted text and image admissions', async t => {
  const { options } = await fixture(t);
  const storage = createHistoryStorage({ ...options, queueLimit: 1 });
  const first = storage.append(record());
  await assert.rejects(storage.append(record({ ordinal: 1 })), /identity queue full/);
  const closing = storage.close();
  const item = await first;
  await closing;
  assert.deepEqual((await rows(options.logPath)).map(row => row.eventId), [item.eventId]);
  await assert.rejects(storage.append(record()), /storage closed/);
  const imageStorage = createHistoryStorage(options);
  const message = '[img src=https://media.example.test/a][/img]';
  const image = imageStorage.appendSteamImage!(record({ echo: true, message,
    steamEventKey: steamEventKey(account, peer, true, message, new Date(at), 0) }));
  const imageClosing = imageStorage.close();
  const imageItem = await image;
  await imageClosing;
  assert.equal((await rows(options.logPath)).some(row => row.eventId === imageItem.eventId), true);
});

test('replay index supports the independent AppendOnlyJsonlWriter with legacy duplicates and explicit conflicts', async t => {
  const { dir, options } = await fixture(t);
  const original = [record({ name: 'Z name' }), record({ name: 'A name' })].map(item => JSON.stringify(item)).join('\n') + '\n';
  await fs.writeFile(options.logPath, original);
  const writer = new AppendOnlyJsonlWriter(options.logPath);
  await writer.ready();
  const index = new HistoryIdempotency(path.join(dir, 'append-only.sqlite'), () => jsonlRecords(options.logPath), item => writer.append(canonicalMessage(item)));
  try {
    const old = await index.append(normalizeStoredMessage(record()));
    assert.equal(old.name, 'A name');
    await index.append(normalizeStoredMessage(record({ ordinal: 1 })));
    assert.equal((await rows(options.logPath)).length, 3);
    assert.equal((await fs.readFile(options.logPath, 'utf8')).startsWith(original), true);
    // Both rows explicitly claim the same event ID: mutable names do not
    // authorize relaxing the primary corruption check in modern records.
    const explicit = path.join(dir, 'explicit.jsonl');
    await fs.writeFile(explicit, `${canonicalMessage(old)}\n${canonicalMessage({ ...old, name: 'Conflict' })}\n`);
    const broken = new HistoryIdempotency(path.join(dir, 'explicit.sqlite'), () => jsonlRecords(explicit), async () => {});
    try { await assert.rejects(broken.ready(), /eventId conflict/); } finally { broken.close(); }
  } finally { index.close(); await writer.close(); }
});
