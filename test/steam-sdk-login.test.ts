'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Child isolation lets us assert the SDK's unhandled async rejection without crashing node:test.
// Stub connection setup before logOn: these checks must never reach Steam's network.
const setup = `
  const SteamUser = require('steam-user');
  const user = new SteamUser({dataDirectory: null, autoRelogin: false});
  user._doConnection = () => {};
  user._readFile = async () => null;
`;

test('installed SDK duplicate logOn rejects asynchronously, outside caller try/catch', () => {
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', setup + `
    try { user.logOn({}); user.logOn({}); }
    catch (_) { process.exit(42); }
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /Already attempting to log on, cannot log on again/);
});

test('service repeated start and immediate stop are safe with installed SDK nextTick logOn', () => {
  const lifecyclePath = require.resolve('../src/steam/lifecycle');
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', setup + `
    const {createSteamLoginService} = require(${JSON.stringify(lifecyclePath)});
    const logOn = user.logOn.bind(user);
    user.logOn = () => logOn({});
    const service = createSteamLoginService({
      steamUser: user, logger: {info(){},warn(){},error(){}},
      fileSystem: {readFileSync: () => 'fixture-token'}
    });
    service.start();
    service.start();
    service.stop();
    setImmediate(() => {
      require('node:assert/strict').equal(user._connecting, false);
      require('node:assert/strict').equal(service.getStatus().status, 'logged_out');
    });
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});

test('production client explicitly disables SDK autoRelogin', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
  assert.match(source, /new SteamUser\(\{ renewRefreshTokens: true, autoRelogin: false \}\)/);
});
