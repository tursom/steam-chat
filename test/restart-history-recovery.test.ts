import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHistoryStorage, type HistoryStorage, type ConversationQuery } from '../src/storage/history-storage';
import { normalizeStoredMessage } from '../src/storage/history-message';
import { replaceableSteamClient } from '../src/steam/replaceable-client';
import type { ConversationSummary, HistoryItem, HistoryRecordInput } from '../src/types';

const { createSteamMessageLogger } = require('../src/steam/message-logger');
const account = '76561198000000001';
const peer = '76561198000000002';
const other = '76561198000000003';
const at = new Date('2024-03-09T16:00:00.000Z');
const sticker = '[sticker type="Sticker" appid="570" stickerid="1"][/sticker]';
const quiet = { info() {}, warn() {}, error() {} };
type Callback<T> = (error: unknown, value?: T) => void;
type Message = { sender: unknown; message: string; ordinal: number; server_timestamp: Date };
type HistoryResponse = { messages?: Message[]; more_available?: boolean };
type HistoryOptions = { maxCount: number; wantBbcode: boolean; startTime: number; lastTime?: Date; lastOrdinal?: number };
type Sessions = { sessions?: Array<{ steamid_friend: unknown }> };
type LogHandle = { close(timeoutMs?: number): Promise<void> };

class Chat extends EventEmitter {
  getActiveFriendMessageSessions(_options: Record<string, never>, callback: Callback<Sessions>): void {
    callback(null, { sessions: [] });
  }
  getFriendMessageHistory(_id: string, _options: HistoryOptions, callback: Callback<HistoryResponse>): void {
    callback(null, { messages: [] });
  }
}
class User extends EventEmitter {
  chat = new Chat();
  myFriends: Record<string, number> = {};
  getChatHistory?: (id: string, callback: Callback<Array<{ steamID?: unknown; message: string; timestamp: Date | number; ordinal?: number }>>) => void;
  logOff() {}
}
const message = (ordinal: number, body = `history ${ordinal}`, sender: unknown = peer): Message =>
  ({ sender, message: body, ordinal, server_timestamp: at });
const summary = (id: string): ConversationSummary => ({ id, name: id, updatedAt: at.toISOString(),
  preview: '', lastType: 'message', lastEcho: false, messageCount: 1 });

// Flush callback/Promise chains without advancing the retry/timeout clock.
async function flush() {
  for (let n = 0; n < 20; n++) await new Promise<void>(resolve => setImmediate(resolve));
}
async function until(predicate: () => boolean, description: string) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function fakeStorage() {
  const records: HistoryRecordInput[] = [];
  const dispatches: Array<{ notify?: boolean }> = [];
  const durable = new Set<(item: HistoryItem) => void>();
  const queries: ConversationQuery[] = [];
  const lane = { state: 'healthy', queued: 0, writable: true, durable: 0, missed: 0 };
  const storage: HistoryStorage = {
    async append(record, dispatch = {}) {
      records.push({ ...record }); dispatches.push(dispatch);
      const item = { ...normalizeStoredMessage(record), persistence: { jsonl: 'pending', rocksdb: 'pending' } };
      // Deliberately acknowledge before append resolves: the logger must subscribe first.
      for (const listener of durable) listener(item);
      return item;
    },
    async conversations(query) { queries.push(query); return { items: [] }; },
    async history() { return { items: [] }; },
    async sync(query) { return { items: [], nextCursor: 'next', hasMore: false, steamAccountId: query.steamAccountId }; },
    onDurable(listener) { durable.add(listener); return () => { durable.delete(listener); }; },
    onMessage() { return () => {}; },
    onStatus() { return () => {}; },
    status: () => ({ jsonl: { ...lane }, rocksdb: { ...lane } }),
    canSend: () => true,
    async close() { durable.clear(); }
  };
  return { storage, records, dispatches, durable, queries };
}
function start(steamUser: User, historyStorage: HistoryStorage, extra: Record<string, unknown> = {}): LogHandle {
  return createSteamMessageLogger({ steamUser, historyStorage, getSteamAccountId: () => account,
    getUserInfo: async () => ({ player_name: 'Peer' }), getSelfName: async () => 'Self', logger: quiet,
    historyRetryMs: 40, historyTimeoutMs: 25, ...extra });
}

