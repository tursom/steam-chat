import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const SteamCommunity = require('steamcommunity');
const account = '76561198000000001', peer = '76561198000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function until(check: () => Promise<boolean> | boolean) {
  for (let n = 0; n < 500; n++) { if (await check()) return; await delay(10); } assert.fail('Timed out');
}
type Reply = (error: unknown, response?: unknown, body?: unknown) => void;
async function fixture(t: TestContext, requestHook: (phase: string, reply: Reply) => boolean = () => false, config = {},
  options: { fetchImpl?: typeof fetch; wsPath?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'send-operation-api-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = auth.createUser({ username: 'reader', password: 'password123', role: 'user' });
  const active = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const second = auth.upsertSteamAccount({ steamId: '76561198000000003' });
  auth.replaceUserSteamAccounts(user.id, [active.id, second.id], admin.id);
  const sessions = createSessionManager({ store: auth });
  const cookie = sessions.createSetCookie(user).split(';')[0], adminCookie = sessions.createSetCookie(admin).split(';')[0];
  const community = new SteamCommunity(); community.getSessionID = () => 'fixture';
  const calls: string[] = [], saved: any[] = [];
  let online = true;
  community.request = (options: { uri: string }, reply: Reply) => {
    const phase = options.uri.includes('beginfileupload') ? 'begin' : options.uri.includes('commitfileupload') ? 'commit' : 'upload';
    calls.push(phase); if (requestHook(phase, reply)) return;
    reply(null, { statusCode: 200, headers: {} }, phase === 'begin' ? { success: 1, hmac: 'secret', timestamp: 1,
      result: { ugcid: '1', url_host: 'upload.invalid', url_path: '/private', request_headers: [], use_https: true } }
      : phase === 'commit' ? { success: 1, result: { success: 1, details: { url: 'https://images.steamusercontent.com/image.png' } } } : '');
  };
  const service = createChatService({ authStore: auth, sessionManager: sessions, steamCommunity: community,
    imageEmoteDir: join(dir, 'emotes'), fetchImpl: options.fetchImpl, chatConfig: { host: '127.0.0.1', port: 0, wsPath: options.wsPath },
    steamLoginService: { getStatus: () => ({ status: online ? 'online' : 'reconnecting', steamId: auth.getActiveSteamAccount(false)?.steamId }), ensureOnline() {} },
    sendOperationOptions: { tickMs: 3, windowMs: 2000, delaysMs: [20, 30, 40, 50, 60], random: () => 0.5, ...config },
    historyStorage: { canSend: () => true, append(item: object) { const result = { ...item, eventId: `record-${saved.length}` }; saved.push(result); return result; },
      onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {} },
    logger: { info() {}, warn() {}, error() {} } });
  service.start(); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = (path: string, body?: unknown, session = cookie) => fetch(base + path, {
    headers: session ? { Cookie: session } : {}, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const prepare = async () => (await (await request('/api/send-operations', { kind: 'image', id: peer, steamAccountId: account })).json());
  const status = async (id: string) => (await request(`/api/send-operations/${id}`)).json();
  const upload = (operationId: string, extra: object = {}, session = cookie) => request('/api/send-operations/upload', {
    operationId, kind: 'image', id: peer, steamAccountId: account, name: 'photo.png', img: png.toString('base64'), ...extra
  }, session);
  t.after(async () => { await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); });
  return { request, prepare, status, upload, base, calls, saved, auth, user, admin, active, second, sessions, cookie, adminCookie, setOnline: (value: boolean) => { online = value; } };
}

function remoteUrl(t: TestContext) {
  const url = `https://images.example.test/${randomBytes(16).toString('hex')}.png`;
  const { IMAGE_CACHE_DIR, cacheKeyForUrl } = require('../src/storage/media-cache');
  t.after(() => Promise.all(['bin', 'json'].map(ext => rm(join(IMAGE_CACHE_DIR, `${cacheKeyForUrl(url)}.${ext}`), { force: true }))));
  return url;
}

test('session-only tasks bind owner/session/account, and old IDs never activate', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/send-operations', {}, '')).status, 401);
  assert.equal((await f.request('/api/config')).status, 200);
  assert.equal((await (await f.request('/api/config')).json()).sendOperations, true);
  const op = await f.prepare(); assert.equal(op.state, 'prepared'); assert.equal(f.calls.length, 0);
  assert.equal((await f.request(`/api/send-operations/${op.id}`, undefined, f.adminCookie)).status, 403);
  const anotherSession = f.sessions.createSetCookie(f.user).split(';')[0];
  assert.equal((await f.request(`/api/send-operations/${op.id}`, undefined, anotherSession)).status, 403);
  assert.equal((await f.request(`/api/send-operations/${'0'.repeat(32)}/start`, { img: png.toString('base64') })).status, 410);
  assert.equal((await f.request(`/api/send-operations/${op.id}/start`, { img: 'not an image' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('actual installed SDK retries twice, duplicate activation is idempotent and persists one result', async t => {
  let failures = 0;
  const f = await fixture(t, (phase, reply) => {
    if (phase !== 'begin' || failures++ >= 2) return false;
    reply(null, { statusCode: 500, headers: {} }, { success: 16, message: 'A server error occurred. (16)' }); return true;
  });
  const op = await f.prepare(), body = { img: png.toString('base64') };
  const responses = await Promise.all([f.request(`/api/send-operations/${op.id}/start`, body), f.request(`/api/send-operations/${op.id}/start`, body)]);
  assert.ok(responses.every(response => response.status === 202));
  await until(async () => (await f.status(op.id)).state === 'sent');
  assert.equal(f.calls.filter(phase => phase === 'begin').length, 3);
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 1); assert.equal(f.saved.length, 1);
  assert.equal((await f.request(`/api/send-operations/${op.id}/start`, body)).status, 202);
  assert.equal((await f.request(`/api/send-operations/${op.id}/start`, { img: Buffer.concat([png, Buffer.from('changed')]).toString('base64') })).status, 409);
  assert.equal(f.saved.length, 1);
  assert.equal((await f.request(`/api/send-operations/${op.id}/image`)).status, 410);
});

test('commit timeout is unknown and cannot use retry, while raw original remains privately readable', async t => {
  const f = await fixture(t, (phase, reply) => { if (phase !== 'commit') return false;
    reply(null, { statusCode: 200, headers: {} }, { success: 16 }); return true; });
  const op = await f.prepare(); await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') });
  await until(async () => (await f.status(op.id)).state === 'unknown');
  const view = await f.status(op.id);
  assert.equal((await f.request(`/api/send-operations/${op.id}/retry`, { expectedVersion: view.version })).status, 409);
  const preview = await f.request(`/api/send-operations/${op.id}/image`);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.equal(preview.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  assert.equal((await f.request(`/api/send-operations/${op.id}/image`, undefined, f.adminCookie)).status, 403);
  await f.request(`/api/send-operations/${op.id}/cancel`, {}); assert.equal((await f.status(op.id)).state, 'unknown');
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 1); assert.equal(f.saved.length, 0);
});

test('switching account during PUT blocks the original attempt from committing', async t => {
  let upload: Reply | undefined;
  const f = await fixture(t, (phase, reply) => { if (phase !== 'upload') return false; upload = reply; return true; });
  const op = await f.prepare(); await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') });
  await until(() => Boolean(upload)); f.auth.setActiveSteamAccount(f.second.id);
  upload!(null, { statusCode: 200, headers: {} }, ''); await delay(20);
  assert.equal(f.calls.includes('commit'), false); f.auth.setActiveSteamAccount(f.active.id);
  const view = await f.status(op.id); assert.equal(view.state, 'failed'); assert.equal(view.retryable, false); assert.equal(f.saved.length, 0);
});

test('revoking permissions during backoff prevents further SDK calls', async t => {
  const f = await fixture(t, (phase, reply) => { if (phase !== 'begin') return false;
    reply(null, { statusCode: 200, headers: {} }, { success: 16 }); return true; }, { delaysMs: [200] });
  const op = await f.prepare(); await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') });
  await until(async () => (await f.status(op.id)).state === 'retry_wait');
  f.auth.replaceUserSteamAccounts(f.user.id, [], f.admin.id); await delay(250);
  assert.equal(f.calls.length, 1); assert.equal((await f.request(`/api/send-operations/${op.id}`)).status, 403); assert.equal(f.saved.length, 0);
});

test('deadline abort before begin response prevents its late reply from uploading or committing', async t => {
  let begin: Reply | undefined;
  const f = await fixture(t, (phase, reply) => { if (phase !== 'begin') return false; begin = reply; return true; }, { windowMs: 80 });
  const op = await f.prepare(); await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') });
  await until(() => Boolean(begin)); await until(async () => (await f.status(op.id)).state === 'failed');
  begin!(null, { statusCode: 200, headers: {} }, { success: 1, hmac: 'x', timestamp: 1,
    result: { ugcid: '1', url_host: 'upload.invalid', url_path: '/late', use_https: true, request_headers: [] } });
  await delay(20); assert.deepEqual(f.calls, ['begin']); assert.equal(f.saved.length, 0);
});

test('HTTP 429 preserves Retry-After and blocks immediate retry without replaying the request', async t => {
  const f = await fixture(t, (phase, reply) => { if (phase !== 'begin') return false;
    reply(null, { statusCode: 429, headers: { 'retry-after': '45' } }, {}); return true; });
  const op = await f.prepare(); await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') });
  await until(async () => (await f.status(op.id)).state === 'retry_wait');
  const view = await f.status(op.id); assert.ok(view.cooldownUntil > Date.now() + 44000);
  assert.equal((await f.request(`/api/send-operations/${op.id}/expedite`, { expectedVersion: view.version })).status, 429);
  assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 0);
});

test('offline cannot create a new task, but an already accepted task waits for reconnection', async t => {
  const f = await fixture(t); const op = await f.prepare(); f.setOnline(false);
  assert.equal((await f.request('/api/send-operations', { kind: 'image', id: peer, steamAccountId: account })).status, 503);
  assert.equal((await f.request(`/api/send-operations/${op.id}/start`, { img: png.toString('base64') })).status, 202);
  await until(async () => (await f.status(op.id)).state === 'waiting_connection');
  assert.equal(f.calls.length, 0); assert.equal((await f.status(op.id)).attempts, 0);
  f.setOnline(true); await until(async () => (await f.status(op.id)).state === 'sent');
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 1);
});

test('auth/me includes Steam status and the same supported config as api/config, even before login', async t => {
  const f = await fixture(t, undefined, {}, { wsPath: '/custom-ws' });
  const response = await f.request('/api/config');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const config = await response.json();
  assert.deepEqual(config, { wsPath: '/custom-ws', sendOperations: true, imageOperationUpload: true });
  for (const cookie of [f.cookie, '']) {
    const response = await f.request('/api/auth/me', undefined, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const me = await response.json();
    assert.deepEqual(me.config, config);
    assert.equal(me.steam.status, 'online');
    assert.equal(me.steam.accessAllowed, Boolean(cookie));
    assert.equal(me.user?.id ?? null, cookie ? f.user.id : null);
  }
  f.setOnline(false);
  const me = await (await f.request('/api/auth/me')).json();
  assert.equal(me.steam.status, 'reconnecting');
  assert.deepEqual(me.config, config, 'capability does not depend on transient Steam status');
});

test('one-request upload concurrently accepts one client ID and persists exactly one send', async t => {
  const f = await fixture(t);
  const id = 'a'.repeat(32);
  const responses = await Promise.all([f.upload(id), f.upload(id), f.upload(id)]);
  for (const response of responses) {
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).id, id);
  }
  await until(async () => (await f.status(id)).state === 'sent');
  const replay = await f.upload(id);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).state, 'sent');
  assert.equal((await f.upload(id, { img: Buffer.concat([png, Buffer.from('changed')]).toString('base64') })).status, 409);
  assert.equal((await f.request(`/api/send-operations/${id}/start`, { img: png.toString('base64') })).status, 202);
  assert.deepEqual(f.calls, ['begin', 'upload', 'commit']);
  assert.equal(f.saved.length, 1);
  const legacy = await f.prepare();
  assert.equal((await f.upload(legacy.id, { name: '图片' })).status, 202, 'new entry can activate a compatible prepared task');
  await until(async () => (await f.status(legacy.id)).state === 'sent');
  assert.equal(f.saved.length, 2);
});

test('concurrent different images or recipients sharing an ID produce one winner and one conflict', async t => {
  const f = await fixture(t);
  const id = 'a'.repeat(32);
  const responses = await Promise.all([f.upload(id), f.upload(id, { img: Buffer.concat([png, Buffer.from('other')]).toString('base64') })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  await until(async () => (await f.status(id)).state === 'sent');
  const secondId = 'b'.repeat(32);
  const recipients = await Promise.all([f.upload(secondId), f.upload(secondId, { id: account })]);
  assert.deepEqual(recipients.map(response => response.status).sort(), [202, 409]);
  const accepted = await recipients.find(response => response.status === 202)!.json();
  await until(async () => (await f.status(secondId)).state === 'sent');
  assert.equal(f.saved[1].id, accepted.peerId);
  assert.equal(f.saved.length, 2);
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 2);
});

test('one-request upload validates IDs, metadata, image sources, permissions and budgets', async t => {
  const f = await fixture(t, undefined, { maxBytes: png.length - 1 });
  const id = 'a'.repeat(32);
  assert.equal((await f.upload(id, {}, '')).status, 401);
  for (const operationId of [undefined, null, 123, '', 'A'.repeat(32), 'a'.repeat(31), 'g'.repeat(32), 'a'.repeat(33)]) {
    assert.equal((await f.upload(operationId as string)).status, 400);
  }
  const invalidMetadata: object[] = [{ kind: 'text' }, { id: '42' }, { previousOperationId: '' }, { steamAccountId: null }];
  for (const extra of invalidMetadata) {
    assert.equal((await f.upload(id, extra)).status, 400);
  }
  assert.equal((await f.upload(id, { steamAccountId: f.second.steamId })).status, 409);
  assert.equal((await f.request(`/api/send-operations/${id}`)).status, 410);
  const invalidSources: object[] = [{ img: undefined }, { img: null }, { img: 'not an image' }, { url: 'https://images.example.test/a.png' }, { emoteId: null }];
  for (const extra of invalidSources) {
    assert.equal((await f.upload(id, extra)).status, 400);
  }
  assert.equal((await f.status(id)).state, 'prepared', 'invalid image never queues the reserved ID');
  assert.equal((await f.upload(id)).status, 429);
  assert.equal((await f.status(id)).state, 'prepared');
  assert.equal((await f.upload(id, { name: 'other' })).status, 409);
  assert.equal((await f.upload(id, { previousOperationId: 'f'.repeat(32) })).status, 409);
  assert.equal((await f.upload(id, {}, f.adminCookie)).status, 403);
  const anotherSession = f.sessions.createSetCookie(f.user).split(';')[0];
  assert.equal((await f.upload(id, {}, anotherSession)).status, 403);
  f.auth.setActiveSteamAccount(f.second.id);
  assert.equal((await f.upload(id, { steamAccountId: f.second.steamId })).status, 403);
  f.auth.setActiveSteamAccount(f.active.id);
  f.auth.replaceUserSteamAccounts(f.user.id, [], f.admin.id);
  assert.equal((await f.upload('b'.repeat(32))).status, 403);
  assert.equal(f.calls.length, 0);
});

test('upload shares stored-emote and remote-image parsing with the two-stage entry', async t => {
  let downloads = 0;
  const f = await fixture(t, undefined, {}, { fetchImpl: async () => { downloads++; return new Response(png); } });
  const group = await (await f.request('/api/image-emotes', { version: 0, action: 'createGroup', name: 'Images' }, f.adminCookie)).json();
  const library = await (await f.request('/api/image-emotes', { version: 1, action: 'addImage', groupId: group.groups[0].id,
    name: 'Photo', data: `data:image/png;base64,${png.toString('base64')}` }, f.adminCookie)).json();
  const id = 'a'.repeat(32);
  assert.equal((await f.upload(id, { img: undefined, emoteId: library.images[0].id })).status, 202);
  await until(async () => (await f.status(id)).state === 'sent');
  assert.equal((await f.upload(id)).status, 202, 'idempotency compares image bytes, not source encoding');
  const url = remoteUrl(t), secondId = 'b'.repeat(32);
  assert.equal((await f.upload(secondId, { img: undefined, url })).status, 202);
  await until(async () => (await f.status(secondId)).state === 'sent');
  assert.equal((await f.upload(secondId)).status, 202);
  assert.equal(downloads, 1);
  assert.equal(f.saved.length, 2);
});

test('pending remote upload is queryable and rechecks account, grant and session before starting', async t => {
  for (const change of ['account', 'grant', 'session']) await t.test(change, async t => {
    let finish!: (response: Response) => void;
    const f = await fixture(t, undefined, {}, { fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    const id = 'a'.repeat(32), url = remoteUrl(t);
    const response = f.upload(id, { img: undefined, url });
    await until(() => Boolean(finish));
    assert.equal((await f.status(id)).state, 'prepared');
    if (change === 'account') f.auth.setActiveSteamAccount(f.second.id);
    else if (change === 'grant') f.auth.replaceUserSteamAccounts(f.user.id, [], f.admin.id);
    else f.sessions.revokeUserSessions(f.user.id, f.admin.id);
    finish(new Response(png));
    assert.equal((await response).status, change === 'account' ? 409 : change === 'grant' ? 403 : 401);
    if (change === 'account') {
      f.auth.setActiveSteamAccount(f.active.id);
      assert.equal((await f.status(id)).state, 'prepared');
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.saved.length, 0);
  });
});

test('HTTP timeout can be reconciled with GET without resubmitting an accepted upload', async t => {
  let finish!: (response: Response) => void;
  const f = await fixture(t, undefined, {}, { fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const id = 'a'.repeat(32), url = remoteUrl(t);
  const controller = new AbortController();
  const request = fetch(f.base + '/api/send-operations/upload', { method: 'POST', headers: { Cookie: f.cookie }, signal: controller.signal,
    body: JSON.stringify({ operationId: id, kind: 'image', id: peer, steamAccountId: account, url }) });
  const aborted = assert.rejects(request, (error: any) => error.name === 'AbortError');
  await until(() => Boolean(finish));
  controller.abort(); await aborted;
  assert.equal((await f.status(id)).state, 'prepared');
  finish(new Response(png));
  await until(async () => (await f.status(id)).state === 'sent');
  assert.equal(f.saved.length, 1);
  assert.equal((await f.request(`/api/send-operations/${'f'.repeat(32)}`)).status, 410);
  assert.equal((await f.request(`/api/send-operations/${'f'.repeat(32)}/start`, { img: png.toString('base64') })).status, 410);
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 1);
});

test('one-request replacement is explicit, idempotent, and conflicts with another replacement ID', async t => {
  const f = await fixture(t, (phase, reply) => {
    if (phase !== 'commit') return false;
    reply(null, { statusCode: 200, headers: {} }, { success: 16 }); return true;
  });
  const parent = 'a'.repeat(32), child = 'b'.repeat(32);
  assert.equal((await f.upload(parent)).status, 202);
  await until(async () => (await f.status(parent)).state === 'unknown');
  assert.equal((await f.upload(parent)).status, 202, 'replaying unknown does not start a new attempt');
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 1);
  const responses = await Promise.all([f.upload(child, { previousOperationId: parent }), f.upload(child, { previousOperationId: parent })]);
  assert.ok(responses.every(response => response.status === 202));
  await until(async () => (await f.status(child)).state === 'unknown');
  assert.equal((await f.status(parent)).replacementId, child);
  assert.equal((await f.status(child)).previousOperationId, parent);
  assert.equal((await f.upload('c'.repeat(32), { previousOperationId: parent })).status, 409);
  assert.equal((await f.upload(child)).status, 409);
  assert.equal((await f.upload(child, { previousOperationId: parent, img: Buffer.concat([png, Buffer.from('changed')]).toString('base64') })).status, 409);
  assert.equal((await f.request(`/api/send-operations/${child}/retry`, { expectedVersion: (await f.status(child)).version })).status, 409);
  assert.equal(f.calls.filter(phase => phase === 'commit').length, 2);
  assert.equal(f.saved.length, 0);
});

test('late image parsing in either entry cannot activate an expired and reused operation ID', async t => {
  for (const entry of ['upload', 'start']) await t.test(entry, async t => {
    let finish!: (response: Response) => void;
    const f = await fixture(t, undefined, { preparedMs: 100 }, { fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    const id = entry === 'upload' ? 'a'.repeat(32) : (await f.prepare()).id;
    const url = remoteUrl(t);
    const pending = entry === 'upload' ? f.upload(id, { img: undefined, url }) : f.request(`/api/send-operations/${id}/start`, { url });
    await until(() => Boolean(finish));
    await until(async () => (await f.request(`/api/send-operations/${id}`)).status === 410);
    assert.equal((await f.upload(id, { id: account })).status, 202);
    finish(new Response(png));
    assert.equal((await pending).status, 410, 'the late loader must not attach its image to the new operation');
    await until(async () => (await f.status(id)).state === 'sent');
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].id, account);
    assert.equal(f.calls.filter(phase => phase === 'commit').length, 1);
  });
});

test('accepted upload survives going offline, while cancel and replay cannot revive it', async t => {
  let finish!: (response: Response) => void;
  const f = await fixture(t, undefined, {}, { fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const id = 'a'.repeat(32), url = remoteUrl(t);
  const pending = f.upload(id, { img: undefined, url });
  await until(() => Boolean(finish));
  f.setOnline(false);
  finish(new Response(png));
  assert.equal((await pending).status, 202);
  await until(async () => (await f.status(id)).state === 'waiting_connection');
  assert.equal((await f.status(id)).attempts, 0);
  assert.equal((await f.upload('b'.repeat(32))).status, 503);
  assert.equal((await f.request(`/api/send-operations/${id}/cancel`, {})).status, 200);
  f.setOnline(true);
  const replay = await f.upload(id);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).state, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.length, 0);
});
