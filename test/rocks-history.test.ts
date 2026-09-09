import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { RocksHistoryStore } from '../src/storage/rocks-history';
import { normalizeStoredMessage } from '../src/storage/history-message';
import { messageKey, decodeMessageKey, prefixSuccessor, eventKey, conversationKey, recentKey } from '../src/storage/history-key';

const account = '76561198000000001';
const peer = '76561198000000002';
function item(n: number, extra: Record<string, unknown> = {}) {
  return normalizeStoredMessage({ steamAccountId: account, id: peer, name: 'Friend', message: `message ${n}`,
    type: 'text', echo: false, ordinal: 0, sentAt: new Date(1700000000000 + n).toISOString(),
    eventId: n.toString(16).padStart(32, '0'), ...extra });
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rocks-history-'));
  const path = join(directory, 'db');
  const store = new RocksHistoryStore(path);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.ready();
  return { store, path, directory };
}

test('binary v1 keys preserve uint64 precision and bytewise ordering', () => {
  const key = messageKey('18446744073709551615', peer, 1700000000000, 0xffffffff, 0xffffffffffffffffn);
  assert.equal(key.length, 37);
  assert.equal(key[0], 0x10);
  assert.deepEqual(decodeMessageKey(key), { steamAccountId: '18446744073709551615', id: peer,
    time: 1700000000000n, ordinal: 0xffffffff, recordId: 0xffffffffffffffffn });
  assert.ok(messageKey(account, peer, 1, 0xffffffff, 99n).compare(messageKey(account, peer, 2, 0, 1n)) < 0);
  assert.ok(messageKey(account, peer, 2, 0, 99n).compare(messageKey(account, peer, 2, 1, 1n)) < 0);
  assert.deepEqual(prefixSuccessor(Buffer.from([0x10, 0xff, 0xff])), Buffer.from([0x11]));
  assert.equal(prefixSuccessor(Buffer.from([0xff])), undefined);
  assert.equal(prefixSuccessor(Buffer.alloc(0)), undefined);
  assert.equal(eventKey('ab'.repeat(16)).length, 17);
  assert.equal(conversationKey(account, peer).length, 17);
  assert.equal(recentKey(account, 1, peer).length, 25);
  for (const ordinal of [-1, 0x100000000, 1.5, NaN]) assert.throws(() => messageKey(account, peer, 1, ordinal, 1n));
  assert.throws(() => messageKey('18446744073709551616', peer, 1, 0, 1n));
  assert.throws(() => messageKey(account, peer, -1, 0, 1n));
  assert.throws(() => messageKey(account, peer, 1, 0, 0x10000000000000000n));
  assert.throws(() => decodeMessageKey(Buffer.alloc(37)));
});

test('real binary ranges paginate ties in both directions without leaking accounts or peers', async (t) => {
  const { store } = await fixture(t);
  for (let n = 1; n <= 6; n++) await store.put(item(n, { sentAt: item(1).sentAt }));
  await store.put(item(10, { steamAccountId: '76561198000000003' }));
  await store.put(item(11, { id: '76561198000000004' }));
  const query = { steamAccountId: account, id: peer, limit: 2 };
  const newest = await store.history(query);
  assert.deepEqual(newest.items.map((i) => i.message), ['message 5', 'message 6']);
  assert.equal(newest.previousCursor, undefined);
  const middle = await store.history({ ...query, before: newest.nextCursor });
  assert.deepEqual(middle.items.map((i) => i.message), ['message 3', 'message 4']);
  const oldest = await store.history({ ...query, before: middle.nextCursor });
  assert.deepEqual(oldest.items.map((i) => i.message), ['message 1', 'message 2']);
  assert.equal(oldest.nextCursor, undefined);
  const forward = await store.history({ ...query, after: oldest.previousCursor });
  assert.deepEqual(forward.items, middle.items);
  assert.deepEqual((await store.history({ ...query, after: forward.previousCursor })).items, newest.items);
  assert.equal((await store.history({ ...query, at: Date.parse(item(1).sentAt) - 1 })).items.length, 0);
  assert.equal((await store.history({ ...query, at: Date.parse(item(1).sentAt) })).items.length, 2);
  await assert.rejects(store.history({ ...query, steamAccountId: '76561198000000003', before: newest.nextCursor }), /cursor/);
  await assert.rejects(store.history({ ...query, id: '76561198000000004', before: newest.nextCursor }), /cursor/);
  await assert.rejects(store.history({ ...query, before: newest.nextCursor + '=' }), /cursor/);
  await assert.rejects(store.history({ ...query, before: newest.nextCursor, at: 0 }), /mutually exclusive/);
  await assert.rejects(store.history({ ...query, limit: 0 }), /limit/);
});