// Executable counterparts of RestartHistory.tla: discovery without FriendMessage,
// CompleteOnlyArchived, NoFalseMerge, NoStaleCallbacks/Queries and partial-crash replay.
test('loggedOn alone recovers active sessions and every local conversation page; late friendsList adds friends', async t => {
  const f = fakeStorage();
  const user = new User();
  const early = '76561198000000004', late = '76561198000000005';
  const local = Array.from({ length: 101 }, (_, n) => String(76561198000001000n + BigInt(n)));
  user.myFriends = { [early]: 3, ignoredRelationship: 2 };
  user.chat.getActiveFriendMessageSessions = (options, callback) => {
    assert.deepEqual(options, {});
    callback(null, { sessions: [{ steamid_friend: { getSteamID64: () => other } },
      { steamid_friend: local[0] }, { steamid_friend: account }, { steamid_friend: '' }] });
  };
  f.storage.conversations = async query => {
    f.queries.push(query);
    assert.equal(query.steamAccountId, account);
    assert.equal(query.limit, 100);
    return query.before === undefined
      ? { items: local.slice(0, 100).map(summary), nextCursor: 'local-page-2' }
      : { items: [summary(local[100])] };
  };
  const calls: string[] = [];
  user.chat.getFriendMessageHistory = (id, options, callback) => {
    calls.push(id);
    assert.deepEqual(options, { maxCount: 100, wantBbcode: true, startTime: 1 });
    callback(null, { messages: [message(1, `offline ${id}`, id)] });
  };
  const log = start(user, f.storage);
  t.after(() => log.close());
  user.emit('loggedOn'); // No incoming or echo event is needed to begin recovery.
  await flush();
  const expected = [...local, other, early].sort();
  assert.deepEqual([...calls].sort(), expected);
  assert.deepEqual(f.queries.map(q => q.before), [undefined, 'local-page-2']);
  assert.deepEqual(f.records.map(r => r.id).sort(), expected);
  assert.ok(f.records.every(r => r.steamAccountId === account && !r.echo));
  assert.ok(f.dispatches.every(d => d.notify === false));
  assert.equal(f.durable.size, 0, 'immediate durable receipts are consumed and listeners released');

  user.myFriends[late] = 3;
  user.emit('friendsList');
  await flush();
  assert.deepEqual([...calls].sort(), [...expected, late].sort());
  user.emit('friendsList');
  await flush();
  assert.equal(calls.length, expected.length + 1, 'completed contacts are not reimported by late discovery');
});

