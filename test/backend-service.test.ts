'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { WebSocket as WsConnection } from 'ws';
import { createHash } from 'node:crypto';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const { createAuthStore } = require('../src/auth/store');
const { createSessionManager } = require('../src/auth/session');
const { createChatService } = require('../src/server/chat-service');
const { appendLog } = require('../src/storage/chat-log');

type TestSteamUser = EventEmitterType & {
  chat: {
    sendFriendMessage: (id: unknown, msg: unknown, callback: (error: Error | null) => void) => void;
  };
};

type ChatServiceRuntime = {
  server: Server;
  stop: () => Promise<void>;
};

type SteamStatus = {
  status: string;
  requiresGuard: boolean;
  guardType: null;
  domain: null;
  lastCodeWrong: boolean;
  error: null;
  steamId: null;
};

type WsConstructor = new (url: string, options?: Record<string, unknown>) => WsConnection;
const WsClient = WebSocket as WsConstructor;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function cookiePair(setCookie: string | null) {
  assert.ok(setCookie);
  return setCookie.split(';')[0];
}

function tempPath(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `steam-chat-${name}-`));
  return { dir, dbPath: path.join(dir, 'auth.sqlite'), logPath: path.join(dir, 'chat.jsonl') };
}

function offlineSteamService() {
  const status: SteamStatus = {
    status: 'logged_out',
    requiresGuard: false,
    guardType: null,
    domain: null,
    lastCodeWrong: false,
    error: null,
    steamId: null
  };
  return {
    getStatus() {
      return status;
    },
    ensureOnline() {
      throw Object.assign(new Error('Steam is not logged in'), { statusCode: 503, steamStatus: status.status });
    },
    login() {
      return status;
    },
    logout() {
      return status;
    },
    submitGuard() {
      return status;
    }
  };
}

