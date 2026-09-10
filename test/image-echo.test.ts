import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHistoryStorage } from '../src/storage/history-storage';
import { normalizeStoredMessage, steamEventKey } from '../src/storage/history-message';
import { SteamImageAliases } from '../src/storage/history-steam-alias';
import type { HistoryRecordInput } from '../src/types';
const { createChatService } = require('../src/server/chat-service');
const { createSteamMessageLogger } = require('../src/steam/message-logger');
const account = '76561198000000001';
const peer = '76561198000000002';
const image = 'https://media.example.test/image';
const markup = `[img src=${image} thumbnail_src=${image}?imw=512 srcset="${image}?imw=1024 1024w" width=1272 height=2800][url=${image}]${image}[/url][/img]`;
const quiet = { info() {}, warn() {}, error() {} };
async function until(check: () => boolean | Promise<boolean>) {
  const end = performance.now() + 10000;
  while (performance.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Timed out waiting for image persistence');
}

for (const echoFirst of [false, true]) {
  test(`image upload and Steam BBCode echo persist one identity (${echoFirst ? 'echo' : 'callback'} first)`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-echo-'));
    const storage = createHistoryStorage({ logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'), logger: quiet });
    const steamUser = Object.assign(new EventEmitter(), { chat: new EventEmitter() });
    const dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
    let release!: (url: string) => void;
    const sent = new Promise<string>(resolve => { release = resolve; });
    const service = createChatService({ historyStorage: storage, steamUser, logger: quiet,
      steamCommunity: { sendImageToUser: () => sent },
      steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} } });
    const visible: string[] = [];
    storage.onMessage(item => visible.push(item.eventId!));
    t.after(async () => { release(image); await dispose.close(); await service.stop(); await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await until(() => storage.canSend());
    const sending = service.sendImageMessage(peer, { img: 'YWJj' });
    const echo = () => steamUser.chat.emit('friendMessageEcho', { steamid_friend: peer, message: markup, ordinal: 0, server_timestamp: new Date(Math.floor(Date.now() / 1000) * 1000) });
    if (echoFirst) { echo(); await until(() => visible.length === 1); }
    release(image);
    const response = await sending;
    if (!echoFirst) echo();
    await until(() => storage.status().rocksdb.durable >= 2 && storage.status().jsonl.durable >= 2);
    const page = await storage.history({ steamAccountId: account, id: peer });
    assert.equal(page.items.length, 1, 'One upload must not become a URL message plus a BBCode echo');
    assert.equal(page.items[0].eventId, response.eventId, 'HTTP ack must refer to the same event the phone syncs');
    assert.equal(visible.length, 1, 'WebSocket must not display both representations');
    const sync = await storage.sync({ steamAccountId: account });
    assert.equal(sync.items.length, 1);
    const rows = (await fs.readFile(path.join(dir, 'chat.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(rows.map(row => row.eventId)).size, 1);
  });
}

async function storageFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-pair-'));
  const storage = createHistoryStorage({ logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'), logger: quiet });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = { steamAccountId: account, id: peer, echo: true, sentAt: new Date().toISOString() };
  const upload: HistoryRecordInput = { ...base, type: 'image', message: image, imageSendSource: 'upload' };
  const echo: HistoryRecordInput = { ...base, type: 'message', message: markup, imageSendSource: 'echo' };
  return { storage, upload, echo };
}

test('repeated uploads pair one-to-one and a duplicate Steam echo does not consume the next upload', async t => {
  const { storage, upload, echo } = await storageFixture(t);
  const a = storage.append(upload);
  const b = storage.append(upload);
  assert.notEqual(a.eventId, b.eventId);
  const firstEcho = { ...echo, steamEventKey: steamEventKey(account, peer, true, markup, new Date(echo.sentAt!), 0) };
  assert.equal(storage.append(firstEcho).eventId, a.eventId);
  assert.equal(storage.append(firstEcho).eventId, a.eventId);
  const later = new Date(Date.parse(echo.sentAt!) + 1000);
  assert.equal(storage.append({ ...echo, sentAt: later.toISOString(),
    steamEventKey: steamEventKey(account, peer, true, markup, later, 0) }).eventId, b.eventId);
  const c = storage.append(upload);
  assert.notEqual(c.eventId, a.eventId);
  assert.notEqual(c.eventId, b.eventId);
});

for (const [name, change, historical] of [
  ['another account', { steamAccountId: '76561198000000003' }],
  ['another peer', { id: '76561198000000003' }],
  ['different full-size URL', { message: markup.replace(`src=${image} `, `src=${image}?different=1 `) }],
  ['captioned image', { message: `Caption ${markup}` }],
  ['multiple images', { message: markup + markup }],
  ['historical import', {}, true],
  ['timestamp outside matching window', { sentAt: new Date(Date.now() - 60000).toISOString() }]
] as Array<[string, Partial<HistoryRecordInput>, boolean?]>) {
  test(`image pairing preserves ${name}`, async t => {
    const { storage, upload, echo } = await storageFixture(t);
    const a = storage.append(upload);
    const b = storage.append({ ...echo, ...change }, { notify: !historical });
    assert.notEqual(a.eventId, b.eventId);
  });
}

test('same-image echoes with distinct Steam timestamps remain distinct sends', async t => {
  const { storage } = await storageFixture(t);
  const steamUser = Object.assign(new EventEmitter(), { chat: new EventEmitter() });
  const dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
  t.after(() => dispose.close());
  const at = Math.floor(Date.now() / 1000) * 1000;
  for (const time of [at, at + 1000]) steamUser.chat.emit('friendMessageEcho', {
    steamid_friend: peer, message: markup, ordinal: 0, server_timestamp: new Date(time)
  });
  await dispose.close();
  await until(() => storage.status().rocksdb.durable === 2);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 2);
});

test('expired image candidates are not reused even if Steam timestamps match', async t => {
  const { storage, upload, echo } = await storageFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const a = storage.append(upload);
    t.mock.timers.tick(30001);
    assert.notEqual(storage.append(echo).eventId, a.eventId);
  } finally { t.mock.timers.reset(); }
});

for (const quote of ['"', "'"]) {
  test(`image pairing accepts ${quote} quoted src attributes`, async t => {
    const { storage, upload, echo } = await storageFixture(t);
    const a = storage.append(upload);
    const b = storage.append({ ...echo, message: markup.replace(`src=${image} `, `src=${quote}${image}${quote} `) });
    assert.equal(a.eventId, b.eventId);
  });
}

for (const restart of [false, true]) {
  test(`Steam historical image replay keeps upload identity after ${restart ? 'restart' : 'cache expiry'}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-reimport-'));
    const options = { logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'), logger: quiet };
    let storage = createHistoryStorage(options);
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const steamUser = Object.assign(new EventEmitter(), { chat: Object.assign(new EventEmitter(), {
      getFriendMessageHistory(_id: string, _options: unknown, callback: Function) {
        callback(null, { messages: [{ sender: account, message: markup, ordinal: 0, server_timestamp: at }] });
      }
    }) });
    let dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
    const service = createChatService({ historyStorage: storage, steamUser, logger: quiet,
      steamCommunity: { sendImageToUser: async () => image },
      steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} } });
    t.after(async () => { t.mock.timers.reset(); await dispose.close(); await service.stop(); await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await until(() => storage.canSend());
    const response = await service.sendImageMessage(peer, { img: 'YWJj' });
    steamUser.chat.emit('friendMessageEcho', { steamid_friend: peer, message: markup, ordinal: 0, server_timestamp: at });
    await until(() => storage.status().rocksdb.durable >= 2 && storage.status().jsonl.durable >= 2);
    if (restart) {
      await dispose.close(); await storage.close();
      storage = createHistoryStorage(options);
      dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
    } else {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(31000);
    }
    // Incoming traffic starts the real historical import, while its live write races it.
    steamUser.chat.emit('friendMessage', { steamid_friend: peer, message: 'trigger', ordinal: 1, server_timestamp: at });
    await dispose.close();
    await until(() => storage.status().rocksdb.queued === 0 && storage.status().jsonl.queued === 0);
    const page = await storage.history({ steamAccountId: account, id: peer });
    const outgoing = page.items.filter(item => item.echo);
    assert.equal(outgoing.length, 1, 'Historical replay must not create a second outgoing image');
    assert.equal(outgoing[0].eventId, response.eventId);
    assert.equal(outgoing[0].message, image, 'The first immutable URL representation wins');
    assert.equal((await storage.sync({ steamAccountId: account })).items.filter(item => item.echo).length, 1);
  });
}

for (const echoFirst of [false, true]) {
  test(`durable image aliases serialize replay races and preserve repeated sends (${echoFirst ? 'echo' : 'upload'} first)`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-alias-race-'));
    const options = { logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'), logger: quiet };
    let storage = createHistoryStorage(options);
    t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const makeEcho = (offset: number): HistoryRecordInput => ({ steamAccountId: account, id: peer,
      echo: true, message: markup, ordinal: 0, sentAt: new Date(+at + offset).toISOString(), imageSendSource: 'echo',
      steamEventKey: steamEventKey(account, peer, true, markup, new Date(+at + offset), 0) });
    const upload: HistoryRecordInput = { steamAccountId: account, id: peer, echo: true,
      type: 'image', message: image, sentAt: at.toISOString(), imageSendSource: 'upload' };
    const ids: string[] = [];
    for (const offset of [0, 1000]) {
      let first;
      if (echoFirst) first = await storage.appendSteamImage!(makeEcho(offset));
      const sent = storage.append(upload);
      // No durability wait between counterpart and concurrent historical replays.
      const results = await Promise.all([
        storage.appendSteamImage!(makeEcho(offset)),
        storage.appendSteamImage!({ ...makeEcho(offset), imageSendSource: undefined }, { notify: false }),
        storage.appendSteamImage!({ ...makeEcho(offset), name: 'changed metadata' }, { notify: false })
      ]);
      for (const item of results) assert.equal(item.eventId, sent.eventId);
      if (first) assert.equal(first.eventId, sent.eventId);
      ids.push(sent.eventId!);
    }
    assert.notEqual(ids[0], ids[1]);
    await storage.close();
    storage = createHistoryStorage(options);
    const replays = await Promise.all([0, 1000].map(offset =>
      storage.appendSteamImage!(makeEcho(offset), { notify: false })));
    assert.deepEqual(replays.map(item => item.eventId), ids);
    await until(() => storage.status().rocksdb.queued === 0 && storage.status().jsonl.queued === 0);
    assert.equal((await storage.history({ steamAccountId: account, id: peer })).items.length, 2);
    assert.equal((await storage.sync({ steamAccountId: account })).items.length, 2);
  });
}

test('Steam image alias lookup fails closed when a missing copy could hold the mapping', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-alias-unavailable-'));
  const storage = createHistoryStorage({ logPath: path.join(dir, 'chat.jsonl'), dbPath: '/dev/null/no-db', logger: quiet });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const at = new Date();
  const input = { steamAccountId: account, id: peer, echo: true, message: markup, sentAt: at.toISOString(),
    steamEventKey: steamEventKey(account, peer, true, markup, at, 0) };
  await assert.rejects(storage.appendSteamImage!(input, { notify: false }), /identity lookup unavailable/);
  assert.equal(storage.status().jsonl.queued, 0);
  assert.equal(storage.status().jsonl.durable, 0);
});

test('a surviving JSONL image alias restores the immutable identity when RocksDB is unavailable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-alias-survivor-'));
  const logPath = path.join(dir, 'chat.jsonl');
  let storage = createHistoryStorage({ logPath, dbPath: path.join(dir, 'db'), logger: quiet });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const at = new Date();
  const input = { steamAccountId: account, id: peer, echo: true, message: markup, sentAt: at.toISOString(),
    steamEventKey: steamEventKey(account, peer, true, markup, at, 0), imageSendSource: 'echo' };
  const first = await storage.appendSteamImage!(input);
  await storage.close();
  storage = createHistoryStorage({ logPath, dbPath: '/dev/null/no-db', logger: quiet });
  assert.equal((await storage.appendSteamImage!(input, { notify: false })).eventId, first.eventId);
  await until(() => storage.status().jsonl.durable === 1);
});

// Simulate the crash boundary after alias fsync but before either primary write.
test('durable image alias restores a missing primary record without allocating a new identity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-alias-recovery-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const at = new Date('2026-09-10T08:26:37.000Z');
  const key = steamEventKey(account, peer, true, markup, at, 0)!;
  const original = normalizeStoredMessage({ steamAccountId: account, id: peer, echo: true, type: 'image',
    message: image, sentAt: '2026-09-10T08:26:37.283Z' });
  await new SteamImageAliases(`${logPath}.steam-image-aliases-v1`).put(key, original);
  const storage = createHistoryStorage({ logPath, dbPath: path.join(dir, 'db'), logger: quiet });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const replay = await storage.appendSteamImage!({ steamAccountId: account, id: peer, echo: true,
    message: markup, sentAt: at.toISOString(), steamEventKey: key }, { notify: false });
  assert.equal(replay.eventId, original.eventId);
  await until(() => storage.status().jsonl.durable === 1 && storage.status().rocksdb.durable === 1);
  assert.equal((await storage.history({ steamAccountId: account, id: peer })).items[0].eventId, original.eventId);
  const row = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
  assert.equal(row.message, image);
  assert.equal(row.sentAt, original.sentAt);
  assert.equal(row.steamImageEventKey, undefined, 'Transport metadata must not change the JSONL schema');
});

test('Steam logger retains exact timestamp precision for distinct same-image events', async t => {
  const { storage } = await storageFixture(t);
  const steamUser = Object.assign(new EventEmitter(), { chat: new EventEmitter() });
  const dispose = createSteamMessageLogger({ steamUser, historyStorage: storage, getSteamAccountId: () => account, logger: quiet });
  t.after(() => dispose.close());
  const at = Math.floor(Date.now() / 1000) * 1000;
  for (const millis of [10, 20]) steamUser.chat.emit('friendMessageEcho', {
    steamid_friend: peer, message: markup, ordinal: 0, server_timestamp: new Date(at + millis)
  });
  await dispose.close();
  await until(() => storage.status().rocksdb.durable === 2);
  const items = (await storage.history({ steamAccountId: account, id: peer })).items;
  assert.deepEqual(items.map(item => item.sentAt), [10, 20].map(millis => new Date(at + millis).toISOString()));
  assert.notEqual(items[0].eventId, items[1].eventId);
});

test('historical image without an established alias does not borrow an unmatched upload identity', async t => {
  const { storage, upload, echo } = await storageFixture(t);
  const sent = storage.append(upload);
  const historical: HistoryRecordInput = { ...echo, imageSendSource: undefined,
    steamEventKey: steamEventKey(account, peer, true, markup, new Date(echo.sentAt!), 0) };
  const imported = await storage.appendSteamImage!(historical, { notify: false });
  assert.notEqual(imported.eventId, sent.eventId, 'URL/time proximity is not proof for a historical merge');
  assert.equal((await storage.appendSteamImage!(historical, { notify: false })).eventId, imported.eventId);
});

test('Steam image identity admission bounds pending lookups and rejects after close', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-alias-admission-'));
  const storage = createHistoryStorage({ logPath: path.join(dir, 'chat.jsonl'), dbPath: path.join(dir, 'db'),
    logger: quiet, queueLimit: 1 });
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const at = new Date();
  const input = { steamAccountId: account, id: peer, echo: true, message: markup, sentAt: at.toISOString(),
    steamEventKey: steamEventKey(account, peer, true, markup, at, 0) };
  const accepted = storage.appendSteamImage!(input);
  await assert.rejects(storage.appendSteamImage!(input), /identity queue full/);
  await accepted;
  await storage.close();
  await assert.rejects(storage.appendSteamImage!(input), /storage closed/);
});
