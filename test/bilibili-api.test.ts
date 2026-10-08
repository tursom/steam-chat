import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');

test('Bilibili share resolver requires session permission and works independently of Steam login', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bilibili-api-'));
  const store = createAuthStore({ dbPath: join(directory, 'auth.sqlite') });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = store.createUser({ username: 'user', password: 'password123', role: 'user' }, admin.id);
  const sessions = createSessionManager({ store });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  let calls = 0, release: () => void = () => {};
  let gate: Promise<void> | undefined;
  const service = createChatService({ authStore: store, sessionManager: sessions,
    logPath: join(directory, 'chat.jsonl'), config: { host: '127.0.0.1', port: 0 }, logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => { calls++; await gate; return new Response(null, { status: 302, headers: {
      Location: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2'
    } }); }
  });
  t.after(async () => { release(); await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}/api/bilibili/resolve`;
  const target = `${base}?${new URLSearchParams({ url: 'https://b23.tv/Short1' })}`;
  assert.equal((await fetch(target)).status, 401); assert.equal(calls, 0);
  const get = () => fetch(target, { headers: { Cookie: cookie } });
  const response = await get();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' });
  assert.equal((await fetch(base, { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  assert.equal((await fetch(`${base}?url=http://127.0.0.1/private`, { headers: { Cookie: cookie } })).status, 400);
  assert.equal(calls, 1);
  const permission = store.hasPermission;
  store.hasPermission = () => false;
  assert.equal((await get()).status, 403); assert.equal(calls, 1);
  store.hasPermission = permission;
  gate = new Promise(resolve => { release = resolve; });
  const pending = get();
  while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5));
  store.hasPermission = () => false;
  release(); assert.equal((await pending).status, 403, 'Permission is rechecked after asynchronous resolution');
});
