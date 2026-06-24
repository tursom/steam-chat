'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { WebSocket as WsConnection } from 'ws';

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
