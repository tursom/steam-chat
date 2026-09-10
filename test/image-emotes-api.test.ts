import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('library API enforces roles and sends stored bytes by ID with Steam account guards', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'image-emote-api-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const sessions = createSessionManager({ store: auth });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = auth.createUser({ username: 'user', password: 'password123', role: 'user' }, admin.id);
  const account = auth.upsertSteamAccount({ steamId: '76561198000000002', setActive: true });
  const cookies = [admin, user].map(person => sessions.createSetCookie(person).split(';')[0]);
  let online = true; let sends = 0;
  const service = createChatService({
    authStore: auth, sessionManager: sessions, imageEmoteDir: join(dir, 'library'), logPath: join(dir, 'chat.jsonl'),
    config: { host: '127.0.0.1', port: 0 }, logger: { info() {}, warn() {}, error() {} },
    steamLoginService: { getStatus: () => ({ status: online ? 'online' : 'logged_out', steamId: account.steamId }),
      ensureOnline() { if (!online) throw Object.assign(new Error('offline'), { statusCode: 503 }); } },
    steamCommunity: { sendImageToUser(id: string, buffer: Buffer, _options: unknown, callback: (error: null, url: string) => void) {
      assert.equal(id, '76561198000000001');
      assert.deepEqual(buffer, Buffer.from(data.split(',')[1], 'base64'));
      sends++; callback(null, 'https://images.steamusercontent.com/example.png');
    } }
  });
  t.after(async () => { await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const get = (url: string, cookie?: string) => fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (url: string, body: unknown, cookie: string) => fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await get('/api/image-emotes')).status, 401);
  assert.equal((await post('/api/image-emotes', { version: 0, action: 'createGroup', name: '猫猫' }, cookies[1])).status, 403);
  const groupResponse = await post('/api/image-emotes', { version: 0, action: 'createGroup', name: '猫猫' }, cookies[0]);
  assert.equal(groupResponse.status, 200);
  const group = (await groupResponse.json()).groups[0];
  const upload = await post('/api/image-emotes', { version: 1, action: 'addImage', groupId: group.id, name: '开心', data }, cookies[0]);
  assert.equal(upload.status, 200);
  const image = (await upload.json()).images[0];
  assert.equal((await get(`/api/image-emotes/file/${image.id}`)).status, 401);
  const read = await get(`/api/image-emotes/file/${image.id}`, cookies[1]);
  assert.equal(read.status, 200); assert.equal(read.headers.get('content-type'), 'image/png');
  const body = { id: '76561198000000001', emoteId: image.id, steamAccountId: account.steamId };
  assert.equal((await post('/image', body, cookies[1])).status, 403);
  auth.replaceUserSteamAccounts(user.id, [account.id], admin.id);
  assert.equal((await post('/image', body, cookies[1])).status, 200);
  assert.equal((await post('/image', body, cookies[1])).status, 200);
  assert.equal(sends, 2);
  assert.equal((await post('/image', { ...body, steamAccountId: '76561198000000003' }, cookies[1])).status, 409);
  online = false;
  assert.equal((await post('/image', body, cookies[1])).status, 503);
  assert.equal((await get('/api/image-emotes', cookies[0])).status, 200, 'offline administration remains usable');
  online = true;
  await post('/api/image-emotes', { version: 2, action: 'deleteImage', id: image.id }, cookies[0]);
  assert.equal((await post('/image', body, cookies[1])).status, 404);
  assert.equal(sends, 2);
});
