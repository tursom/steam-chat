import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';
import { textMessageSize, validateTextMessage } from '../src/server/text-message-limit';

const SteamUser = require('steam-user');
const { createChatService } = require('../src/server/chat-service');
const account = '76561198000000002';
const peer = '76561198000000001';
const boundaryMessages = [
  'a'.repeat(6340), '中'.repeat(2113) + 'a', '😀'.repeat(1585),
  '['.repeat(3170), 'a'.repeat(6278) + '\nb', 'a'.repeat(6278) + '\r\nb',
  'a'.repeat(6278) + '\rb', 'a' + '\n'.repeat(103) + 'a'.repeat(56)
];

test('Steam text budget accounts for Unicode, escaped brackets and weighted line endings', () => {
  for (const message of boundaryMessages) {
    assert.equal(textMessageSize(message), 6340);
    assert.doesNotThrow(() => validateTextMessage(message));
    assert.throws(() => validateTextMessage(message + 'a'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /6341\/6340/);
      return true;
    });
  }
  assert.doesNotThrow(() => validateTextMessage('a'.repeat(1945), true));
  assert.throws(() => validateTextMessage('a'.repeat(1946), true));
  assert.equal(textMessageSize('\ud800'), 3, 'invalid surrogates use UTF-8 replacement bytes');
});

test('HTTP and WebSocket reject long text before SDK submission without cooling down valid sends', async t => {
  const user = new SteamUser({ autoRelogin: false });
  let packets = 0;
  let appends = 0;
  user._sendUnified = (_method: string, payload: { message: string }, callback: (body: unknown, header: unknown) => void) => {
    packets++;
    callback({ modified_message: payload.message, server_timestamp: 1700000000, ordinal: packets }, { proto: { eresult: 1 } });
  };
  const service = createChatService({ steamUser: user, getSelfName: async () => 'Self',
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} },
    logger: { info() {}, warn() {}, error() {} },
    config: { host: '127.0.0.1', port: 0, wsPath: '/ws', wsHeartbeatMs: 0 },
    historyStorage: { canSend: () => true, append(record: unknown) { appends++; return record; },
      onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {} }
  });
  t.after(() => service.stop());
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  for (const message of boundaryMessages) {
    const response = await fetch(`${base}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: peer, msg: message + 'a' }) });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('retry-after'), null);
    const body = await response.json();
    assert.equal(body.code, 'message_too_long');
    assert.equal(body.uncertain, false);
    assert.equal(body.retryAt, undefined);
  }
  assert.equal(packets, 0);
  assert.equal(appends, 0);

  const split = await fetch(`${base}/api/messages/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: peer, msg: '中'.repeat(2114), steamAccountId: account }) });
  assert.equal(split.status, 200);
  assert.equal(split.headers.get('cache-control'), 'private, no-store');
  const prepared = await split.json();
  assert.equal(prepared.steamAccountId, account);
  assert.equal(prepared.maxBytes, 6340);
  assert.ok(prepared.parts.length > 1);
  assert.equal(prepared.parts.join(''), '中'.repeat(2114));
  for (const part of prepared.parts) assert.doesNotThrow(() => validateTextMessage(part));
  assert.equal(packets, 0, 'preparation must not submit any Steam message');
  assert.equal(appends, 0);

  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  t.after(() => ws.terminate());
  await once(ws, 'message');
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'send_message', requestId: 'long-text', id: peer, msg: '中'.repeat(2114) }));
  const rejection = JSON.parse(String((await reply)[0]));
  assert.equal(rejection.requestId, 'long-text');
  assert.equal(rejection.code, 'message_too_long');
  assert.equal(rejection.uncertain, false);
  assert.equal(packets, 0);

  for (const message of boundaryMessages) {
    const result = await service.sendTextMessage(peer, message, account);
    assert.equal(result.message, message.replace(/\[/g, '\\['));
  }
  assert.equal(packets, boundaryMessages.length);
  assert.equal(appends, packets);

  user.limitations = { limited: true };
  const limitedSplit = await fetch(`${base}/api/messages/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: peer, msg: 'a'.repeat(1946), steamAccountId: account }) });
  const limitedParts = await limitedSplit.json();
  assert.equal(limitedParts.maxBytes, 1945);
  assert.equal(limitedParts.parts.join(''), 'a'.repeat(1946));
  for (const part of limitedParts.parts) assert.doesNotThrow(() => validateTextMessage(part, true));
  await assert.rejects(service.sendTextMessage(peer, 'a'.repeat(1946), account),
    (error: { code?: string; uncertain?: boolean }) => error.code === 'message_too_long' && error.uncertain === false);
  await service.sendTextMessage(peer, 'a'.repeat(1945), account);
  assert.equal(packets, boundaryMessages.length + 1);
});
