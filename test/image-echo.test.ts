import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHistoryStorage } from '../src/storage/history-storage';
import { steamEventKey } from '../src/storage/history-message';
import type { HistoryRecordInput } from '../src/types';
const { createChatService } = require('../src/server/chat-service');
const { createSteamMessageLogger } = require('../src/steam/message-logger');
const account = '76561198000000001';
const peer = '76561198000000002';
const image = 'https://media.example.test/image';
const markup = `[img src=${image} thumbnail_src=${image}?imw=512 srcset="${image}?imw=1024 1024w" width=1272 height=2800][url=${image}]${image}[/url][/img]`;
const quiet = { info() {}, warn() {}, error() {} };
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
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
