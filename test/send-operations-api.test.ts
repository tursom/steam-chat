import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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
async function fixture(t: TestContext, requestHook: (phase: string, reply: Reply) => boolean = () => false, config = {}) {
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
    imageEmoteDir: join(dir, 'emotes'), chatConfig: { host: '127.0.0.1', port: 0 },
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
  t.after(async () => { await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); });
  return { request, prepare, status, calls, saved, auth, user, admin, active, second, sessions, cookie, adminCookie, setOnline: (value: boolean) => { online = value; } };
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
