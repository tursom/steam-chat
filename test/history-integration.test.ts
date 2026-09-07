import { strict as assert } from 'node:assert';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { HistoryStorage, StorageStatus } from '../src/storage/history-storage';
import type { HistoryItem, HistoryRecordInput } from '../src/types';
const { createChatService } = require('../src/server/chat-service');
const { createSteamMessageLogger } = require('../src/steam/message-logger');
const { normalizeHistoryItem } = require('../src/storage/chat-log');
const account = '76561198000000001';
const peer = '76561198000000002';
const quiet = { info() {}, warn() {}, error() {} };

function fakeStorage() {
  const records: HistoryRecordInput[] = [];
  const queries: unknown[] = [];
  const listeners = new Set<(item: HistoryItem) => void>();
  const lane = { state: 'healthy', queued: 0, writable: true, durable: 0, missed: 0, lastError: 'private record' };
  const health: StorageStatus = { jsonl: { ...lane }, rocksdb: { ...lane } };
  let failAppend = false;
  const storage: HistoryStorage = {
    append(record) {
      if (failAppend) throw new Error('storage unavailable');
      records.push(record);
      const item = { ...normalizeHistoryItem(record), eventId: String(records.length) };
      for (const listener of listeners) listener(item);
      return item;
    },
    async history(query) { queries.push(query); return { items: records.map(normalizeHistoryItem), nextCursor: 'next' }; },
    async conversations(query) { queries.push(query); return { items: [], nextCursor: 'next' }; },
    status: () => health,
    canSend: () => health.jsonl.writable || health.rocksdb.writable,
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onStatus() { return () => {}; },
    async close() { listeners.clear(); }
  };
  return { storage, records, queries, health, fail() { failAppend = true; }, listeners };
}

async function fixture() {
  const fake = fakeStorage();
  let sends = 0;
  const steamUser = Object.assign(new EventEmitter(), {
    sendFriendMessage: async () => { sends++; return { ordinal: 7 }; }
  });
  const service = createChatService({ historyStorage: fake.storage, steamUser,
    steamCommunity: { sendImageToUser: async () => { sends++; return { url: 'https://example.test/image.png' }; } },
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} },
    chatConfig: { host: '127.0.0.1', port: 0, auth: { username: 'test', password: 'secret', trustProxy: true } }, logger: quiet });
  service.start();
  await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const headers = { 'X-Forwarded-For': '203.0.113.10', Authorization: `Basic ${Buffer.from('test:secret').toString('base64')}` };
  return { ...fake, service, steamUser, base, headers, sends: () => sends,
    request: (url: string, body?: unknown) => fetch(base + url, { headers,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }) };
}

test('injected HTTP history uses pages, legacy arrays, account checks and authenticated sanitized health', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + '/api/history/status', { headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 401);
    const health = await (await f.request('/api/history/status')).json();
    assert.equal(JSON.stringify(health).includes('private record'), false);
    assert.equal((await f.request('/api/history')).status, 400);
    assert.equal((await f.request(`/api/history?id=${peer}&steamAccountId=other`)).status, 403);
    assert.deepEqual(await (await f.request(`/api/history?id=${peer}&limit=3&before=cursor`)).json(), { items: [], nextCursor: 'next' });
    assert.deepEqual(f.queries[0], { steamAccountId: account, id: peer, limit: 3, before: 'cursor', after: undefined, at: undefined });
    assert.deepEqual(await (await f.request(`/history?id=${peer}`)).json(), []);
    assert.deepEqual(await (await f.request('/api/conversations')).json(), { items: [], nextCursor: 'next' });
    assert.deepEqual(await (await f.request('/conversations')).json(), []);
    f.storage.history = async () => { throw Object.assign(new Error('DB unavailable'), { statusCode: 503 }); };
    assert.equal((await f.request(`/history?id=${peer}`)).status, 503);
  } finally { await f.service.stop(); }
});

test('HTTP and WS text/image append; one failed lane allows sending, two block; append failure never resends', async () => {
  const f = await fixture();
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { headers: f.headers });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  try {
    await once(ws, 'open');
    f.health.rocksdb.writable = false;
    assert.equal((await f.request('/message', { id: peer, msg: 'http text' })).status, 200);
    assert.equal((await f.request('/image', { id: peer, img: 'YWJj' })).status, 200);
    for (const [type, body] of [['send_message', { msg: 'ws text' }], ['send_image', { img: 'YWJj' }]] as const) {
      ws.send(JSON.stringify({ type, id: peer, ...body }));
    }
    for (let i = 0; i < 100 && f.records.length < 4; i++) await delay(5);
    assert.equal(f.records.length, 4);
    assert.ok(f.records.every((record) => record.steamAccountId === account));
    assert.equal(f.records.filter((record) => record.message === 'https://example.test/image.png' && record.type === 'image').length, 2);
    await delay(20);
    assert.equal(messages.filter((message) => message.type === 'message' || message.type === 'image').length, 4);
    f.health.jsonl.writable = false;
    assert.equal((await f.request('/message', { id: peer, msg: 'blocked' })).status, 503);
    assert.equal(f.sends(), 4);
    f.health.jsonl.writable = true;
    f.fail();
    const response = await (await f.request('/message', { id: peer, msg: 'sent but not saved' })).json();
    assert.equal(response.ok, true);
    assert.deepEqual(response.item.persistence, { jsonl: 'failed', rocksdb: 'failed' });
    assert.equal(f.sends(), 5);
  } finally { ws.terminate(); await f.service.stop(); }
  assert.equal(f.listeners.size, 0);
});

