import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createHistoryStorage } from '../src/storage/history-storage';
import { steamEventKey } from '../src/storage/history-message';
import type { HistoryRecordInput } from '../src/types';

const { createChatService } = require('../src/server/chat-service');
const SteamUser = require('steam-user');
const SteamID = require('steamid');
const account = '76561198000000002';
const peer = '76561198000000001';
const other = '76561198000000003';
const logger = { info() {}, warn() {}, error() {} };
const uncertain = (error: { statusCode?: number; uncertain?: boolean }) => error.statusCode === 502 && error.uncertain === true;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const entry = (extra: Record<string, unknown> = {}) => ({ sender: new SteamID(account),
  message: 'lost ack', server_timestamp: new Date(), ordinal: 7, ...extra });
type Reader = (id: string, options: unknown, callback: (error: unknown, result?: unknown) => void) => unknown;

function probe(t: TestContext, reader?: Reader, options: Record<string, unknown> = {}) {
  let sends = 0;
  let reads = 0;
  const records: HistoryRecordInput[] = [];
  const user = Object.assign(new EventEmitter(), { steamID: new SteamID(account), chat: {
    sendFriendMessage(_id: string, _message: string, callback: (error: unknown) => void) {
      sends++;
      callback(new Error('Request timed out'));
    },
    ...(reader ? { getFriendMessageHistory(id: string, opts: unknown, callback: (error: unknown, result?: unknown) => void) {
      reads++;
      assert.equal(id, peer);
      assert.deepEqual(opts, { maxCount: 20, wantBbcode: true });
      return reader(id, opts, callback);
    } } : {})
  } });
  const service = createChatService({ steamUser: user, logger, historyStorage: {
    canSend: () => true,
    append(record: HistoryRecordInput) { records.push(record); return record; },
    onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
  }, ...options });
  t.after(() => service.stop());
  return { service, user, records, counts: () => ({ sends, reads }) };
}

for (const { input, canonical, existing } of [
  { input: 'lost ack', canonical: 'lost ack', existing: false },
  { input: ':Khappy:', canonical: '[emoticon]Khappy[/emoticon]', existing: false },
  { input: '[emoticon]Khappy[/emoticon]', canonical: '\\[emoticon]Khappy\\[/emoticon]', existing: false },
  { input: 'Visit https://example.test/a', canonical: 'Visit [url=https://example.test/a]https://example.test/a[/url]', existing: true }
]) {
  test(`real SDK history after lost acknowledgement broadcasts actual canonical event: ${input}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'text-send-reconciliation-'));
    const storage = createHistoryStorage({ logPath: join(directory, 'chat.jsonl'), dbPath: join(directory, 'db'), logger });
    const user = new SteamUser({ autoRelogin: false });
    user.steamID = new SteamID(account);
    let timestamp = 0;
    const originals: Array<{ eventId?: string }> = [];
    const packets: Array<{ method: string; payload: any }> = [];
    user._sendUnified = (method: string, payload: unknown, callback: (body: unknown, header: unknown) => void) => {
      packets.push({ method, payload });
      if (method === 'FriendMessages.SendMessage#1') {
        timestamp = Math.floor(Date.now() / 1000);
        // Steam accepted the text, but its send acknowledgement was lost.
        // Seed the concurrent import at submission time, not before storage and
        // WebSocket setup, which may span a second boundary on a busy runner.
        if (existing) {
          void storage.append({ steamAccountId: account, id: peer, echo: true, message: canonical,
            sentAt: new Date(timestamp * 1000).toISOString(), ordinal: 7, name: 'Earlier import' }, { notify: false })
            .then(original => { originals.push(original); callback({}, { proto: { eresult: 16 } }); });
        } else callback({}, { proto: { eresult: 16 } });
      } else if (method === 'FriendMessages.GetActiveMessageSessions#1') {
        callback({ message_sessions: [], timestamp }, { proto: { eresult: 1 } });
      } else {
        assert.equal(method, 'FriendMessages.GetRecentMessages#1');
        callback({ messages: [{ accountid: user.steamID.accountid, timestamp, ordinal: 7, message: canonical },
          { accountid: user.steamID.accountid, timestamp, ordinal: 8, message: '[emoticon]Khappy[/emoticon]' }].slice(0,
            input.startsWith('[') ? 2 : 1),
          more_available: false }, { proto: { eresult: 1 } });
      }
    };
    const service = createChatService({ steamUser: user, historyStorage: storage, logger,
      getSelfName: async () => 'Actual self', config: { host: '127.0.0.1', port: 0, wsHeartbeatMs: 0 },
      steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} } });
    t.after(async () => {
      await service.stop();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    });
    for (let i = 0; !storage.canSend() && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(storage.canSend(), true);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/ws`);
    t.after(() => ws.terminate());
    await once(ws, 'message');
    const messages: any[] = [];
    const completed = new Promise<void>(resolve => ws.on('message', data => {
      const item = JSON.parse(String(data));
      messages.push(item);
      if (item.requestId === 'lost-ack') resolve();
    }));
    ws.send(JSON.stringify({ type: 'send_message', requestId: 'lost-ack', id: peer, msg: input }));
    await completed;
    assert.deepEqual(messages.map(item => item.type), ['message', 'error']);
    assert.equal(messages[1].uncertain, true);
    assert.equal(messages[1].requestId, 'lost-ack');
    const actual = messages[0];
    assert.equal(actual.requestId, undefined);
    assert.equal(actual.message, canonical);
    assert.equal(actual.echo, true);
    assert.equal(actual.id, peer);
    assert.equal(actual.steamAccountId, account);
    assert.equal(actual.ordinal, 7);
    assert.equal(actual.sentAt, new Date(timestamp * 1000).toISOString());
    assert.equal(actual.name, existing ? 'Earlier import' : 'Actual self');
    if (existing) assert.equal(actual.eventId, originals[0].eventId);
    assert.deepEqual((await storage.sync({ steamAccountId: account })).items.map(item => item.eventId), [actual.eventId]);
    assert.equal(packets.filter(item => item.method === 'FriendMessages.SendMessage#1').length, 1);
    const reads = packets.filter(item => item.method === 'FriendMessages.GetRecentMessages#1');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].payload.steamid1, account);
    assert.equal(reads[0].payload.steamid2, peer);
    assert.equal(reads[0].payload.count, 20);
    assert.equal(reads[0].payload.bbcode_format, true);
  });
}