test('atomic IDs, event deduplication and recent indexes survive reopen with zstd active', async (t) => {
  const { store, path } = await fixture(t);
  const latest = item(20);
  await Promise.all([store.put(latest), store.put(latest), store.put(item(1)), store.put(item(2))]);
  await assert.rejects(store.put({ ...latest, message: 'conflicting content' }), /conflict/);
  assert.deepEqual(await store.getByEventId(latest.eventId), latest);
  assert.equal(await store.getByEventId('ff'.repeat(16)), undefined);
  const summaries = await store.conversations({ steamAccountId: account });
  assert.equal(summaries.items.length, 1);
  assert.equal(summaries.items[0].messageCount, 3);
  assert.equal(summaries.items[0].preview, latest.message);
  assert.equal(summaries.items[0].updatedAt, latest.sentAt);
  const page = await store.history({ steamAccountId: account, id: peer, limit: 1 });
  await store.close();
  const raw = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  assert.equal(raw.compression.algorithm, 'zstd');
  assert.equal([...raw.getRange({ start: Buffer.from([0x21]), end: Buffer.from([0x22]) })].length, 1);
  assert.equal([...raw.getRange({ start: Buffer.from([0x40]), end: Buffer.from([0x41]) })].length, 3);
  raw.close();
  const reopened = new RocksHistoryStore(path);
  try {
    assert.deepEqual(await reopened.getByEventId(latest.eventId), latest);
    assert.equal((await reopened.history({ steamAccountId: account, id: peer, before: page.nextCursor })).items.length, 2);
    await reopened.put(item(21));
    const all = [];
    for await (const message of reopened.all()) all.push(message);
    assert.equal(all.length, 4);
  } finally { await reopened.close(); }
});

for (const incomingFirst of [false, true]) {
  test(`conversation name ${incomingFirst ? 'preserves incoming peer name after outgoing messages' : 'falls back to peer ID for outgoing-only messages'}`, async (t) => {
    const { store } = await fixture(t);
    if (incomingFirst) await store.put(item(1));
    for (const n of [2, 3]) {
      const outgoing = item(n, { echo: true, name: 'tursom' });
      await store.put(outgoing);
      const { items } = await store.conversations({ steamAccountId: account });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, peer);
      assert.equal(items[0].name, incomingFirst ? 'Friend' : peer);
      assert.equal(items[0].preview, outgoing.message);
      assert.equal(items[0].lastEcho, true);
      assert.equal(items[0].messageCount, incomingFirst ? n : n - 1);
      assert.equal((await store.getByEventId(outgoing.eventId))?.name, 'tursom');
    }
  });
}

test('recent conversation pagination rejects foreign account and generation cursors', async (t) => {
  const { store, directory } = await fixture(t);
  await store.put(item(1));
  await store.put(item(2, { id: '76561198000000003' }));
  await store.put(item(3, { id: '76561198000000004' }));
  const first = await store.conversations({ steamAccountId: account, limit: 1 });
  assert.equal(first.items[0].id, '76561198000000004');
  const second = await store.conversations({ steamAccountId: account, limit: 1, before: first.nextCursor });
  assert.equal(second.items[0].id, '76561198000000003');
  await assert.rejects(store.conversations({ steamAccountId: peer, before: first.nextCursor }), /cursor/);
  const fresh = new RocksHistoryStore(join(directory, 'fresh'));
  try { await assert.rejects(fresh.conversations({ steamAccountId: account, before: first.nextCursor }), /cursor/); }
  finally { await fresh.close(); }
});