test('shared logger is the only received/echo producer and WS pages use storage', async () => {
  const f = await fixture();
  const dispose = createSteamMessageLogger({ steamUser: f.steamUser, historyStorage: f.storage,
    getSteamAccountId: () => account, logger: quiet });
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { headers: f.headers });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  try {
    await once(ws, 'open');
    f.steamUser.emit('friendMessage', peer, 'received');
    f.steamUser.emit('friendMessageEcho', peer, 'echoed');
    await delay(30);
    assert.equal(f.records.length, 2);
    assert.equal(messages.filter((message) => message.type === 'message').length, 2);
    ws.send(JSON.stringify({ type: 'get_history_page', id: peer, requestId: 'page' }));
    for (let i = 0; i < 100 && !messages.some((message) => message.requestId === 'page'); i++) await delay(5);
    assert.equal(messages.find((message) => message.requestId === 'page')?.nextCursor, 'next');
  } finally { ws.terminate(); await f.service.stop(); await dispose.close(); }
});

test('account replacement during a login wait rejects before invoking the sender', async () => {
  const f = fakeStorage();
  let active = account;
  let sent = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const service = createChatService({ historyStorage: f.storage, logger: quiet,
    steamUser: { sendFriendMessage: async () => { sent++; return {}; } },
    waitForLogin: () => waiting,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: active }), ensureOnline() {} } });
  const sending = service.sendTextMessage(peer, 'must not use another account');
  const rejected = assert.rejects(sending, /account changed/);
  active = '76561198000000003';
  release();
  await rejected;
  assert.equal(sent, 0);
  assert.equal(f.records.length, 0);
  await service.stop();
});

test('send captures account and self name before awaits and stop drains the send', async () => {
  const f = fakeStorage();
  let active = account;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const service = createChatService({ historyStorage: f.storage, logger: quiet,
    steamUser: { sendFriendMessage: async () => { await waiting; return {}; } },
    getSelfName: async (id: string) => id,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: active }), ensureOnline() {} } });
  const sending = service.sendTextMessage(peer, 'delayed');
  await delay(0);
  active = '76561198000000003';
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await delay(0);
  assert.equal(stopped, false);
  release();
  await sending;
  await stopping;
  assert.equal(f.records[0].steamAccountId, account);
  assert.equal(f.records[0].name, account);
});

test('logger shutdown has a deadline when Steam history never responds', async () => {
  const f = fakeStorage();
  const steamUser = Object.assign(new EventEmitter(), { chat: { getFriendMessageHistory() {} } });
  const dispose = createSteamMessageLogger({ steamUser, historyStorage: f.storage,
    getSteamAccountId: () => account, logger: quiet });
  steamUser.emit('friendMessage', peer, 'live');
  await delay(10);
  const started = Date.now();
  await dispose.close(20);
  assert.ok(Date.now() - started < 500);
  assert.equal(f.records.length, 1);
});

test('logger persists realtime before history resolves and scopes imports and echoes to captured accounts', async () => {
  const f = fakeStorage();
  let active = account;
  const callbacks: Array<(error: unknown, result: unknown) => void> = [];
  const steamUser = Object.assign(new EventEmitter(), { chat: {
    getFriendMessageHistory(_id: string, _options: unknown, callback: (error: unknown, result: unknown) => void) { callbacks.push(callback); }
  } });
  const dispose = createSteamMessageLogger({ steamUser, historyStorage: f.storage,
    getSteamAccountId: () => active, getSelfName: async () => active,
    getUserInfo: async () => ({ player_name: 'Peer' }), logger: quiet });
  steamUser.emit('friendMessage', peer, 'live A');
  await delay(20);
  assert.equal(f.records.length, 1);
  active = '76561198000000003';
  steamUser.emit('friendMessage', peer, 'live B');
  steamUser.emit('friendMessageEcho', peer, 'echo');
  await delay(20);
  assert.equal(callbacks.length, 2);
  callbacks[0](null, { messages: [{ sender: account, message: 'old A' }] });
  callbacks[1](null, { messages: [] });
  await dispose.close();
  assert.equal(f.records.find((record) => record.message === 'old A')?.steamAccountId, account);
  assert.equal(f.records.find((record) => record.message === 'old A')?.name, account);
  assert.equal(f.records.find((record) => record.message === 'live A')?.steamAccountId, account);
  assert.equal(f.records.find((record) => record.message === 'echo')?.steamAccountId, active);
});
