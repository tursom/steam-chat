import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import { SteamInventoryCache, type SteamInventory } from '../src/server/steam-inventory-cache';

const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const A = '76561198000000001';
const B = '76561198000000002';
const empty: SteamInventory = { emoticons: [], stickers: [], effects: [] };
const items = (name: string): SteamInventory => ({ emoticons: [{ name }], stickers: [{ name: 'sticker' }], effects: [{ name: 'effect' }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: { seed?: boolean; legacy?: boolean; loader?: (options: { previousInventory?: SteamInventory }) => Promise<Partial<SteamInventory>> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'backend-inventory-'));
  const inventoryCacheDir = join(dir, 'inventory');
  const store = createAuthStore({ dbPath: join(dir, 'auth.db') });
  const root = store.createInitialAdmin({ username: 'root', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123' }, root.id);
  const a = store.upsertSteamAccount({ steamId: A, setActive: true });
  const b = store.upsertSteamAccount({ steamId: B });
  const sessions = createSessionManager({ store });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  store.replaceUserSteamGrants(user.id, [a, b].map(account => ({ steamAccountId: account.id, level: 'read', scope: 'all', peers: [] as string[], expiresAt: null as string | null })), root.id);
  if (options.seed) {
    const seed = new SteamInventoryCache({ dir: inventoryCacheDir, now: () => Date.now() - 700_000 });
    await seed.get(A, async () => items('saved-A'));
    await seed.get(B, async () => items('saved-B'));
    await seed.close();
  }
  const status: { status: string; steamId: string | null } = { status: 'online', steamId: options.legacy ? null : A };
  const steamUser = Object.assign(new EventEmitter(), { steamID: options.legacy ? undefined : A });
  const steamCommunity: { steamID?: string } = {};
  let calls = 0;
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws', wsHeartbeatMs: 0 },
    authStore: options.legacy ? undefined : store, sessionManager: options.legacy ? undefined : sessions,
    steamUser, steamCommunity, inventoryCacheDir, logPath: join(dir, 'chat.jsonl'), imageEmoteDir: join(dir, 'emotes'),
    getEmoticons: async (input: { previousInventory?: SteamInventory }) => { calls++; return options.loader ? options.loader(input) : items('fresh'); },
    steamLoginService: { getStatus: () => status, ensureOnline() {
      if (status.status !== 'online') throw Object.assign(new Error('Steam offline'), { statusCode: 503 });
    } }, logger: { info() {}, warn() {}, error() {} }
  });
  await new Promise<void>(resolve => (service.server as Server).listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await service.stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (endpoint = '/api/emoticons', init: RequestInit = {}) => fetch(base + endpoint, { ...init, headers: { Cookie: cookie, ...init.headers } });
  async function socket() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
    sockets.push(ws);
    const queue: Record<string, unknown>[] = [];
    let waiting: ((value: Record<string, unknown>) => void) | undefined;
    ws.on('message', raw => { const data = JSON.parse(raw.toString()); if (waiting) { const resolve = waiting; waiting = undefined; resolve(data); } else queue.push(data); });
    ws.on('close', () => { if (waiting) { const resolve = waiting; waiting = undefined; resolve({ type: 'closed' }); } });
    async function next() {
      if (queue.length) return queue.shift()!;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS timed out')), 2000);
        waiting = value => { clearTimeout(timer); resolve(value); };
      });
    }
    assert.equal((await next()).type, 'ready');
    return { async request() { ws.send(JSON.stringify({ type: 'get_emoticons', requestId: 'inventory' })); return next(); } };
  }
  function switchAccount() { status.steamId = B; steamUser.steamID = B; store.setActiveSteamAccount(b.id); }
  function revoke() { store.replaceUserSteamGrants(user.id, [], root.id); }
  return { request, socket, status, steamUser, steamCommunity, calls: () => calls, switchAccount, revoke, service, inventoryCacheDir, store, user, root, a, sessions };
}

