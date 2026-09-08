import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { WebSocket } from 'ws';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const account = '76561198000000001';
const other = '76561198000000002';
const quiet = { info() {}, warn() {}, error() {} };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'send-account-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const sessions = createSessionManager({ store: auth });
  const cookie = sessions.createSetCookie(admin).split(';')[0];
  let active = account;
  const textSends: string[] = [];
  const imageSends: string[] = [];
  const service = createChatService({ authStore: auth, sessionManager: sessions,
    logPath: join(dir, 'chat.jsonl'), chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: active }), ensureOnline() {} },
    steamUser: { sendFriendMessage: async () => { textSends.push(active); return {}; } },
    steamCommunity: { sendImageToUser: async () => { imageSends.push(active); return 'https://example.com/image.png'; } },
    ...options });
  service.start();
  await once(service.server, 'listening');
  t.after(async () => { await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = (path: string, body?: unknown) => fetch(base + path, {
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { service, base, cookie, request, textSends, imageSends, switchAccount: () => { active = other; } };
}

for (const endpoint of ['/message', '/', '/image', '/img']) {
  test(`${endpoint}: optional account rejects mismatches and malformed values without sending`, async (t) => {
    let downloads = 0;
    const f = await fixture(t, { fetchImpl: async () => { downloads++; throw new Error('unexpected download'); } });
    const body = { id: other, msg: 'hello', img: 'YWJj', url: 'https://images.steamusercontent.com/test.png' };
    assert.equal((await f.request(endpoint, { ...body, steamAccountId: other })).status, 409);
    for (const steamAccountId of [null, '', 76561198000000001, {}, [], true, 'bad', ' ' + account]) {
      assert.equal((await f.request(endpoint, { ...body, steamAccountId })).status, 400);
    }
    assert.deepEqual(f.textSends, []);
    assert.deepEqual(f.imageSends, []);
    assert.equal(downloads, 0);
    assert.equal((await f.request(endpoint, { ...body, steamAccountId: account })).status, 200);
    assert.equal((await f.request(endpoint, body)).status, 200);
    assert.equal(f.textSends.length + f.imageSends.length, 2);
  });
}

for (const field of [false, true]) {
  test(`text: account switch during login wait, precondition ${field}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    t.after(release.resolve);
    const f = await fixture(t, { waitForLogin: () => { entered.resolve(); return release.promise; } });
    const response = f.request('/message', { id: other, msg: 'hello', ...(field ? { steamAccountId: account } : {}) });
    await entered.promise;
    f.switchAccount();
    release.resolve();
    assert.equal((await response).status, 409);
    assert.deepEqual(f.textSends, []);
  });
}

for (const wait of ['download', 'web-session', 'refresh']) {
  test(`image: account switch during ${wait} prevents sending or retrying on new account`, async (t) => {
    const entered = deferred();
    const release = deferred();
    t.after(release.resolve);
    let attempts = 0;
    const pause = () => { entered.resolve(); return release.promise; };
    const f = await fixture(t, {
      fetchImpl: async () => { await pause(); return new Response('abc', { headers: { 'Content-Type': 'image/png' } }); },
      waitForWebSession: wait === 'web-session' ? pause : undefined,
      refreshWebSession: pause,
      steamCommunity: { sendImageToUser: async () => {
        attempts++;
        if (wait === 'refresh') throw new Error('Session expired');
        return 'https://example.com/image.png';
      } }
    });
    const response = f.request('/image', { id: other, steamAccountId: account,
      ...(wait === 'download' ? { url: `https://images.steamusercontent.com/${crypto.randomUUID()}.png` } : { img: 'YWJj' }) });
    await entered.promise;
    f.switchAccount();
    release.resolve();
    assert.equal((await response).status, 409);
    assert.equal(attempts, wait === 'refresh' ? 1 : 0);
  });
}

for (const endpoint of ['/message', '/image']) {
  test(`${endpoint}: account switch while reading body is rejected`, async (t) => {
    const f = await fixture(t);
    const received = deferred();
    f.service.server.once('request', (req: import('node:http').IncomingMessage) => req.once('data', received.resolve));
    const incoming = once(f.service.server, 'request');
    const req = httpRequest(f.base + endpoint, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' } });
    const response = once(req, 'response');
    req.flushHeaders();
    await incoming;
    await setImmediate();
    req.write('{"id":"42",');
    await received.promise;
    await setImmediate();
    f.switchAccount();
    req.end(`"msg":"hello","img":"YWJj","steamAccountId":"${account}"}`);
    const [res] = await response;
    res.resume();
    assert.equal(res.statusCode, 409);
    assert.deepEqual(f.textSends, []);
    assert.deepEqual(f.imageSends, []);
  });
}

test('WebSocket sends honor optional account without changing omitted-field behavior', async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: f.cookie } });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  const request = (payload: object) => new Promise<any>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.requestId === 'test') { ws.off('message', listener); resolve(message); }
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ ...payload, requestId: 'test' }));
  });
  for (const type of ['send_message', 'send_image']) {
    const body = { type, id: other, msg: 'hello', img: 'YWJj' };
    assert.equal((await request({ ...body, steamAccountId: other })).statusCode, 409);
    assert.equal((await request({ ...body, steamAccountId: null })).statusCode, 400);
    assert.equal(f.textSends.length + f.imageSends.length, type === 'send_message' ? 0 : 2);
    assert.equal((await request({ ...body, steamAccountId: account })).type, type === 'send_message' ? 'message_sent' : 'image_sent');
    assert.equal((await request(body)).type, type === 'send_message' ? 'message_sent' : 'image_sent');
  }
});

test('sync validates optional account before I/O and rechecks account after I/O', async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  let reads = 0;
  const f = await fixture(t, { historyStorage: { onMessage: () => () => {}, onDurable: () => () => {},
    sync: async ({ steamAccountId }: { steamAccountId: string }) => {
    reads++;
    entered.resolve();
    await release.promise;
    return { steamAccountId, items: new Array<never>(), nextCursor: 'cursor', hasMore: false };
  } } });
  assert.equal((await f.request(`/api/messages/sync?steamAccountId=${other}`)).status, 403);
  for (const value of ['', 'bad']) assert.equal((await f.request(`/api/messages/sync?steamAccountId=${value}`)).status, 400);
  assert.equal(reads, 0);
  const response = f.request(`/api/messages/sync?steamAccountId=${account}`);
  await entered.promise;
  f.switchAccount();
  release.resolve();
  const result = await response;
  assert.equal(result.status, 403);
  assert.equal((await result.json()).items, undefined);
  assert.equal((await f.request(`/api/messages/sync?steamAccountId=${other}`)).status, 200);
  assert.equal((await f.request('/api/messages/sync')).status, 200);
});