test('flush-gated put persists SST before acknowledgment and survives abrupt process exit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rocks-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'db');
  const message = item(7);
  const script = `const {RocksHistoryStore}=require(${JSON.stringify(require.resolve('../src/storage/rocks-history'))});
    (async()=>{ const db=new RocksHistoryStore(${JSON.stringify(path)}); await db.put(${JSON.stringify(message)}); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.ok((await readdir(path)).some((name) => name.endsWith('.sst')));
  // Remove WALs after the crash: acknowledged data must already reside in SSTs.
  for (const name of await readdir(path)) if (/^\d+\.log$/.test(name)) await rm(join(path, name));
  const store = new RocksHistoryStore(path);
  try { assert.deepEqual(await store.getByEventId(message.eventId), message); }
  finally { await store.close(); }
});

test('startup rejects inaccessible paths and incompatible metadata', async (t) => {
  const { directory } = await fixture(t);
  const file = join(directory, 'file');
  await writeFile(file, 'not a directory');
  const invalid = new RocksHistoryStore(join(file, 'db'));
  await assert.rejects(invalid.ready());
  await invalid.close();
  const path = join(directory, 'unsupported');
  const raw = RocksDatabase.open(path, { keyEncoding: 'binary', encoding: 'binary', compression: 'zstd' });
  await raw.put(Buffer.from([1, 1]), Buffer.from(JSON.stringify({ version: 1, value: { schemaVersion: 2 } })));
  raw.close();
  const unsupported = new RocksHistoryStore(path);
  await assert.rejects(unsupported.ready(), /Unsupported/);
  await unsupported.close();
});

test('permission-denied database startup rejects without creating a store', async (t) => {
  if (process.getuid?.() !== 0) { t.skip('Requires root to drop child privileges'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'rocks-permission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `const {RocksHistoryStore}=require(${JSON.stringify(require.resolve('../src/storage/rocks-history'))});
    process.setgid(65534); process.setuid(65534);
    (async()=>{ const db=new RocksHistoryStore(${JSON.stringify(join(directory, 'db'))});
      try { await db.ready(); process.exit(2); } catch(e) { await db.close(); process.exit(/permission|access|EACCES/i.test(e.message)?0:3); }
    })();`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(await readdir(directory), []);
});

test('failed durability gate rejects and duplicate retry flushes again', async (t) => {
  const { store } = await fixture(t);
  const original = RocksDatabase.prototype.flush;
  let calls = 0;
  RocksDatabase.prototype.flush = async function (options) {
    calls++;
    if (calls === 1) throw new Error('injected flush failure');
    return original.call(this, options);
  };
  try {
    await assert.rejects(store.put(item(1)), /injected flush failure/);
    assert.deepEqual(await store.put(item(1)), item(1));
    assert.equal(calls, 2);
    assert.equal((await store.conversations({ steamAccountId: account })).items[0].messageCount, 1);
  } finally { RocksDatabase.prototype.flush = original; }
});

test('all streams a snapshot while concurrent writes continue', async (t) => {
  const { store } = await fixture(t);
  await store.put(item(1));
  await store.put(item(2));
  const iterator = store.all()[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value?.eventId, item(1).eventId);
    await store.put(item(3));
    assert.equal((await iterator.next()).value?.eventId, item(2).eventId);
    assert.equal((await iterator.next()).done, true);
  } finally { await iterator.return?.(); }
});

test('close drains accepted writes and prevents new operations', async (t) => {
  const { store, path } = await fixture(t);
  const pending = store.put(item(1));
  const closing = store.close();
  await pending;
  await closing;
  await assert.rejects(store.put(item(2)), /closed/);
  await store.close();
  const reopened = new RocksHistoryStore(path);
  try { assert.ok(await reopened.getByEventId(item(1).eventId)); }
  finally { await reopened.close(); }
});