function wsOpen(url: string, cookie: string): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, { headers: { Cookie: cookie } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function wsRejects(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once('open', () => {
      ws.close();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    ws.once('error', () => resolve());
  });
}

test('backend auth gates chat HTTP APIs and reports Steam offline as 503', async (t: TestContext) => {
  const paths = tempPath('backend-http');
  const store = createAuthStore({ dbPath: paths.dbPath });
  t.after(() => store.close());
  const sessions = createSessionManager({ store });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const cookie = cookiePair(sessions.createSetCookie(admin));
  const steamUser = new EventEmitter() as TestSteamUser;
  steamUser.chat = {
    sendFriendMessage(_id: unknown, _msg: unknown, callback: (error: Error | null) => void) {
      callback(null);
    }
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws' },
    steamUser,
    logPath: paths.logPath,
    authStore: store,
    sessionManager: sessions,
    steamLoginService: offlineSteamService(),
    logger: { info() {}, warn() {}, error() {} }
  }) as ChatServiceRuntime;
  t.after(() => service.stop().catch(() => {}));
  const port = await listen(service.server);

  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/history`)).status, 401);

  const playerModule = await fetch(`http://127.0.0.1:${port}/vendor/artplayer-5.4.0.mjs`);
  assert.equal(playerModule.status, 200, 'The click-loaded player is a public local static asset');
  assert.match(playerModule.headers.get('content-type'), /text\/javascript/);
  assert.match(await playerModule.text(), /artplayer\.js v5\.4\.0/);
  const playerLicense = await fetch(`http://127.0.0.1:${port}/vendor/artplayer-LICENSE.txt`);
  assert.equal(playerLicense.status, 200);
  assert.match(await playerLicense.text(), /MIT License/);

  const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
    headers: { Cookie: cookie }
  });
  assert.equal(configResponse.status, 200);

  const sendResponse = await fetch(`http://127.0.0.1:${port}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: '42', msg: 'hello' })
  });
  assert.equal(sendResponse.status, 503);
  assert.deepEqual(await sendResponse.json(), {
    error: 'Steam is not logged in',
    steamStatus: 'logged_out'
  });
});

test('static responses grant immutable caching only to the matching content hash', async (t: TestContext) => {
  const service = createChatService({ config: { host: '127.0.0.1', port: 0, wsPath: '/legacy-ws' },
    logger: { info() {}, warn() {}, error() {} } }) as ChatServiceRuntime;
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${await listen(service.server)}`;
  const config = await fetch(base + '/api/config');
  assert.deepEqual(await config.json(), { wsPath: '/legacy-ws' }, 'legacy auth does not advertise session-only operations');
  for (const pathname of ['/app.js', '/style.css', '/vendor/artplayer-5.4.0.mjs']) {
    const plain = await fetch(base + pathname);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=60');
    const bytes = Buffer.from(await plain.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const versioned = await fetch(`${base}${pathname}?v=${hash}`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), bytes);
    const stale = `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`;
    for (const query of [`v=${stale}`, 'v=anything', 'v=', `v=${hash.slice(0, 8)}`, `v=${hash}&v=${hash}`, `v=${hash}&v=${stale}`]) {
      const response = await fetch(`${base}${pathname}?${query}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=60', query);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
  }
  for (const pathname of ['/', '/index.html', '/sw.js', '/manifest.webmanifest']) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const hash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex').slice(0, 16);
    const versioned = await fetch(`${base}${pathname}?v=${hash}`);
    assert.equal(versioned.headers.get('cache-control'), 'no-store', pathname);
    await versioned.arrayBuffer();
  }
});

test('backend WebSocket rejects missing cookies and accepts authenticated users', async (t: TestContext) => {
  const paths = tempPath('backend-ws');
  const store = createAuthStore({ dbPath: paths.dbPath });
  t.after(() => store.close());
  const sessions = createSessionManager({ store });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const cookie = cookiePair(sessions.createSetCookie(admin));
  const steamUser = new EventEmitter() as TestSteamUser;
  steamUser.chat = {
    sendFriendMessage(_id: unknown, _msg: unknown, callback: (error: Error | null) => void) {
      callback(null);
    }
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws' },
    steamUser,
    logPath: paths.logPath,
    authStore: store,
    sessionManager: sessions,
    steamLoginService: offlineSteamService(),
    logger: { info() {}, warn() {}, error() {} }
  }) as ChatServiceRuntime;
  t.after(() => service.stop().catch(() => {}));
  const port = await listen(service.server);

  await wsRejects(`ws://127.0.0.1:${port}/ws`);
  const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`, cookie);
  t.after(() => ws.close());
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('backend blocks ordinary users from ungranted active Steam account history', async (t: TestContext) => {
  const paths = tempPath('backend-steam-grants');
  const store = createAuthStore({ dbPath: paths.dbPath });
  t.after(() => store.close());
  const sessions = createSessionManager({ store });
  const admin = store.createInitialAdmin({ username: 'admin', password: 'password123' });
  const user = store.createUser({ username: 'worker', password: 'password123', role: 'user' });
  const account = store.upsertSteamAccount({ steamId: '76561198000000000', label: 'Support', setActive: true });
  await appendLog({
    steamAccountId: account.steamId,
    id: '42',
    name: 'Alice',
    message: 'authorized row',
    ordinal: 1,
    date: '2026-06-23 10:00:00.000'
  }, { logPath: paths.logPath });
  await appendLog({
    id: '99',
    name: 'Legacy',
    message: 'legacy row',
    ordinal: 1,
    date: '2026-06-23 10:01:00.000'
  }, { logPath: paths.logPath });

  const adminCookie = cookiePair(sessions.createSetCookie(admin));
  const userCookie = cookiePair(sessions.createSetCookie(user));
  const steamUser = new EventEmitter() as TestSteamUser;
  steamUser.chat = {
    sendFriendMessage(_id: unknown, _msg: unknown, callback: (error: Error | null) => void) {
      callback(null);
    }
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws' },
    steamUser,
    logPath: paths.logPath,
    authStore: store,
    sessionManager: sessions,
    steamLoginService: offlineSteamService(),
    logger: { info() {}, warn() {}, error() {} }
  }) as ChatServiceRuntime;
  t.after(() => service.stop().catch(() => {}));
  const port = await listen(service.server);

  const deniedStatus = await fetch(`http://127.0.0.1:${port}/api/steam/status`, {
    headers: { Cookie: userCookie }
  });
  assert.equal(deniedStatus.status, 200);
  assert.equal((await deniedStatus.json()).accessAllowed, false);

  const deniedHistory = await fetch(`http://127.0.0.1:${port}/history?id=42`, {
    headers: { Cookie: userCookie }
  });
  assert.equal(deniedHistory.status, 403);

  store.replaceUserSteamAccounts(user.id, [account.id], admin.id);
  const allowedHistory = await fetch(`http://127.0.0.1:${port}/history?id=42`, {
    headers: { Cookie: userCookie }
  });
  assert.equal(allowedHistory.status, 200);
  assert.deepEqual((await allowedHistory.json()).map((item: { message: string }) => item.message), ['authorized row']);

  const adminHistory = await fetch(`http://127.0.0.1:${port}/history`, {
    headers: { Cookie: adminCookie }
  });
  assert.deepEqual((await adminHistory.json()).map((item: { message: string }) => item.message), ['authorized row', 'legacy row']);
});
