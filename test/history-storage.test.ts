import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHistoryStorage, type HistoryStorage } from '../src/storage/history-storage';
import { normalizeStoredMessage, canonicalMessage, steamEventKey } from '../src/storage/history-message';

const account = '76561198000000001';
const peer = '76561198000000002';
function message(text = 'hello') { return { steamAccountId: account, id: peer, message: text, name: 'Friend', sentAt: '2026-01-02T03:04:05.000Z', ordinal: 0 }; }
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 30)); }
  assert.fail('Timed out waiting for storage');
}
async function fixture(t: any, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const dbPath = path.join(dir, 'db');
  const storage = createHistoryStorage({ logPath, dbPath, retryMs: 30, shutdownMs: 1000, ...extra });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, logPath, dbPath, storage };
}

test('normalization assigns cross-copy identity without either writer', () => {
  const item = normalizeStoredMessage(message());
  assert.match(item.eventId, /^[a-f0-9]{32}$/);
  assert.equal(item.steamAccountId, account);
  assert.equal(normalizeStoredMessage(item).eventId, item.eventId);
  assert.equal(canonicalMessage(normalizeStoredMessage(item)), canonicalMessage(item));
  assert.throws(() => normalizeStoredMessage({ ...message(), id: '18446744073709551616' }));
  assert.throws(() => normalizeStoredMessage({ ...message(), ordinal: -1 }));
});

test('two independent copies contain the same event and DB is immediately queryable after its own commit', async (t) => {
  const { storage, logPath } = await fixture(t);
  const durable: string[] = [];
  storage.onDurable((item) => durable.push(item.eventId!));
  const item = storage.append(message());
  assert.deepEqual(durable, []);
  await until(() => storage.status().rocksdb.durable === 1 && storage.status().jsonl.durable === 1);
  assert.deepEqual(durable, [item.eventId]);
  const page = await storage.history({ steamAccountId: account, id: peer });
  assert.equal(page.items[0].eventId, item.eventId);
  const record = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
  assert.equal(record.eventId, item.eventId);
  assert.equal(record.steamAccountId, account);
  assert.equal(record.ordinal, 0);
  assert.equal(record.message, 'hello');
});

test('Steam send result and echo share identity without repeating the visible event', async (t) => {
  const { storage, logPath } = await fixture(t);
  let visible = 0;
  storage.onMessage(() => visible++);
  const record = { ...message(), echo: true,
    steamEventKey: steamEventKey(account, peer, true, 'hello', new Date(message().sentAt), 0) };
  const first = storage.append(record);
  const second = storage.append({ ...record, name: 'changed lookup' });
  assert.equal(first.eventId, second.eventId);
  assert.equal(visible, 1);
  await until(() => storage.status().rocksdb.durable === 2 && storage.status().jsonl.durable === 2);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 1);
  const records = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records[0], records[1]);
});

test('historical supplementation does not broadcast old messages but a live counterpart still does', async (t) => {
  const { storage } = await fixture(t);
  let visible = 0;
  storage.onMessage(() => visible++);
  const record = { ...message(), steamEventKey: steamEventKey(account, peer, false, 'hello', new Date(message().sentAt), 0) };
  const imported = storage.append(record, { notify: false });
  assert.equal(visible, 0);
  assert.equal(storage.append(record).eventId, imported.eventId);
  assert.equal(visible, 1);
});

test('RocksDB open failure does not prevent JSONL durable writes', async (t) => {
  const { storage, logPath } = await fixture(t, { dbPath: '/dev/null/no-database' });
  let hints = 0;
  storage.onDurable(() => hints++);
  storage.append(message());
  await until(() => storage.status().jsonl.durable === 1);
  assert.equal(hints, 0);
  assert.equal(JSON.parse((await fs.readFile(logPath, 'utf8')).trim()).message, 'hello');
  assert.equal(storage.status().rocksdb.durable, 0);
  assert.equal(storage.canSend(), true);
});

test('JSONL open failure does not prevent direct RocksDB writes or queries', async (t) => {
  const { storage } = await fixture(t, { logPath: '/dev/null/no-log' });
  const item = storage.append(message());
  await until(() => storage.status().rocksdb.durable === 1);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items[0].eventId, item.eventId);
  assert.equal(storage.status().jsonl.durable, 0);
  assert.equal(storage.canSend(), true);
});

test('query admission reserves capacity for appends instead of discarding them as retries', async (t) => {
  const { storage } = await fixture(t, {
    workerPath: path.join(__dirname, 'fixtures', 'history-congested-worker.js'), retryMs: 10
  });
  await until(() => storage.status().rocksdb.writable);
  const queries = Promise.allSettled(Array.from({ length: 80 }, () => storage.history({ steamAccountId: account, id: peer })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  storage.append(message());
  await until(() => storage.status().rocksdb.durable === 1);
  assert.equal(storage.status().rocksdb.missed, 0);
  const results = await queries;
  assert.ok(results.some(result => result.status === 'rejected'));
});

test('a stalled RocksDB queue cannot backpressure the healthy JSONL writer', async (t) => {
  const { storage, logPath } = await fixture(t, {
    workerPath: path.join(__dirname, 'fixtures', 'history-stalled-worker.js'), queueLimit: 1,
    timeoutMs: 300, shutdownMs: 300
  });
  storage.append(message('first'));
  await until(() => storage.status().jsonl.durable === 1);
  storage.append(message('second'));
  await until(() => storage.status().jsonl.durable === 2);
  assert.equal(storage.status().rocksdb.durable, 0);
  assert.ok(storage.status().rocksdb.missed >= 1);
  const records = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((item) => item.message), ['first', 'second']);
});

test('writer repairs a partial JSONL tail without touching complete records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-tail-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await fs.writeFile(logPath, '{"old":true}\n{"partial":');
  const storage = createHistoryStorage({ logPath, dbPath: path.join(dir, 'db') });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  storage.append(message());
  await until(() => storage.status().jsonl.durable === 1);
  const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { old: true });
  assert.equal(JSON.parse(lines[1]).message, 'hello');
  assert.equal((await fs.readdir(dir)).filter((name) => name.endsWith('.partial')).length, 1);
});