test('real storage resumes a partial import after restart, pages overlapping same-second ordinals, and sync sees each identity once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'restart-history-'));
  const options = { dbPath: join(dir, 'db'), logPath: join(dir, 'chat.jsonl'), logger: quiet };
  let storage = createHistoryStorage(options);
  let log: LogHandle | undefined;
  t.after(async () => {
    try { await log?.close(20); } finally {
      try { await storage.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  // All 205 messages share one second. Repeated text/stickers, including echoes,
  // are independent Steam events because their ordinals differ.
  const messages = Array.from({ length: 205 }, (_, n) =>
    message(n + 1, n % 2 ? sticker : 'same text', (n + 1) % 3 === 0 ? account : peer));
  const pages = [messages.slice(105).reverse(), messages.slice(6, 106).reverse(), messages.slice(0, 7).reverse()];
  const first = new User();
  first.myFriends[peer] = 3;
  let firstCalls = 0;
  let interrupted!: Callback<HistoryResponse>;
  first.chat.getFriendMessageHistory = (_id, _query, callback) => {
    if (++firstCalls === 1) callback(null, { messages: pages[0], more_available: true });
    else interrupted = callback;
  };
  log = start(first, storage, { historyTimeoutMs: 2000 });
  first.emit('loggedOn');
  await until(() => Boolean(interrupted), 'first page durable before the interrupted second request');
  const initial = await storage.sync({ steamAccountId: account, limit: 500 });
  assert.equal(initial.items.length, 100);
  const originalIds = new Map(initial.items.map(item => [item.ordinal, item.eventId]));
  await log.close(5);
  interrupted(null, { messages: pages[1], more_available: true });
  await flush();
  assert.equal((await storage.sync({ steamAccountId: account, limit: 500 })).items.length, 100,
    'a response after close cannot archive the next page');
  await storage.close();

  storage = createHistoryStorage(options);
  const reopened = await storage.sync({ steamAccountId: account, limit: 500 });
  assert.deepEqual(reopened.items, initial.items, 'worker restart preserves canonical event IDs and sync order');
  const user = new User(); // Only persisted conversations discover peer after restart.
  const queries: HistoryOptions[] = [];
  let firstResponse!: Callback<HistoryResponse>;
  user.chat.getFriendMessageHistory = (id, query, callback) => {
    assert.equal(id, peer); queries.push(query);
    if (queries.length === 1) firstResponse = callback;
    else callback(null, { messages: pages[queries.length - 1], more_available: queries.length < 3 });
  };
  const notifications: HistoryItem[] = [];
  storage.onMessage(item => notifications.push(item));
  log = start(user, storage, { historyTimeoutMs: 2000 });
  user.emit('loggedOn');
  await until(() => Boolean(firstResponse), 'persisted local conversation discovery');
  // Race a previously missing live event against backfill; page three contains it too.
  user.chat.emit('friendMessage', { steamid_friend: peer, message: messages[4].message,
    ordinal: 5, server_timestamp: at });
  firstResponse(null, { messages: pages[0], more_available: true });
  await until(() => storage.status().rocksdb.durable >= 208, '207 overlapping history appends plus one live append');
  await flush();
  await log.close();
  assert.deepEqual(queries, [
    { maxCount: 100, wantBbcode: true, startTime: 1 },
    { maxCount: 100, wantBbcode: true, startTime: 1, lastTime: at, lastOrdinal: 106 },
    { maxCount: 100, wantBbcode: true, startTime: 1, lastTime: at, lastOrdinal: 7 }
  ]);
  const imported = await storage.sync({ steamAccountId: account, cursor: initial.nextCursor, limit: 500 });
  assert.equal(imported.items.length, 105, 'sync includes old-timestamp imports after the prior durable cursor');
  assert.equal(imported.hasMore, false);
  const all = await storage.history({ steamAccountId: account, id: peer, limit: 500 });
  assert.equal(all.items.length, 205);
  assert.equal(new Set(all.items.map(item => item.eventId)).size, 205);
  assert.equal(new Set(all.items.map(item => Number(item.ordinal))).size, 205);
  for (const item of all.items) {
    const source = messages[Number(item.ordinal) - 1];
    assert.equal(item.message, source.message);
    assert.equal(item.sentAt, at.toISOString());
    assert.equal(item.echo, source.sender === account);
    assert.equal(item.steamAccountId, account);
    assert.equal(item.name, item.echo ? 'Self' : 'Peer');
    if (originalIds.has(item.ordinal)) assert.equal(item.eventId, originalIds.get(item.ordinal));
  }
  assert.equal(notifications.length, 1, 'backfill is silent while live delivery remains visible');
  assert.equal(notifications[0].ordinal, 5);
  assert.deepEqual((await storage.sync({ steamAccountId: account, cursor: imported.nextCursor })).items, []);
  await storage.close();
  storage = createHistoryStorage(options);
  const final = await storage.sync({ steamAccountId: account, limit: 500 });
  assert.equal(final.items.length, 205);
  assert.equal(new Set(final.items.map(item => item.syncId)).size, 205);
  assert.deepEqual((await storage.sync({ steamAccountId: account, cursor: imported.nextCursor })).items, []);
  const jsonl = (await readFile(options.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(jsonl.length, 205, 'both durable lanes deduplicate replay and page-boundary overlap');
  assert.equal(new Set(jsonl.map(item => item.eventId)).size, 205);
});

test('transient active/local discovery and modern history failures retry even after legacy salvage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeStorage(), user = new User();
  user.myFriends[peer] = 3;
  let sessions = 0, local = 0, history = 0, legacy = 0;
  user.chat.getActiveFriendMessageSessions = (_options, callback) => {
    if (++sessions === 1) callback(new Error('temporary discovery failure'));
    else callback(null, { sessions: [{ steamid_friend: other }] });
  };
  f.storage.conversations = async () => {
    if (++local === 1) throw new Error('temporary local query failure');
    return { items: [summary(peer)] };
  };
  user.chat.getFriendMessageHistory = (id, _query, callback) => {
    if (id === peer && ++history === 1) callback(new Error('temporary history failure'));
    else callback(null, { messages: [message(2, `modern ${id}`, id)] });
  };
  user.getChatHistory = (_id, callback) => {
    legacy++; callback(null, [{ message: 'legacy salvage', timestamp: +at / 1000, ordinal: 1 }]);
  };
  const log = start(user, f.storage);
  t.after(() => log.close());
  user.emit('loggedOn');
  await flush();
  assert.equal(history, 1); assert.equal(legacy, 1);
  assert.deepEqual(f.records.map(r => r.message), ['legacy salvage']);
  t.mock.timers.tick(39); await flush();
  assert.equal(sessions, 1); assert.equal(local, 1); assert.equal(history, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(sessions, 2); assert.equal(local, 2); assert.equal(history, 2);
  assert.deepEqual(f.records.map(r => r.message).sort(), ['legacy salvage', `modern ${peer}`, `modern ${other}`].sort());
  assert.equal(legacy, 1, 'legacy salvage must not certify the failed modern import as complete');
  t.mock.timers.tick(200); await flush();
  assert.equal(history, 2, 'successful recovery stops retrying');
});

test('repeated modern failures do not replay legacy SDK Date rows without ordinals before modern recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeStorage(), user = new User();
  user.myFriends[peer] = 3;
  let calls = 0, legacy = 0;
  user.chat.getFriendMessageHistory = (_id, _query, callback) => {
    if (++calls < 3) callback(new Error('temporary modern failure'));
    else callback(null, { messages: [message(1, sticker)] });
  };
  // Match the installed SDK: Date already contains milliseconds, ordinal absent.
  user.getChatHistory = (_id, callback) => {
    legacy++;
    callback(null, [{ steamID: peer, message: sticker, timestamp: at }]);
  };
  const log = start(user, f.storage);
  t.after(() => log.close());
  user.emit('loggedOn');
  await flush();
  t.mock.timers.tick(40); await flush();
  assert.equal(calls, 2);
  assert.equal(legacy, 2);
  assert.deepEqual(f.records, [], 'an incomplete legacy identity must not create extra rows on every retry');
  t.mock.timers.tick(40); await flush();
  assert.equal(calls, 3);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].ordinal, 1);
  assert.equal(f.records[0].sentAt, at.toISOString());
  t.mock.timers.tick(200); await flush();
  assert.equal(calls, 3);
});

for (const phase of ['discovery', 'history'] as const) {
  test(`${phase} timeout retries without an inbound event and ignores the late first response`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeStorage(), user = new User();
    let calls = 0;
    let late: () => void;
    const ids: string[] = [];
    if (phase === 'discovery') {
      user.chat.getActiveFriendMessageSessions = (_options, callback) => {
        if (++calls === 1) late = () => callback(null, { sessions: [{ steamid_friend: 'stale-session' }] });
        else callback(null, { sessions: [{ steamid_friend: peer }] });
      };
    } else user.myFriends[peer] = 3;
    user.chat.getFriendMessageHistory = (id, _query, callback) => {
      ids.push(id);
      if (phase === 'history' && ++calls === 1) late = () => callback(null, { messages: [message(99, 'late expired response')] });
      else callback(null, { messages: [message(1)] });
    };
    const log = start(user, f.storage);
    t.after(() => log.close());
    user.emit('loggedOn'); await flush();
    t.mock.timers.tick(24); await flush();
    assert.equal(calls, 1); assert.equal(f.records.length, 0);
    t.mock.timers.tick(1); await flush();
    t.mock.timers.tick(39); await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(calls, 2);
    assert.deepEqual(f.records.map(r => r.message), ['history 1']);
    late!(); await flush();
    assert.ok(ids.every(id => id === peer));
    assert.equal(f.records.length, 1);
  });
}

test('default history timeout is 15s and default retry delay is 30s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeStorage(), user = new User();
  user.myFriends[peer] = 3;
  let calls = 0, warnings = 0;
  user.chat.getFriendMessageHistory = (_id, _options, callback) => {
    if (++calls > 1) callback(null, { messages: [message(1)] });
  };
  const log = start(user, f.storage, { historyTimeoutMs: undefined, historyRetryMs: undefined,
    logger: { ...quiet, warn() { warnings++; } } });
  t.after(() => log.close());
  user.emit('loggedOn'); await flush();
  t.mock.timers.tick(14999); await flush(); assert.equal(warnings, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(warnings, 1);
  t.mock.timers.tick(29999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls, 2); assert.equal(f.records.length, 1);
});

for (const failure of ['both lanes failed', 'no durable receipt', 'unrelated durable receipt'] as const) {
  test(`${failure} cannot complete or advance pagination; recovery retries the unconfirmed page`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeStorage(), user = new User();
    user.myFriends[peer] = 3;
    const queries: HistoryOptions[] = [];
    user.chat.getFriendMessageHistory = (_id, query, callback) => {
      queries.push(query);
      callback(null, query.lastOrdinal === undefined
        ? { messages: [message(2)], more_available: true }
        : { messages: [message(1)], more_available: false });
    };
    const append = f.storage.append;
    let appends = 0;
    f.storage.append = async (record, dispatch) => {
      if (++appends > 1) return append(record, dispatch);
      const item = { ...normalizeStoredMessage(record), persistence: failure === 'both lanes failed'
        ? { jsonl: 'failed', rocksdb: 'failed' } : { jsonl: 'pending', rocksdb: 'pending' } };
      if (failure === 'unrelated durable receipt') {
        for (const listener of f.durable) listener({ ...item, eventId: 'different-event-id' });
      }
      return item;
    };
    const log = start(user, f.storage);
    t.after(() => log.close());
    user.emit('loggedOn'); await flush();
    assert.equal(queries.length, 1);
    assert.equal(f.records.length, 0);
    if (failure !== 'both lanes failed') {
      assert.equal(f.durable.size, 1);
      t.mock.timers.tick(24); await flush(); assert.equal(queries.length, 1);
      t.mock.timers.tick(1); await flush();
    }
    assert.equal(f.durable.size, 0, 'failed/timed-out persistence unsubscribes its receipt listener');
    t.mock.timers.tick(39); await flush(); assert.equal(queries.length, 1);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(queries, [
      { maxCount: 100, wantBbcode: true, startTime: 1 },
      { maxCount: 100, wantBbcode: true, startTime: 1 },
      { maxCount: 100, wantBbcode: true, startTime: 1, lastTime: at, lastOrdinal: 2 }
    ]);
    assert.deepEqual(f.records.map(r => r.ordinal), [2, 1]);
    assert.equal(f.durable.size, 0);
    t.mock.timers.tick(200); await flush(); assert.equal(queries.length, 3);
  });
}

