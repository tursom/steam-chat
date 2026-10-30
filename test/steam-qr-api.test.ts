import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');

test('QR API enforces management permissions and never exposes challenges through public/user status or audit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'steam-qr-api-'));
  const store = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const sessions = createSessionManager({ store });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const member = store.createUser({ username: 'worker', password: 'password123', role: 'user' });
  const cookies = {
    admin: sessions.createSetCookie(admin).split(';')[0],
    user: sessions.createSetCookie(member).split(';')[0]
  };
  let starts = 0;
  let cancels = 0;
  let status = 'logged_out';
  const qrLogin = { imageDataUrl: 'data:image/png;base64,private-challenge', scanned: false, expiresAt: Date.now() + 120000 };
  const lifecycle = {
    getStatus: () => ({ status, steamId: null as string | null, qrLogin: status === 'waiting_qr' ? qrLogin : null }),
    startQrLogin() { starts += 1; status = 'waiting_qr'; return this.getStatus(); },
    cancelQrLogin() { cancels += 1; status = 'logged_out'; return this.getStatus(); },
    login() { return this.getStatus(); },
    logout() { return this.getStatus(); },
    submitGuard() { return this.getStatus(); },
    ensureOnline() {}
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0 },
    steamUser: new EventEmitter(),
    authStore: store, sessionManager: sessions, steamLoginService: lifecycle,
    logPath: join(dir, 'chat.jsonl'), logger: { info() {}, warn() {}, error() {} }
  });
  t.after(async () => { await service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await fetch(base + '/api/steam/login/qr', { method })).status, 401);
    assert.equal((await fetch(base + '/api/steam/login/qr', { method, headers: { Cookie: cookies.user } })).status, 403);
  }
  assert.equal(starts, 0);
  assert.equal(cancels, 0);
  const started = await fetch(base + '/api/steam/login/qr', { method: 'POST', headers: { Cookie: cookies.admin } });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await started.json()).qrLogin, qrLogin);
  for (const [role, cookie] of Object.entries(cookies)) {
    for (const path of ['/api/steam/status', '/api/auth/me']) {
      const response = await fetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json();
      assert.deepEqual((path.endsWith('/me') ? payload.steam : payload).qrLogin, role === 'admin' ? qrLogin : null);
    }
  }
  const anonymous = await fetch(base + '/api/auth/me');
  assert.equal((await anonymous.json()).steam.qrLogin, null);
  const cancelled = await fetch(base + '/api/steam/login/qr', { method: 'DELETE', headers: { Cookie: cookies.admin } });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).qrLogin, null);
  assert.equal(starts, 1);
  assert.equal(cancels, 1);
  const audits = await fetch(base + '/api/audit-logs', { headers: { Cookie: cookies.admin } });
  const auditText = await audits.text();
  assert.match(auditText, /steam_account.qr_start/);
  assert.match(auditText, /steam_account.qr_cancel/);
  assert.doesNotMatch(auditText, /private-challenge|imageDataUrl/);
});
