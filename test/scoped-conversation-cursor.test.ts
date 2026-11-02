import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { HistoryStorage } from '../src/storage/history-storage';
import WebSocket from 'ws';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');

test('scoped conversation cursors hide excluded peers and round-trip with user binding over HTTP and WS', async t => {
  const store = createAuthStore({ dbPath: ':memory:' });
  const admin = store.createInitialAdmin({ username: 'root', password: 'password123' });
  const reader = store.createUser({ username: 'reader', password: 'password123' }, admin.id);
  const other = store.createUser({ username: 'other', password: 'password123' }, admin.id);
  const steamId = '76561198000000000', excluded = '76561198040000002';
  const account = store.upsertSteamAccount({ steamId, setActive: true });
  for (const user of [reader, other]) store.replaceUserSteamGrants(user.id, [{ steamAccountId: account.id, level: 'read', scope: 'some', peers: [] }], admin.id);
  const sessions = createSessionManager({ store });
  const cookie = sessions.createSetCookie(reader).split(';')[0], otherCookie = sessions.createSetCookie(other).split(';')[0];
  const rawCursor = Buffer.from(`index:${excluded}:2026-10-26T10:00:00Z`).toString('base64url');
  const inputs: Array<string | undefined> = [];
  const storage = {
    async conversations(input: { before?: string }): Promise<{ items: { id: string }[]; nextCursor?: string }> { inputs.push(input.before); return input.before ? { items: [] } : { items: [{ id: excluded }], nextCursor: rawCursor }; },
    onMessage() { return () => {}; }, onDurable() { return () => {}; }, canSend: () => true,
    status() { return { jsonl: { state: 'healthy' }, rocksdb: { state: 'healthy' } }; }
  } as unknown as HistoryStorage;
  const service = createChatService({ config: { host: '127.0.0.1', port: 0, wsPath: '/ws', wsHeartbeatMs: 0 }, authStore: store, sessionManager: sessions,
    historyStorage: storage, steamLoginService: { getStatus: () => ({ status: 'online', steamId }) }, logger: { info() {}, warn() {}, error() {} } });
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  t.after(async () => { await service.stop(); store.close(); });
  const request = (cursor?: string, auth = cookie) => fetch(`${base}/api/conversations${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`, { headers: { Cookie: auth } });
  const first = await (await request()).json();
  assert.deepEqual(first.items, []);
  assert.match(first.nextCursor, /^sc1\./);
  assert.notEqual(first.nextCursor, rawCursor);
  assert.equal(Buffer.from(first.nextCursor.slice(4), 'base64url').includes(Buffer.from(excluded)), false);
  assert.equal((await request(first.nextCursor)).status, 200);
  assert.equal(inputs.at(-1), rawCursor);
  assert.equal((await request(first.nextCursor, otherCookie)).status, 400);
  const bytes = Buffer.from(first.nextCursor.slice(4), 'base64url'); bytes[bytes.length - 1] ^= 1;
  assert.equal((await request(`sc1.${bytes.toString('base64url')}`)).status, 400);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  t.after(() => ws.terminate());
  const next = () => new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS timeout')), 3000);
    ws.once('message', data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())); });
  });
  await next();
  let response = next(); ws.send(JSON.stringify({ type: 'get_conversations_page' }));
  const page = await response;
  assert.deepEqual(page.items, []); assert.match(page.nextCursor, /^sc1\./);
  response = next(); ws.send(JSON.stringify({ type: 'get_conversations_page', before: page.nextCursor }));
  assert.deepEqual((await response).items, []); assert.equal(inputs.at(-1), rawCursor);
});
