import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { replaceableSteamClient } from '../src/steam/replaceable-client';
const { createSteamLoginService } = require('../src/steam/lifecycle');

function fixture() {
  class User extends EventEmitter {
    steamID: string | null = null;
    calls = 0;
    logOffCalls = 0;
    logOn() { this.calls++; }
    logOff() { this.logOffCalls++; this.steamID = null; }
    webLogOn() { this.emit('webSession', 'session', ['cookie']); }
  }
  const clients: User[] = [];
  const stable = replaceableSteamClient(() => { const user = new User(); clients.push(user); return user; });
  let id = 0;
  const jobs = new Map<number, { callback: () => void; delay: number }>();
  const service = createSteamLoginService({ steamUser: stable.client, replaceClient: stable.replace,
    fileSystem: { readFileSync: () => 'saved-token', mkdirSync() {}, writeFileSync() {} },
    timers: { setTimeout(callback: () => void, delay: number) { jobs.set(++id, { callback, delay }); return id; }, clearTimeout(handle: number) { jobs.delete(handle); } },
    logger: { info() {}, warn() {}, error() {} } });
  function run(delay: number) {
    const job = [...jobs].find(([, job]) => job.delay === delay);
    assert.ok(job, `Expected timer ${delay}, got ${[...jobs.values()].map(x => x.delay)}`);
    jobs.delete(job[0]); job[1].callback();
  }
  return { stable, service, clients, jobs, run };
}

test('login timeouts replace clients with capped exponential backoff, then reset on success', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  void f.service.start().catch(() => {});
  for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    const old = f.clients.at(-1)!;
    f.run(120000);
    assert.equal(f.service.getStatus().status, 'reconnecting');
    f.run(delay);
    assert.notEqual(f.clients.at(-1), old);
    assert.equal(f.clients.at(-1)!.calls, 1);
    old.emit('loggedOn'); old.emit('webSession', 'stale', ['stale']); old.emit('error', new Error('late error'));
    assert.equal(f.service.getStatus().status, 'logging_in');
    assert.equal(f.service.getLatestWebSession(), null);
  }
  const current = f.clients.at(-1)!;
  current.steamID = '76561198000000001'; current.emit('loggedOn');
  assert.equal(f.service.getStatus().status, 'online');
  assert.equal(f.service.getRetryDelayMs(), 5000);
  assert.equal(f.service.getLatestWebSession().sessionID, 'session');
  current.emit('disconnected', 3, 'NoConnection');
  f.run(5000); assert.equal(current.calls, 2);
});

test('stop cancels a pending timeout recovery and suppresses late SDK events', () => {
  const f = fixture(); void f.service.start().catch(() => {}); f.run(120000);
  f.service.stop(); assert.equal(f.jobs.size, 0);
  f.clients[0].emit('loggedOn'); assert.equal(f.service.getStatus().status, 'logged_out');
  assert.equal(f.clients.length, 1);
});

test('guard wait and invalid credentials do not automatically replace clients', () => {
  const f = fixture(); void f.service.start().catch(() => {});
  f.clients[0].emit('steamGuard', null, () => {}, false);
  assert.equal(f.jobs.size, 0); assert.equal(f.service.getStatus().status, 'waiting_guard');
  f.service.submitGuard('12345');
  f.clients[0].emit('error', Object.assign(new Error('InvalidPassword'), { eresult: 5 }));
  assert.equal(f.service.getStatus().status, 'error'); assert.equal(f.jobs.size, 0);
  f.service.stop();
});

test('application message subscriptions survive replacement and reject retired events', () => {
  const f = fixture(); const messages: string[] = [];
  f.stable.client.on('friendMessage', (message: string) => messages.push(message));
  f.clients[0].emit('friendMessage', 'before'); f.stable.replace();
  f.clients[0].emit('friendMessage', 'stale'); f.clients[1].emit('friendMessage', 'after');
  assert.deepEqual(messages, ['before', 'after']); f.service.stop();
});

test('installed Steam SDK keeps chat methods bound to the current instance after replacement', () => {
  const SteamUser = require('steam-user');
  const instances: any[] = [];
  const stable = replaceableSteamClient<any>(() => {
    const user = new SteamUser({ autoRelogin: false }); instances.push(user); return user;
  });
  const seen: string[] = [];
  stable.client.on('friendMessage', (id: string) => seen.push(id));
  const firstChat = stable.client.chat;
  stable.replace();
  assert.notEqual(stable.client.chat, firstChat);
  instances[0].emit('friendMessage', 'old');
  instances[0].emit('error', new Error('late authentication rejection'));
  instances[1].emit('friendMessage', 'new');
  assert.deepEqual(seen, ['new']);
  stable.client.logOff();
});
