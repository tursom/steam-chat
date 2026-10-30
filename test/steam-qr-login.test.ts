import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';

const { createSteamLoginService } = require('../src/steam/lifecycle');

const accountId = '76561198000000001';
const challenge = 'https://s.team/q/1/1234567890123456789';

class QrSession extends EventEmitter {
  loginTimeout = 0;
  refreshToken = 'qr-refresh-token';
  steamID = accountId;
  cancellations = 0;
  startWithQR = async (): Promise<{ qrChallengeUrl: string }> => ({ qrChallengeUrl: challenge });
  cancelLoginAttempt() { this.cancellations += 1; return true; }
}

function fixture(t: TestContext, startWithQR?: QrSession['startWithQR']) {
  const dir = mkdtempSync(join(tmpdir(), 'steam-qr-'));
  const tokenPath = join(dir, 'refresh.token');
  const calls: Record<string, unknown>[] = [];
  const hooks: unknown[][] = [];
  const tasks = new Map<number, () => void>();
  const sessions: QrSession[] = [];
  let sequence = 0;
  const user = Object.assign(new EventEmitter(), {
    steamID: null as string | null,
    logOn(input: Record<string, unknown>) { calls.push(input); },
    logOff() { user.steamID = null; },
    webLogOn() { user.emit('webSession', 'sid', ['cookie=value']); }
  });
  const service = createSteamLoginService({
    steamUser: user, refreshTokenPath: tokenPath,
    config: { steamID: '76561198000000999' },
    logger: { info() {}, warn() {}, error() {} },
    getDefaultLogonID: () => 2468,
    onRefreshToken(token: string, id: string) { hooks.push(['refresh', token, id]); },
    onLoggedOn(id: string) { hooks.push(['online', id, readFileSync(tokenPath, 'utf8').trim()]); },
    createQrSession() {
      const session = new QrSession();
      if (startWithQR) session.startWithQR = startWithQR;
      sessions.push(session);
      return session;
    },
    timers: {
      setTimeout(fn: () => void) { tasks.set(++sequence, fn); return sequence; },
      clearTimeout(id: number) { tasks.delete(id); }
    }
  });
  t.after(() => { service.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { service, user, sessions, tasks, tokenPath, calls, hooks };
}

async function waitForImage(service: { getStatus(): { qrLogin: { imageDataUrl: string | null } } }) {
  for (let turn = 0; turn < 100; turn += 1) {
    const image = service.getStatus().qrLogin?.imageDataUrl;
    if (image) return image;
    await nextTurn();
  }
  assert.fail('QR image was not generated');
}

test('QR login creates a PNG, reports scan, persists the correct account token and connects through CM', async (t) => {
  const f = fixture(t);
  const initial = f.service.startQrLogin();
  assert.equal(initial.status, 'waiting_qr');
  assert.equal(initial.qrLogin.imageDataUrl, null);
  assert.ok(initial.qrLogin.expiresAt > Date.now());
  assert.equal(f.sessions[0].loginTimeout, 120000);
  const login = f.service.waitForLogin();
  const image = await waitForImage(f.service);
  assert.match(image, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(image.split(',')[1], 'base64').subarray(1, 4).toString(), 'PNG');
  assert.equal(f.calls.length, 0);
  f.sessions[0].emit('remoteInteraction');
  assert.equal(f.service.getStatus().qrLogin.scanned, true);
  f.sessions[0].emit('authenticated');
  assert.equal(f.service.getStatus().status, 'logging_in');
  assert.equal(f.service.getStatus().qrLogin, null);
  assert.deepEqual(f.calls, [{ refreshToken: 'qr-refresh-token', steamID: accountId, logonID: 2468 }]);
  assert.equal(readFileSync(f.tokenPath, 'utf8'), 'qr-refresh-token\n');
  f.user.steamID = accountId;
  f.user.emit('loggedOn');
  assert.equal(await login, true);
  assert.deepEqual(await f.service.waitForWebSession(), { sessionID: 'sid', cookies: ['cookie=value'] });
  assert.equal(f.service.getStatus().status, 'online');
  assert.deepEqual(f.hooks, [['refresh', 'qr-refresh-token', accountId], ['online', accountId, 'qr-refresh-token']]);
  assert.equal(f.tasks.size, 0);
});

test('QR login blocks concurrent password/token/QR attempts and reuses its waiter on start', async (t) => {
  const f = fixture(t);
  f.service.startQrLogin();
  assert.throws(() => f.service.login({ accountName: 'name', password: 'secret' }), /already active/);
  assert.throws(() => f.service.connectWithRefreshToken('other'), /already active/);
  assert.throws(() => f.service.startQrLogin(), /already active/);
  assert.equal(f.service.start(), f.service.waitForLogin());
  const login = f.service.waitForLogin();
  f.service.cancelQrLogin();
  await assert.rejects(login, /cancelled/);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.service.getStatus().status, 'logged_out');
  f.service.login({ accountName: 'name', password: 'secret' });
  assert.equal(f.calls.length, 1);
});

test('cancelled QR sessions cannot authenticate or restart polling when delayed initialization resolves', async (t) => {
  let resolveStart!: (value: { qrChallengeUrl: string }) => void;
  const pending = new Promise<{ qrChallengeUrl: string }>((resolve) => { resolveStart = resolve; });
  const f = fixture(t, () => pending);
  writeFileSync(f.tokenPath, 'previous-account-token\n');
  // Hold the old startWithQR request in flight while starting another attempt.
  f.service.startQrLogin();
  f.service.cancelQrLogin();
  const originalFactory = f.sessions[0];
  resolveStart({ qrChallengeUrl: challenge });
  await nextTurn();
  assert.ok(originalFactory.cancellations >= 2, 'cancel again after SDK setup resolves');
  f.service.startQrLogin();
  const current = f.service.getStatus();
  originalFactory.emit('remoteInteraction');
  originalFactory.emit('authenticated');
  originalFactory.emit('error', new Error('old failure'));
  originalFactory.emit('timeout');
  assert.equal(f.service.getStatus().status, 'waiting_qr');
  assert.equal(f.service.getStatus().qrLogin.scanned, false);
  assert.equal(f.service.getStatus().qrLogin.expiresAt, current.qrLogin.expiresAt);
  assert.equal(readFileSync(f.tokenPath, 'utf8'), 'previous-account-token\n');
  assert.equal(f.calls.length, 0);
});

for (const failure of ['timeout', 'error', 'watchdog'] as const) {
  test(`QR ${failure} clears the image and supports retry without deleting an existing token`, async (t) => {
    const f = fixture(t);
    writeFileSync(f.tokenPath, 'saved\n');
    f.service.startQrLogin();
    const staleTimeout = [...f.tasks.values()][0];
    const login = f.service.waitForLogin();
    if (failure === 'watchdog') staleTimeout();
    else f.sessions[0].emit(failure, new Error('Steam rejected QR login'));
    await assert.rejects(login);
    assert.equal(f.service.getStatus().status, 'error');
    assert.equal(f.service.getStatus().qrLogin, null);
    assert.equal(f.tasks.size, 0);
    assert.equal(readFileSync(f.tokenPath, 'utf8'), 'saved\n');
    f.service.startQrLogin();
    staleTimeout();
    assert.equal(f.service.getStatus().status, 'waiting_qr');
  });
}

for (const action of ['stop', 'logout'] as const) {
  test(`${action} cancels QR polling and rejects late authentication`, async (t) => {
    const f = fixture(t);
    f.service.startQrLogin();
    const login = f.service.waitForLogin();
    f.service[action]();
    await assert.rejects(login);
    f.sessions[0].emit('authenticated');
    await nextTurn();
    assert.equal(f.service.getStatus().status, 'logged_out');
    assert.equal(f.service.getStatus().qrLogin, null);
    assert.equal(f.tasks.size, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(f.tokenPath), false);
  });
}

test('missing authenticated credentials surface errors without CM login', async (t) => {
  const f = fixture(t);
  f.service.startQrLogin();
  f.sessions[0].refreshToken = '';
  f.sessions[0].emit('authenticated');
  await nextTurn();
  assert.equal(f.service.getStatus().status, 'error');
  assert.match(f.service.getStatus().error, /no account or refresh token/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.tasks.size, 0);
});

test('QR setup rejection surfaces an error and clears the attempt', async (t) => {
  const f = fixture(t, async () => { throw new Error('Steam unavailable'); });
  f.service.startQrLogin();
  await nextTurn();
  assert.equal(f.service.getStatus().status, 'error');
  assert.equal(f.service.getStatus().error, 'Steam unavailable');
  assert.equal(f.service.getStatus().qrLogin, null);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.calls.length, 0);
});

test('QR account reconnect uses the saved token identity instead of a stale configured SteamID', (t) => {
  const f = fixture(t);
  f.service.startQrLogin();
  f.sessions[0].emit('authenticated');
  f.user.steamID = accountId;
  f.user.emit('loggedOn');
  f.user.emit('disconnected', 3, 'NoConnection');
  assert.equal(f.service.getStatus().status, 'reconnecting');
  const [timerId, reconnect] = [...f.tasks.entries()][0];
  f.tasks.delete(timerId);
  reconnect();
  assert.deepEqual(f.calls[1], { refreshToken: 'qr-refresh-token' });
});

test('startup with a persisted QR token lets Steam infer its account independently of config', (t) => {
  const f = fixture(t);
  writeFileSync(f.tokenPath, 'qr-refresh-token\n');
  f.service.start();
  assert.deepEqual(f.calls, [{ refreshToken: 'qr-refresh-token' }]);
});
