import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');

test('reaction API requires session and account access, rejects stale account and offline writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-reaction-api-'));
  const auth = createAuthStore({ dbPath: join(directory, 'auth.sqlite') });
  const sessions = createSessionManager({ store: auth });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = auth.createUser({ username: 'user', password: 'password123', role: 'user' }, admin.id);
  const account = auth.upsertSteamAccount({ steamId: '76561198000000002', setActive: true });
  const cookie = sessions.createSetCookie(user).split(';')[0];
  let calls = 0, online = true;
  const service = createChatService({ authStore: auth, sessionManager: sessions, logPath: join(directory, 'chat.jsonl'),
    config: { host: '127.0.0.1', port: 0 }, logger: { info() {}, warn() {}, error() {} },
    steamLoginService: { getStatus: () => ({ status: online ? 'online' : 'logged_out', steamId: account.steamId }), ensureOnline() { if (!online) throw Object.assign(new Error('offline'), { statusCode: 503 }); } },
    steamUser: { _sendUnified(_method: string, _body: unknown, cb: any) { calls++; cb({ messages: [] }, { proto: { eresult: 1 } }); },
      _send(_header: unknown, _body: unknown, cb: any) { calls++; cb(Buffer.alloc(0), { proto: { eresult: 1 } }); } }
  });
  t.after(async () => { await service.stop(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}/api/message-reactions`;
  const body = { id: '76561198000000001', steamAccountId: account.steamId, timestamp: 1700000000, ordinal: 1, reactionType: 1, reaction: ':smile:', add: true };
  const post = (data = body) => fetch(base, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await post()).status, 403);
  assert.equal(calls, 0);
  auth.replaceUserSteamAccounts(user.id, [account.id], admin.id);
  assert.equal((await post()).status, 200);
  assert.equal((await post({ ...body, steamAccountId: '76561198000000003' })).status, 409);
  online = false; assert.equal((await post()).status, 503);
  assert.equal(calls, 1);
  online = true;
  const response = await fetch(`${base}?id=${body.id}&before=1700000001&steamAccountId=${account.steamId}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
});