test('callback history imports only matching recent self text with valid actual metadata, in event order', async t => {
  const now = Date.now();
  const { service, records, counts } = probe(t, (_id, _opts, callback) => callback(null, { messages: [
    entry({ ordinal: 8 }), entry({ ordinal: 0, server_timestamp: new Date(now - 500) }),
    entry({ sender: new SteamID(peer) }), entry({ sender: new SteamID(other) }), entry({ sender: undefined }),
    entry({ server_timestamp: new Date(now - 60_000) }), entry({ server_timestamp: new Date(now + 60_000) }),
    entry({ message: 'lost ack ' }), entry({ message: 'LOST ACK' }), entry({ message: 'a different message' }),
    entry({ server_timestamp: new Date(NaN) }), entry({ server_timestamp: now }),
    entry({ ordinal: undefined }), entry({ ordinal: null }), entry({ ordinal: '' }),
    entry({ ordinal: -1 }), entry({ ordinal: 1.5 }), entry({ ordinal: 0x100000000 }),
    entry({ ordinal: false }), entry({ ordinal: '9' })
  ] }));
  await assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
  assert.deepEqual(records.map(item => item.ordinal), [0, 8, '9']);
  for (const record of records) {
    assert.equal(record.type, 'message');
    assert.equal(record.echo, true);
    assert.equal(record.steamAccountId, account);
    assert.equal(record.id, peer);
    assert.equal(record.message, 'lost ack');
    assert.equal(record.steamEventKey, steamEventKey(account, peer, true, 'lost ack', new Date(record.sentAt!), record.ordinal));
  }
  assert.deepEqual(counts(), { sends: 1, reads: 1 });
});

test('overlapping uncertain sends cannot duplicate one recovered Steam event in legacy JSONL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-send-legacy-'));
  const logPath = join(directory, 'chat.jsonl');
  const actual = entry();
  const { service, counts } = probe(t, (_id, _opts, callback) => callback(null, { messages: [actual, actual] }),
    { historyStorage: undefined, logPath });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain),
    assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain)]);
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'lost ack');
  assert.deepEqual(counts(), { sends: 2, reads: 2 });
});

