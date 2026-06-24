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
  accountid?: string | number;
  message?: string;
  ordinal?: string | number | null;
  steamID?: unknown;
  timestamp?: number;
};

type SteamFriendHistoryMessage = {
  sender?: unknown;
  server_timestamp?: Date;
  ordinal?: string | number | null;
  message?: string;
};

type TestSteamChat = Partial<EventEmitterType> & {
    getFriendMessageHistory?: (
      id: string,
      options: { maxCount: number; wantBbcode: boolean },
      callback: (error: unknown, response?: { messages?: SteamFriendHistoryMessage[] }) => void
    ) => void;
};

type TestSteamUser = EventEmitterType & {
  chat?: TestSteamChat;
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

test('createSteamMessageLogger imports chat friend history with original ordinals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-message-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;
  const steamID = { getSteamID64: () => '76561198000000000' };
  const selfID = { getSteamID64: () => '76561198000000001' };
  let historyCalls = 0;
  steamUser.chat = {
    getFriendMessageHistory(id: string, options: { maxCount: number; wantBbcode: boolean }, callback: (error: unknown, response?: { messages?: SteamFriendHistoryMessage[] }) => void) {
      historyCalls += 1;
      assert.equal(id, '76561198000000000');
      assert.deepEqual(options, { maxCount: 100, wantBbcode: true });
      callback(null, {
        messages: [
          { sender: steamID, message: 'old friend text', ordinal: 11, server_timestamp: new Date(1710000000 * 1000) },
          { sender: selfID, message: 'old self text', ordinal: 12, server_timestamp: new Date(1710000001 * 1000) }
        ]
      });
    }
  };
  steamUser.getChatHistory = () => assert.fail('legacy getChatHistory should not be used when chat history is available');

  const dispose = createSteamMessageLogger({
    steamUser,
    getUserInfo: async () => ({ player_name: 'Alice' }),
    getSelfName: async () => 'Me',
    logPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  steamUser.emit('friendMessage', steamID, 'live one', undefined, undefined, 13);
  const history = await historyUntil(logPath, 3);
  assert.equal(historyCalls, 1);
  assert.deepEqual(history.map((item: { message: string }) => item.message), ['old friend text', 'old self text', 'live one']);
  assert.deepEqual(history.map((item: { ordinal: number | string | null }) => item.ordinal), [11, 12, 13]);
  assert.equal(history[0].echo, false);
  assert.equal(history[1].echo, true);

  dispose();
});

test('createSteamMessageLogger merges chat object events with legacy compatibility events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-message-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;
  const chat = new EventEmitter() as TestSteamChat & EventEmitterType;
  const steamID = { getSteamID64: () => '76561198000000000' };
  const bbcodeImage = '[img src=https://images.steamusercontent.com/ugc/example/][url=https://images.steamusercontent.com/ugc/example/]https://images.steamusercontent.com/ugc/example/[/url][/img]';
  let historyCalls = 0;
  chat.getFriendMessageHistory = (id: string, options: { maxCount: number; wantBbcode: boolean }, callback: (error: unknown, response?: { messages?: SteamFriendHistoryMessage[] }) => void) => {
    historyCalls += 1;
    assert.equal(id, '76561198000000000');
    assert.deepEqual(options, { maxCount: 100, wantBbcode: true });
    callback(null, {
      messages: [
        { sender: steamID, message: 'history from chat object trigger', ordinal: 43, server_timestamp: new Date(1709999999 * 1000) }
      ]
    });
  };
  steamUser.chat = chat;

  const dispose = createSteamMessageLogger({
    steamUser,
    getUserInfo: async () => ({ player_name: 'Alice' }),
    getSelfName: async () => 'Me',
    logPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  chat.emit('friendMessage', {
    steamid_friend: steamID,
    message: bbcodeImage,
    message_no_bbcode: 'https://images.steamusercontent.com/ugc/example/',
    ordinal: 44,
    server_timestamp: new Date(1710000000 * 1000)
  });
  steamUser.emit('friendMessage', steamID, 'https://images.steamusercontent.com/ugc/example/');

  let history = await historyUntil(logPath, 2);
  await delay(30);
  history = await readHistory({ logPath, limit: 50 });
  assert.equal(historyCalls, 1);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item: { message: string }) => item.message), ['history from chat object trigger', bbcodeImage]);
  assert.deepEqual(history.map((item: { ordinal: number | string | null }) => item.ordinal), [43, 44]);
  assert.equal(history[1].name, 'Alice');

  const raw = await fs.readFile(logPath, 'utf8');
  assert.equal(raw.includes('imageUrl'), false);
  assert.equal(raw.includes('sentAt'), false);
  assert.equal(raw.includes('"ordinal":43'), true);
  assert.equal(raw.includes('"ordinal":44'), true);

  dispose();
});

test('createSteamMessageLogger falls back to legacy Steam history before live friend messages', async () => {
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
      { accountid: 'history-user', message: 'old image', ordinal: 2, timestamp: 1710000001 }
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
  assert.deepEqual(history.map((item: { message: string }) => item.message), ['old text', 'old image', 'live one']);
  assert.deepEqual(history.map((item: { ordinal: number | string | null }) => item.ordinal), [1, 2, 3]);
  assert.equal(history[1].type, 'message');
  assert.equal(history[2].name, 'Alice');
  const raw = await fs.readFile(logPath, 'utf8');
  assert.equal(raw.includes('"ordinal":3'), true);
  assert.equal(raw.includes('imageUrl'), false);
  assert.equal(raw.includes('sentAt'), false);
  assert.equal(raw.includes('"type"'), false);

  steamUser.emit('friendMessage', steamID, 'live two', undefined, undefined, 4);
  history = await historyUntil(logPath, 4);
  assert.equal(historyCalls, 1);
  assert.equal(history[3].message, 'live two');
  assert.equal(history[3].ordinal, 4);

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
  assert.equal(history[0].ordinal, 7);

  dispose();
});

test('createSteamMessageLogger generates ordinals when legacy Steam events omit them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-message-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  const steamUser = new EventEmitter() as TestSteamUser;

  const dispose = createSteamMessageLogger({
    steamUser,
    getUserInfo: async () => ({ player_name: 'Alice' }),
    getSelfName: async () => 'Self',
    logPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  steamUser.emit('friendMessage', '42', 'legacy incoming');
  steamUser.emit('friendMessageEcho', '42', 'legacy echo');

  const history = await historyUntil(logPath, 2);
  const raw = await fs.readFile(logPath, 'utf8');
  assert.equal(raw.includes('"ordinal":null'), false);
  assert.equal(raw.includes('imageUrl'), false);
  assert.equal(raw.includes('sentAt'), false);
  assert.equal(raw.includes('"type"'), false);
  assert.equal(history.every((item: { ordinal: number | string | null }) => typeof item.ordinal === 'number'), true);

  dispose();
});
