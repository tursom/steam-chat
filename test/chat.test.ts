'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { RawData, WebSocket as WsConnection } from 'ws';
import { isRecord } from '../src/types';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const {
  createAuthChecker,
  createChatService,
  inferImageContentType,
  isAllowedRemoteImageUrl,
  normalizeChatConfig
} = require('../src/server/chat-service');

type WsMessage = Record<string, unknown> & {
  items?: Array<Record<string, unknown>>;
};

type WsInbox = {
  next: () => Promise<WsMessage>;
};

type TestSteamUser = EventEmitterType & {
  chat: {
    sendFriendMessage: (id: unknown, msg: unknown, callback: (error: Error | null, result?: unknown) => void) => void;
  };
};

type ChatServiceRuntime = {
  server: Server;
  stop: () => Promise<void>;
};

type WsConstructor = new (url: string) => WsConnection;
const WsClient = WebSocket as WsConstructor;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function wsOpen(url: string): Promise<{ ws: WsConnection; inbox: WsInbox }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    const inbox = createWsInbox(ws);
    ws.once('open', () => resolve({ ws, inbox }));
    ws.once('error', reject);
  });
}

function createWsInbox(ws: WsConnection): WsInbox {
  const queue: WsMessage[] = [];
  const waiters: Array<{ resolve: (value: WsMessage) => void }> = [];
  ws.on('message', (data: RawData) => {
    const parsed: unknown = JSON.parse(data.toString());
    const payload: WsMessage = isRecord(parsed) ? parsed : {};
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(payload);
    else queue.push(payload);
  });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2000);
        waiters.push({
          resolve(value: WsMessage) {
            clearTimeout(timer);
            resolve(value);
          }
        });
      });
    }
  };
}

test('normalizeChatConfig accepts boolean shorthand', () => {
  assert.equal(normalizeChatConfig(true).enabled, true);
  assert.equal(normalizeChatConfig({ port: 3100 }).port, 3100);
});

test('image proxy URL guard rejects local and private targets', () => {
  assert.equal(isAllowedRemoteImageUrl('https://example.com/a.png'), true);
  assert.equal(isAllowedRemoteImageUrl('ftp://example.com/a.png'), false);
  assert.equal(isAllowedRemoteImageUrl('http://localhost/a.png'), false);
  assert.equal(isAllowedRemoteImageUrl('http://127.0.0.1/a.png'), false);
  assert.equal(isAllowedRemoteImageUrl('http://192.168.1.2/a.png'), false);
  assert.equal(inferImageContentType('https://x.test/a.webp'), 'image/webp');
});

test('auth checker bypasses local clients and validates proxied public clients with timing safe hashes', () => {
  const auth = createAuthChecker({
    username: 'u',
    password: 'p',
    trustProxy: true
  });
  assert.equal(auth.isAuthorized({
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  }), true);
  assert.equal(auth.isAuthorized({
    headers: { 'x-forwarded-for': '8.8.8.8' },
    socket: { remoteAddress: '127.0.0.1' }
  }), false);
  assert.equal(auth.isAuthorized({
    headers: {
      'x-forwarded-for': '8.8.8.8',
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`
    },
    socket: { remoteAddress: '127.0.0.1' }
  }), true);
});

test('HTTP API sends messages, writes history, and builds conversations', async (t: TestContext) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-http-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;
  steamUser.chat = {
    sendFriendMessage(id: unknown, msg: unknown, callback: (error: Error | null, result?: unknown) => void) {
      callback(null, { id, msg });
    }
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws' },
    steamUser,
    logPath,
    getSelfName: async () => 'Me',
    logger: { info() {}, warn() {}, error() {} }
  }) as ChatServiceRuntime;
  t.after(() => service.stop().catch(() => {}));
  const port = await listen(service.server);

  const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await configResponse.json(), { wsPath: '/ws' });

  const sendResponse = await fetch(`http://127.0.0.1:${port}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '7656119', msg: 'hello' })
  });
  assert.equal(sendResponse.status, 200);
  const sendPayload = await sendResponse.json();
  assert.equal(sendPayload.item.message, 'hello');
  assert.equal(sendPayload.item.echo, true);

  const history = await (await fetch(`http://127.0.0.1:${port}/history?id=7656119`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].name, 'Me');

  const conversations = await (await fetch(`http://127.0.0.1:${port}/conversations`)).json();
  assert.equal(conversations[0].id, '7656119');
  assert.equal(conversations[0].preview, 'hello');
});

test('WebSocket sends ready, handles ping, rejects invalid JSON, and supports history requests', async (t: TestContext) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-ws-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;
  steamUser.chat = {
    sendFriendMessage(id: unknown, msg: unknown, callback: (error: Error | null, result?: unknown) => void) {
      callback(null);
    }
  };
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws' },
    steamUser,
    logPath,
    getSelfName: async () => 'Me',
    logger: { info() {}, warn() {}, error() {} }
  }) as ChatServiceRuntime;
  t.after(() => service.stop().catch(() => {}));
  const port = await listen(service.server);
  const { ws, inbox } = await wsOpen(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());

  assert.deepEqual(await inbox.next(), { type: 'ready', wsPath: '/ws' });

  ws.send(JSON.stringify({ type: 'ping', requestId: 'p1' }));
  assert.deepEqual(await inbox.next(), { requestId: 'p1', type: 'pong' });

  ws.send('bad json');
  assert.deepEqual(await inbox.next(), { type: 'error', error: 'Invalid JSON' });

  ws.send(JSON.stringify({ type: 'send_message', id: '42', msg: 'via ws', requestId: 'm1' }));
  const sent = await inbox.next();
  assert.equal(sent.type, 'message');
  const receipt = await inbox.next();
  assert.equal(receipt.requestId, 'm1');
  assert.equal(receipt.type, 'message_sent');

  ws.send(JSON.stringify({ type: 'history', id: '42', requestId: 'h1' }));
  const history = await inbox.next();
  assert.equal(history.requestId, 'h1');
  assert.equal(history.items[0].message, 'via ws');
});