test('submission window starts at SDK submission, after the login waiter', async t => {
  let online!: () => void;
  let old!: ReturnType<typeof entry>;
  const { service, records } = probe(t, (_id, _opts, callback) => callback(null, { messages: [old, entry()] }), {
    waitForLogin: new Promise<void>(resolve => { online = resolve; })
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
  old = entry();
  t.mock.timers.tick(30_000);
  online();
  await sending;
  assert.equal(records.length, 1);
  assert.equal(records[0].sentAt, new Date().toISOString());
});

test('real SDK 10-second acknowledgement timeout triggers one read and never resends', async t => {
  const user = new SteamUser({ autoRelogin: false });
  user.steamID = new SteamID(account);
  const methods: string[] = [];
  user._sendUnified = (method: string, _payload: unknown, callback: (body: unknown, header: unknown) => void) => {
    methods.push(method);
    if (method === 'FriendMessages.SendMessage#1') return; // Deliver, but lose the acknowledgement entirely.
    if (method === 'FriendMessages.GetActiveMessageSessions#1') {
      callback({ message_sessions: [] }, { proto: { eresult: 1 } });
    } else {
      assert.equal(method, 'FriendMessages.GetRecentMessages#1');
      callback({ messages: [{ accountid: user.steamID.accountid, timestamp: Math.floor(Date.now() / 1000) - 10,
        ordinal: 7, message: 'lost ack' }] }, { proto: { eresult: 1 } });
    }
  };
  const { service, records } = probe(t, undefined, { steamUser: user });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
  await turn();
  assert.deepEqual(methods, ['FriendMessages.SendMessage#1']);
  t.mock.timers.tick(10_000);
  await sending;
  assert.deepEqual(methods, ['FriendMessages.SendMessage#1', 'FriendMessages.GetActiveMessageSessions#1',
    'FriendMessages.GetRecentMessages#1']);
  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'lost ack');
  t.mock.timers.reset();
});

test('explicit Steam rejections are failed rather than uncertain and never retried automatically', async t => {
  for (const eresult of [8, 15, 17, 25, 84]) {
    const { service, user, records, counts } = probe(t, async () => ({ messages: [entry()] }));
    let sends = 0;
    user.chat.sendFriendMessage = (_id, _message, callback) => {
      sends++; callback(Object.assign(new Error('Steam rejected the request'), { eresult }));
    };
    await assert.rejects(service.sendTextMessage(peer, 'lost ack', account),
      (error: { uncertain?: boolean }) => error.uncertain === false);
    assert.equal(sends, 1); assert.equal(counts().reads, 0); assert.equal(records.length, 0);
  }
});

test('successful sends, permanent failures and pre-submission failures never read history', async t => {
  for (const kind of ['success', 'permanent', 'before submission']) {
    const { service, user, records, counts } = probe(t, async () => ({ messages: [entry()] }), {
      ...(kind === 'before submission' ? { waitForLogin: () => { throw new Error('Timeout'); } } : {})
    });
    user.chat.sendFriendMessage = (_id: string, _message: string, callback: (error: unknown, result?: unknown) => void) => {
      callback(kind === 'permanent' ? new Error('Access denied') : null,
        { modified_message: 'lost ack', server_timestamp: new Date(), ordinal: 7 });
    };
    if (kind === 'success') await service.sendTextMessage(peer, 'lost ack', account);
    else await assert.rejects(service.sendTextMessage(peer, 'lost ack', account),
      (error: { uncertain?: boolean }) => error.uncertain !== true);
    assert.equal(counts().reads, 0);
    assert.equal(records.length, kind === 'success' ? 1 : 0);
  }
});

for (const body of [undefined, {}, { messages: null }, { messages: [null, {}, 'bad'] }, { messages: [] }]) {
  test(`missing or malformed history keeps uncertain 502: ${JSON.stringify(body)}`, async t => {
    const { service, records, counts } = probe(t, async () => body);
    await assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
    assert.deepEqual(records, []);
    assert.deepEqual(counts(), { sends: 1, reads: 1 });
  });
}

for (const mode of ['absent', 'callback error', 'promise error', 'throw'] as const) {
  test(`unavailable history source preserves uncertain result without resending: ${mode}`, async t => {
    const { service, records, counts } = probe(t, mode === 'absent' ? undefined : (_id, _opts, callback) => {
      if (mode === 'callback error') callback(new Error('history unavailable'));
      else if (mode === 'promise error') return Promise.reject(new Error('history unavailable'));
      else throw new Error('history unavailable');
    });
    await assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
    assert.deepEqual(records, []);
    assert.deepEqual(counts(), { sends: 1, reads: mode === 'absent' ? 0 : 1 });
  });
}

for (const stage of ['history', 'metadata', 'between records'] as const) {
  test(`revocation after ${stage} await throws authorization error and stops importing`, async t => {
    let allowed = true;
    let completeRead!: (error: unknown, result?: unknown) => void;
    let completeName!: (value: string) => void;
    const forbidden = Object.assign(new Error('grant revoked'), { statusCode: 403, code: 'steam_grant_insufficient' });
    const authorize = (level: string) => { assert.equal(level, 'chat'); if (!allowed) throw forbidden; };
    const { service, records, counts } = probe(t, (_id, _opts, callback) => { completeRead = callback; }, {
      getSelfName: () => new Promise<string>(resolve => { completeName = resolve; }),
      ...(stage === 'between records' ? { historyStorage: {
        canSend: () => true,
        async append(record: HistoryRecordInput) { records.push(record); allowed = false; return record; },
        onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
      } } : {})
    });
    const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account, authorize), error => error === forbidden);
    await turn();
    if (stage === 'history') allowed = false;
    completeRead(null, { messages: [entry(), entry({ ordinal: 8 })] });
    await turn();
    if (stage === 'metadata') allowed = false;
    completeName('Me');
    await sending;
    assert.equal(records.length, stage === 'between records' ? 1 : 0);
    assert.deepEqual(counts(), { sends: 1, reads: 1 });
  });
}

