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

  service.login({ accountName: 'name', password: 'secret' });
  user.emit('refreshToken', 'next-token');
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'next-token\n');
  service.logout();
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(service.getStatus().status, 'logged_out');
});

function retryFixture() {
  const tokenPath = tempTokenPath();
  fs.writeFileSync(tokenPath, 'saved-token\n');
  const calls: LogOnOptions[] = [];
  const user = createUser(calls);
  const tasks = new Map<number, { fn: () => void; delay: number }>();
  let sequence = 0;
  let connecting = false;
  let cancellations = 0;
  user.logOn = (options) => {
    assert.equal(connecting, false, 'Already attempting to log on, cannot log on again');
    connecting = true;
    calls.push(options);
  };
  user.logOff = () => { connecting = false; cancellations += 1; };
  const service = createSteamLoginService({
    steamUser: user, refreshTokenPath: tokenPath,
    logger: { info() {}, warn() {}, error() {} },
    timers: {
      setTimeout(fn: () => void, delay: number) { tasks.set(++sequence, { fn, delay }); return sequence; },
      clearTimeout(id: number) { tasks.delete(id); }
    }
  });
  function run(delay: number) {
    const task = [...tasks].find(([, task]) => task.delay === delay);
    assert.ok(task, `Expected timer at ${delay} ms`);
    tasks.delete(task[0]);
    task[1].fn();
  }
  return { service, user, calls, tasks, run, tokenPath, cancellations: () => cancellations };
}

test('repeated start does not enqueue another SDK logOn', () => {
  const f = retryFixture();
  const first = f.service.start();
  assert.equal(f.service.start(), first);
  assert.equal(f.calls.length, 1);
  f.service.stop();
});

test('recoverable errors cancel SDK connection retries before application retry', () => {
  const f = retryFixture();
  f.service.start();
  f.user.emit('error', new Error('socket timeout'));
  f.user.emit('error', new Error('socket timeout'));
  f.run(5000);
  assert.equal(f.calls.length, 2);
  assert.ok(f.cancellations() >= 1);
  f.service.stop();
});

test('silent login times out without deleting credentials or reusing uncertain client', async () => {
  const f = retryFixture();
  const login = f.service.start();
  f.run(120000);
  await assert.rejects(login, /timed out/);
  assert.equal(f.service.getStatus().status, 'error');
  assert.equal(fs.readFileSync(f.tokenPath, 'utf8'), 'saved-token\n');
  assert.equal(f.tasks.size, 0);
  assert.throws(() => f.service.start(), /restart/i);
  f.user.emit('loggedOn');
  f.user.emit('refreshToken', 'late-token');
  f.user.emit('webSession', 'late', ['late']);
  f.user.emit('error', new Error('timeout'));
  assert.equal(f.service.getStatus().status, 'error');
  assert.equal(f.service.getLatestWebSession(), null);
  assert.equal(fs.readFileSync(f.tokenPath, 'utf8'), 'saved-token\n');
});

test('Guard waiting suspends watchdog and submission rearms it', () => {
  const f = retryFixture();
  f.service.start();
  f.user.emit('steamGuard', null, () => {}, false);
  assert.equal(f.tasks.size, 0);
  f.service.submitGuard('ABCDE');
  f.run(120000);
  assert.equal(f.service.getStatus().status, 'error');
});

test('stop ignores late events and settles pending login', async () => {
  const f = retryFixture();
  const login = f.service.start();
  f.service.stop();
  await assert.rejects(login, /stopped/);
  f.user.emit('loggedOn');
  f.user.emit('steamGuard', null, () => {}, false);
  f.user.emit('disconnected', 0, 'timeout');
  assert.equal(f.service.getStatus().status, 'logged_out');
  assert.equal(f.tasks.size, 0);
});

test('fatal error cancels queued reconnect and successful login clears watchdog', () => {
  const f = retryFixture();
  f.service.start();
  f.user.emit('error', new Error('socket timeout'));
  f.user.emit('error', new Error('InvalidPassword'));
  assert.equal(f.service.getStatus().status, 'error');
  assert.equal(f.tasks.size, 0);
  f.service.start();
  f.user.emit('loggedOn');
  assert.equal(f.service.getStatus().status, 'online');
  assert.equal(f.tasks.size, 0);
  f.user.emit('disconnected', 0, 'Logged off');
  assert.equal(f.service.getStatus().status, 'reconnecting');
  f.service.stop();
});

test('logout during pending login rejects waiters and ignores late Guard and token events', async () => {
  const f = retryFixture();
  const login = f.service.start();
  f.service.logout();
  await assert.rejects(login, /logged out/);
  f.user.emit('steamGuard', null, () => { throw new Error('stale Guard callback'); }, false);
  f.user.emit('refreshToken', 'late-token');
  f.user.emit('loggedOn');
  assert.equal(f.service.getStatus().status, 'logged_out');
  assert.equal(fs.existsSync(f.tokenPath), false);
  assert.equal(f.tasks.size, 0);
  assert.throws(() => f.service.login({ accountName: 'name', password: 'secret' }), /restart/);
});

test('cancelled watchdog and reconnect callbacks cannot affect a later login', () => {
  const f = retryFixture();
  f.service.start();
  const oldWatchdog = [...f.tasks.values()][0].fn;
  f.user.emit('error', new Error('socket timeout'));
  const oldRetry = [...f.tasks.values()][0].fn;
  f.service.logout();
  f.service.login({ accountName: 'name', password: 'secret' });
  oldWatchdog();
  oldRetry();
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.getStatus().status, 'logging_in');
  f.service.stop();
});

test('online logout blocks new login until SDK disconnection and does not schedule reconnect', () => {
  const f = retryFixture();
  f.service.start();
  f.user.emit('loggedOn');
  f.service.logout();
  assert.throws(() => f.service.login({ accountName: 'name', password: 'secret' }), /logout is still in progress/);
  f.user.emit('disconnected', 0, 'Logged off');
  assert.equal(f.tasks.size, 0);
  f.service.login({ accountName: 'name', password: 'secret' });
  assert.equal(f.calls.length, 2);
  f.service.stop();
});
