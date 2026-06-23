'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const { createSteamMessageLogger } = require('../src/steam/message-logger');
const { readHistory } = require('../src/storage/chat-log');

type SteamHistoryMessage = {
  imageUrl?: string | null;
  accountid?: string | number;
  message?: string;
  ordinal?: string | number | null;
  timestamp?: number;
};

type TestSteamUser = EventEmitterType & {
  getChatHistory?: (id: string, callback: (error: unknown, messages?: SteamHistoryMessage[]) => void) => void;
};

async function historyUntil(logPath: string, expectedLength: number) {
  let last = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await readHistory({ logPath, limit: 50, logger: { warn() {} } });
    if (last.length >= expectedLength) return last;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${expectedLength} chat log rows, got ${last.length}`);
}

test('createSteamMessageLogger imports Steam history once before live friend messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-message-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;
  const steamID = { getSteamID64: () => '76561198000000000' };
  let historyCalls = 0;
  steamUser.getChatHistory = (id: string, callback: (error: unknown, messages?: SteamHistoryMessage[]) => void) => {
    historyCalls += 1;
    assert.equal(id, '76561198000000000');
    callback(null, [
      { accountid: 'history-user', message: 'old text', ordinal: 1, timestamp: 1710000000 },
      { imageUrl: 'https://example.com/old.png', message: '', ordinal: 2, timestamp: 1710000001 }
    ]);
  };

  const dispose = createSteamMessageLogger({
    steamUser,
    getUserInfo: async () => ({ player_name: 'Alice' }),
    getSelfName: async () => 'Me',
    logPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  steamUser.emit('friendMessage', steamID, 'live one', undefined, undefined, 3);
  let history = await historyUntil(logPath, 3);
  assert.equal(historyCalls, 1);
  assert.deepEqual(history.map((item: { message: string }) => item.message), ['old text', '', 'live one']);
  assert.equal(history[1].type, 'image');
  assert.equal(history[2].name, 'Alice');

  steamUser.emit('friendMessage', steamID, 'live two', undefined, undefined, 4);
  history = await historyUntil(logPath, 4);
  assert.equal(historyCalls, 1);
  assert.equal(history[3].message, 'live two');

  dispose();
  steamUser.emit('friendMessage', steamID, 'after dispose', undefined, undefined, 5);
  await delay(20);
  history = await readHistory({ logPath, limit: 50 });
  assert.equal(history.length, 4);
});

test('createSteamMessageLogger records one echoed message for duplicate echo events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-message-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;

  const dispose = createSteamMessageLogger({
    steamUser,
    getSelfName: async () => 'Self',
    logPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  steamUser.emit('friendMessageEcho', '42', 'echo text', 7);
  steamUser.emit('friendMessageEcho', '42', 'echo text', 7);

  let history = await historyUntil(logPath, 1);
  await delay(20);
  history = await readHistory({ logPath, limit: 50 });
  assert.equal(history.length, 1);
  assert.equal(history[0].echo, true);
  assert.equal(history[0].id, '42');
  assert.equal(history[0].name, 'Self');
  assert.equal(history[0].message, 'echo text');

  dispose();
});