for (const switchAccount of [false, true]) {
  for (const phase of ['discovery', 'history'] as const) {
    test(`${switchAccount ? 'account switch' : 'same-account loggedOn'} invalidates old ${phase} callbacks before archive or follow-up query`, async t => {
      const f = fakeStorage();
      const clients: User[] = [];
      const stable = replaceableSteamClient(() => { const user = new User(); clients.push(user); return user; });
      let active = account;
      const old = clients[0];
      let release!: () => void;
      let oldQueries = 0;
      if (phase === 'discovery') {
        old.chat.getActiveFriendMessageSessions = (_query, callback) => {
          release = () => callback(null, { sessions: [{ steamid_friend: 'retired-contact' }] });
        };
      } else {
        old.myFriends[peer] = 3;
        old.chat.getFriendMessageHistory = (_id, _query, callback) => {
          oldQueries++;
          release = () => callback(null, { messages: [message(7, 'retired page')], more_available: true });
        };
      }
      const log = start(stable.client, f.storage, { getSteamAccountId: () => active, historyTimeoutMs: 2000 });
      t.after(() => log.close());
      old.emit('loggedOn'); await flush(); assert.equal(typeof release, 'function');
      stable.replace();
      if (switchAccount) active = other;
      const next = clients[1];
      next.myFriends[peer] = 3;
      const newQueries: string[] = [];
      next.chat.getFriendMessageHistory = (id, query, callback) => {
        newQueries.push(id);
        assert.equal(query.lastTime, undefined, 'a retired cursor cannot query the new SDK instance');
        callback(null, { messages: [message(1, 'new connection')] });
      };
      next.emit('loggedOn'); await flush();
      assert.deepEqual(f.records.map(r => [r.message, r.steamAccountId]), [['new connection', active]],
        'the old pending connection must not block the new recovery queue');
      release(); await flush();
      old.emit('friendsList'); old.emit('friendMessage', peer, 'retired live event');
      await flush();
      assert.deepEqual(newQueries, [peer]);
      assert.equal(oldQueries, phase === 'history' ? 1 : 0);
      assert.equal(f.records.length, 1);
      assert.ok(f.queries.every(q => q.steamAccountId === account || q.steamAccountId === active));
    });
  }
}

