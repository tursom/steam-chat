'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSteamLoginService } = require('../src/steam/lifecycle');

type LogOnOptions = {
  accountName?: string;
  password?: string;
  refreshToken?: string;
  logonID?: number;
};

type LoginTestUser = EventEmitterType & {
  steamID?: unknown;
  logOn: (options: LogOnOptions) => void;
  webLogOn: () => void;
  logOff: () => void;
};

function tempTokenPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-chat-login-'));
  return path.join(dir, 'refresh.token');
}

function createUser(logOnCalls: LogOnOptions[]): LoginTestUser {
  const user = new EventEmitter() as LoginTestUser;
  user.logOn = (options: LogOnOptions) => logOnCalls.push(options);
  user.webLogOn = () => user.emit('webSession', 'session-id', ['a=b']);
  user.logOff = () => {};
  return user;
}

test('SteamLoginService starts without token as logged_out and token login does not require account credentials', async () => {
  const tokenPath = tempTokenPath();
  const calls: LogOnOptions[] = [];
  const user = createUser(calls);
  const service = createSteamLoginService({
    steamUser: user,
    refreshTokenPath: tokenPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(await service.start(), false);
  assert.equal(calls.length, 0);
  assert.equal(service.getStatus().status, 'logged_out');

  fs.writeFileSync(tokenPath, 'refresh-value\n');
  const tokenLogin = service.start();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { refreshToken: 'refresh-value' });
  user.emit('loggedOn');
  await tokenLogin;
  assert.equal(service.getStatus().status, 'online');
});

test('SteamLoginService exposes Guard state and submits the pending callback', () => {
  const calls: LogOnOptions[] = [];
  const user = createUser(calls);
  const service = createSteamLoginService({
    steamUser: user,
    refreshTokenPath: tempTokenPath(),
    getDefaultLogonID: () => 12345,
    logger: { info() {}, warn() {}, error() {} }
  });

  const status = service.login({ accountName: 'name', password: 'secret' });
  assert.equal(status.status, 'logging_in');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountName, 'name');
  assert.equal(calls[0].password, 'secret');
  assert.equal(calls[0].logonID, 12345);

  let submitted = '';
  user.emit('steamGuard', null, (code: string) => {
    submitted = code;
  }, false);
  const waiting = service.getStatus();
  assert.equal(waiting.status, 'waiting_guard');
  assert.equal(waiting.guardType, 'device');
  assert.equal(waiting.requiresGuard, true);

  service.submitGuard('ABCDE');
  assert.equal(submitted, 'ABCDE');
  assert.equal(service.getStatus().status, 'logging_in');
});

test('SteamLoginService saves refresh tokens and logout deletes the persisted token', () => {
  const tokenPath = tempTokenPath();
  const calls: LogOnOptions[] = [];
  const user = createUser(calls);
  const service = createSteamLoginService({
    steamUser: user,
    refreshTokenPath: tokenPath,
    logger: { info() {}, warn() {}, error() {} }
  });

  user.emit('refreshToken', 'next-token');
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'next-token\n');
  service.logout();
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(service.getStatus().status, 'logged_out');
});