for (const source of ['SDK', 'active account'] as const) {
  test(`account changed while reading history is rejected even without HistoryStorage: ${source}`, async t => {
    let complete!: (error: unknown, result?: unknown) => void;
    let active = account;
    const { service, user, records, counts } = probe(t, (_id, _opts, callback) => { complete = callback; }, {
      historyStorage: undefined,
      steamLoginService: { getStatus: () => ({ status: 'online', steamId: active }), ensureOnline() {} }
    });
    const broadcasts: unknown[] = [];
    service.clients.add({ readyState: WebSocket.OPEN, send: (message: unknown) => broadcasts.push(message), terminate() {} });
    const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account),
      (error: { statusCode?: number }) => error.statusCode === 409);
    await turn();
    if (source === 'SDK') user.steamID = new SteamID(other);
    else active = other;
    complete(null, { messages: [entry()] });
    await sending;
    assert.deepEqual(records, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(counts(), { sends: 1, reads: 1 });
  });
}

test('revocation during a failed history read still surfaces the authorization error', async t => {
  let complete!: (error: unknown) => void;
  let allowed = true;
  const forbidden = Object.assign(new Error('session revoked'), { statusCode: 401 });
  const { service, records } = probe(t, (_id, _opts, callback) => { complete = callback; });
  const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account, () => {
    if (!allowed) throw forbidden;
  }), error => error === forbidden);
  await turn();
  allowed = false;
  complete(new Error('history unavailable'));
  await sending;
  assert.deepEqual(records, []);
});

test('a healthy five-second history lookup still reconciles the delivered message', async t => {
  let complete!: (error: unknown, result?: unknown) => void;
  const { service, records } = probe(t, (_id, _opts, callback) => { complete = callback; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const actual = entry();
  const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain);
  await turn();
  t.mock.timers.tick(4900);
  complete(null, { messages: [actual] });
  await sending;
  assert.equal(records.length, 1);
  assert.equal(records[0].ordinal, actual.ordinal);
});

for (const late of ['callback', 'resolve', 'reject'] as const) {
  test(`12-second history bound discards late ${late} without persistence`, async t => {
    let complete!: (error: unknown, result?: unknown) => void;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const { service, records, counts } = probe(t, (_id, _opts, callback) => {
      complete = callback;
      if (late !== 'callback') return new Promise((yes, no) => { resolve = yes; reject = no; });
    });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let finished = false;
    const sending = assert.rejects(service.sendTextMessage(peer, 'lost ack', account), uncertain).then(() => { finished = true; });
    await turn();
    t.mock.timers.tick(11_999);
    await turn();
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    await sending;
    assert.equal(finished, true);
    if (late === 'callback') complete(null, { messages: [entry()] });
    else if (late === 'resolve') resolve({ messages: [entry()] });
    else reject(new Error('late history failure'));
    await turn();
    assert.deepEqual(records, []);
    assert.deepEqual(counts(), { sends: 1, reads: 1 });
    t.mock.timers.reset();
  });
}