test('reloggedOn while awaiting a durable append stops the old page and its next-page query', async t => {
  const f = fakeStorage(), user = new User();
  user.myFriends[peer] = 3;
  let calls = 0;
  user.chat.getFriendMessageHistory = (_id, _query, callback) => {
    callback(null, ++calls === 1 ? { messages: [message(2, 'already admitted'), message(3, 'stale remaining row')], more_available: true }
      : { messages: [message(4, 'new round')] });
  };
  const append = f.storage.append;
  let oldReceipt!: HistoryItem;
  f.storage.append = async (record, dispatch) => {
    if (!oldReceipt) {
      oldReceipt = { ...normalizeStoredMessage(record), persistence: { jsonl: 'pending', rocksdb: 'pending' } };
      return oldReceipt;
    }
    return append(record, dispatch);
  };
  const log = start(user, f.storage, { historyTimeoutMs: 2000 });
  t.after(() => log.close());
  user.emit('loggedOn'); await flush(); assert.ok(oldReceipt);
  user.emit('loggedOn'); await flush();
  assert.deepEqual(f.records.map(r => r.message), ['new round']);
  for (const listener of f.durable) listener(oldReceipt);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(f.records.map(r => r.message), ['new round']);
  assert.equal(f.durable.size, 0);
});

test('replacement rebinds modern chat BBCode, timestamps and ordinals and removes retired chat listeners', async t => {
  const f = fakeStorage();
  const clients: User[] = [];
  const stable = replaceableSteamClient(() => { const user = new User(); clients.push(user); return user; });
  const log = start(stable.client, f.storage);
  t.after(() => log.close());
  const old = clients[0];
  assert.equal(old.chat.listenerCount('friendMessage'), 1);
  stable.replace();
  const next = clients[1];
  next.emit('loggedOn'); await flush();
  assert.equal(old.chat.listenerCount('friendMessage'), 0);
  assert.equal(old.chat.listenerCount('friendMessageEcho'), 0);
  assert.equal(next.chat.listenerCount('friendMessage'), 1);
  old.chat.emit('friendMessage', { steamid_friend: peer, message: 'stale chat', ordinal: 1, server_timestamp: at });
  next.chat.emit('friendMessage', { steamid_friend: peer, message: sticker, message_no_bbcode: 'plain sticker',
    ordinal: '51', server_timestamp: +at / 1000 });
  next.emit('friendMessage', peer, 'plain sticker');
  const image = '[img src="https://images.steamusercontent.com/ugc/test/image.png"][/img]';
  next.chat.emit('friendMessageEcho', { steamid_friend: peer, message: image, message_no_bbcode: 'plain image',
    ordinal: 52, server_timestamp: +at + 1000 });
  next.emit('friendMessageEcho', peer, 'plain image', 52);
  await flush();
  assert.equal(f.records.length, 2, 'compatibility events do not add metadata-poor duplicate rows');
  const incoming = f.records.find(r => !r.echo)!;
  const echo = f.records.find(r => r.echo)!;
  assert.deepEqual([incoming.message, incoming.ordinal, incoming.sentAt, incoming.name], [sticker, '51', at.toISOString(), 'Peer']);
  assert.deepEqual([echo.message, echo.ordinal, echo.sentAt, echo.name], [image, 52, new Date(+at + 1000).toISOString(), 'Self']);
  assert.ok(f.records.every(r => r.steamAccountId === account && typeof r.steamEventKey === 'string'));
  await log.close();
  for (const event of ['friendMessage', 'friendMessageEcho', 'loggedOn', 'friendsList', 'disconnected', 'loggedOff']) {
    assert.equal(stable.client.listenerCount(event), 0, `${event} listener removed on close`);
  }
  assert.equal(next.chat.listenerCount('friendMessage'), 0);
  assert.equal(next.chat.listenerCount('friendMessageEcho'), 0);
});

test('close cancels scheduled discovery/history retries and removes lifecycle and message listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeStorage(), user = new User();
  user.myFriends[peer] = 3;
  let calls = 0;
  user.chat.getActiveFriendMessageSessions = (_query, callback) => { calls++; callback(new Error('discovery offline')); };
  user.chat.getFriendMessageHistory = (_id, _query, callback) => { calls++; callback(new Error('history offline')); };
  const log = start(user, f.storage);
  t.after(() => log.close());
  user.emit('loggedOn'); await flush(); assert.equal(calls, 2);
  await log.close();
  assert.equal(f.durable.size, 0);
  assert.equal(user.eventNames().length, 0);
  assert.equal(user.chat.eventNames().length, 0);
  t.mock.timers.tick(1000);
  user.emit('loggedOn'); user.emit('friendsList'); user.emit('disconnected'); user.emit('loggedOff');
  user.emit('friendMessage', peer, 'after close');
  user.chat.emit('friendMessageEcho', { steamid_friend: peer, message: 'after close', ordinal: 1, server_timestamp: at });
  await flush();
  assert.equal(calls, 2);
  assert.equal(f.records.length, 0);
});
