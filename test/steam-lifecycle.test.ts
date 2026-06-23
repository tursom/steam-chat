'use strict';

import type { EventEmitter as EventEmitterType } from 'node:events';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLogOnOptions,
  createSteamLifecycle,
  isRecoverableLoginError,
  isUnrecoverableLoginError
} = require('../src/steam/lifecycle');

type LogOnOptions = {
  accountName?: string;
  password?: string;
  refreshToken?: string;
  logonID?: number;
  steamID?: string;
};

type ScheduledTimer = {
  fn: () => void;
  delay: number;
};

type LifecycleTestUser = EventEmitterType & {
  logOn: (options: LogOnOptions) => void;
  webLogOn: () => void;
  logOff: () => void;
};

test('buildLogOnOptions prefers refresh.token over account password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-chat-life-'));
  const tokenPath = path.join(dir, 'refresh.token');
  fs.writeFileSync(tokenPath, 'refresh-value\n');

  assert.deepEqual(buildLogOnOptions({
    accountName: 'account',
    password: 'secret',
    logonID: 42,
    steamID: '7656'
  }, tokenPath), {
    refreshToken: 'refresh-value',
    logonID: 42,
    steamID: '7656'
  });
});

test('login error classification separates recoverable and unrecoverable errors', () => {
  assert.equal(isRecoverableLoginError(new Error('ECONNRESET socket closed')), true);
  assert.equal(isRecoverableLoginError(new Error('InvalidPassword')), false);
  assert.equal(isUnrecoverableLoginError(new Error('SteamGuard required')), true);
});

test('createSteamLifecycle logs on, resolves web session, saves refresh token, and avoids duplicate retry timers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-chat-life-'));
  const tokenPath = path.join(dir, 'refresh.token');
  const user = new EventEmitter() as LifecycleTestUser;
  const community = { cookies: null as string[] | null, setCookies(cookies: string[]) { this.cookies = cookies; } };
  const logOnCalls: LogOnOptions[] = [];
  let scheduled: ScheduledTimer | null = null;
  let clearCount = 0;
  user.logOn = (options: LogOnOptions) => logOnCalls.push(options);
  user.webLogOn = () => user.emit('webSession', 'session-id', ['a=b']);
  user.logOff = () => {};

  const lifecycle = createSteamLifecycle({
    steamUser: user,
    steamCommunity: community,
    config: { accountName: 'name', password: 'pass' },
    refreshTokenPath: tokenPath,
    logger: { info() {}, warn() {}, error() {} },
    timers: {
      setTimeout(fn: () => void, delay: number) {
        scheduled = { fn, delay };
        return 7;
      },
      clearTimeout() {
        clearCount += 1;
      }
    }
  });

  lifecycle.start();
  assert.equal(logOnCalls.length, 1);
  assert.equal(logOnCalls[0].accountName, 'name');

  user.emit('error', new Error('timeout'));
  user.emit('error', new Error('timeout again'));
  assert.ok(scheduled);
  assert.equal(scheduled.delay, 5000);
  scheduled.fn();
  assert.equal(logOnCalls.length, 2);

  user.emit('loggedOn');
  await lifecycle.waitForLogin();
  const webSession = await lifecycle.waitForWebSession();
  assert.deepEqual(webSession, { sessionID: 'session-id', cookies: ['a=b'] });
  assert.deepEqual(community.cookies, ['a=b']);
  assert.equal(clearCount, 0);

  user.emit('refreshToken', 'next-token');
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'next-token\n');
});