test('HTTP and WS immediately share saved inventory and coalesce the background refresh', async t => {
  const upstream = deferred<SteamInventory>();
  const f = await fixture(t, { seed: true, loader: () => upstream.promise });
  const ws = await f.socket();
  const [http, socket] = await Promise.all([f.request(), ws.request()]);
  assert.equal(http.status, 200);
  assert.equal(http.headers.get('cache-control'), 'no-store');
  const body = await http.json();
  assert.deepEqual(body.emoticons, [{ name: 'saved-A' }]);
  assert.deepEqual(socket.emoticons, body.emoticons);
  assert.deepEqual(socket.cache, body.cache);
  assert.equal(body.cache.refreshing, true);
  assert.equal(body.cache.stale, true);
  assert.equal(f.calls(), 1);
  upstream.resolve(items('updated'));
  for (let i = 0; i < 100; i++) {
    const current = await (await f.request()).json();
    if (!current.cache.refreshing) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const disk = new SteamInventoryCache({ dir: f.inventoryCacheDir });
  assert.deepEqual((await disk.get(A, async () => empty)).emoticons, [{ name: 'updated' }]);
  await disk.close();
});

test('offline cached reads require active grant and chat permission; cached inventory does not authorize sends', async t => {
  const f = await fixture(t, { seed: true });
  const ws = await f.socket();
  f.status.status = 'logged_out';
  f.status.steamId = null;
  f.steamUser.steamID = undefined;
  assert.deepEqual((await (await f.request()).json()).emoticons, [{ name: 'saved-A' }]);
  assert.deepEqual((await ws.request()).emoticons, [{ name: 'saved-A' }]);
  assert.equal(f.calls(), 0);
  const send = await f.request('/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '42', msg: 'hello' }) });
  assert.equal(send.status, 503);
  f.revoke();
  assert.equal((await f.request()).status, 403);
  assert.equal((await ws.request()).statusCode, 403);
  f.store.replaceUserSteamGrants(f.user.id, [{ steamAccountId: f.a.id, level: 'read', scope: 'all', peers: [] }], f.root.id);
  f.store.setPermissionOverrides(f.user.id, [{ permission: 'chat.use', effect: 'revoke' }], f.root.id);
  assert.equal((await f.request()).status, 403);
  assert.equal((await ws.request()).statusCode, 403);
});

for (const transport of ['HTTP', 'WS'] as const) {
  for (const mutation of ['switch', 'revoke', 'permission', 'session'] as const) {
    test(`${transport} reauthorizes after first-load await: ${mutation}`, async t => {
      const upstream = deferred<SteamInventory>();
      const started = deferred<void>();
      let loads = 0;
      const f = await fixture(t, { loader: () => { started.resolve(); return ++loads === 1 ? upstream.promise : Promise.resolve(items('new-account')); } });
      const ws = transport === 'WS' ? await f.socket() : undefined;
      const response = ws ? ws.request() : f.request();
      await started.promise;
      if (mutation === 'switch') f.switchAccount();
      if (mutation === 'revoke') f.revoke();
      if (mutation === 'permission') f.store.setPermissionOverrides(f.user.id, [{ permission: 'chat.use', effect: 'revoke' }], f.root.id);
      if (mutation === 'session') f.store.revokeUserSessions(f.user.id, f.root.id);
      upstream.resolve(items('old-account-secret'));
      if (ws) {
        if (mutation === 'session') {
          // Revocation closes the socket; it must not deliver the inventory payload.
          assert.equal((await response as Record<string, unknown>).type, 'closed');
        } else {
          const body = await response as Record<string, unknown>;
          assert.equal(body.type, 'error');
          assert.equal(body.emoticons, undefined);
        }
      } else {
        const res = await response as Response;
        assert.notEqual(res.status, 200);
        assert.equal((await res.json()).emoticons, undefined);
      }
      if (mutation === 'switch') {
        assert.deepEqual(await readdir(f.inventoryCacheDir).catch((): string[] => []), [], 'old-account fetch must not be saved after switching');
        const current = await (await f.request()).json();
        assert.deepEqual(current.emoticons, [{ name: 'new-account' }], 'a new fetch runs under B');
        assert.equal(f.calls(), 2);
        assert.deepEqual(await readdir(f.inventoryCacheDir), [`${B}.json`]);
      }
    });
  }
}

test('cached snapshots stay account-scoped across account switching', async t => {
  const upstream = deferred<SteamInventory>();
  const f = await fixture(t, { seed: true, loader: () => upstream.promise });
  assert.deepEqual((await (await f.request()).json()).emoticons, [{ name: 'saved-A' }]);
  f.switchAccount();
  assert.deepEqual((await (await f.request()).json()).emoticons, [{ name: 'saved-B' }]);
  upstream.resolve(items('B-fresh'));
});

test('backend refresh helpers receive only the requested account previous complete snapshot', async t => {
  const received: Array<SteamInventory | undefined> = [];
  const f = await fixture(t, { seed: true, loader: async ({ previousInventory }) => {
    received.push(previousInventory);
    return items('updated');
  } });
  await f.request();
  assert.deepEqual(received, [items('saved-A')]);
  f.switchAccount();
  await f.request();
  assert.deepEqual(received, [items('saved-A'), items('saved-B')]);
});

test('conflicting live SDK identities cannot refresh or read inventory for the wrong account', async t => {
  const f = await fixture(t, { seed: true });
  f.steamUser.steamID = B;
  assert.equal((await f.request()).status, 409);
  const ws = await f.socket();
  assert.equal((await ws.request()).statusCode, 409);
  assert.equal(f.calls(), 0);
  f.steamUser.steamID = A;
  f.steamCommunity.steamID = B;
  assert.equal((await f.request()).status, 409);
  assert.equal((await ws.request()).statusCode, 409);
  assert.equal(f.calls(), 0);
});

test('legacy injected array-only helpers without account keep working without disk writes', async t => {
  const f = await fixture(t, { legacy: true, loader: async () => ({ emoticons: [{ name: 'wave' }], stickers: [] }) });
  const body = await (await f.request()).json();
  assert.deepEqual(body.emoticons, [{ name: 'wave' }]);
  assert.deepEqual(body.effects, []);
  assert.equal((await (await f.socket()).request()).type, 'emoticons');
  assert.equal(f.calls(), 1);
  assert.deepEqual(await readdir(f.inventoryCacheDir).catch((): string[] => []), []);
});

test('first load upstream failure is an HTTP/WS error rather than successful empty arrays', async t => {
  const f = await fixture(t, { loader: async () => { throw Object.assign(new Error('Inventory unavailable'), { statusCode: 503 }); } });
  const response = await f.request();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /Inventory unavailable/);
  assert.equal(body.emoticons, undefined);
  const ws = await f.socket();
  const socket = await ws.request();
  assert.equal(socket.type, 'error');
  assert.equal(socket.emoticons, undefined);
  assert.equal(f.calls(), 1);
});
