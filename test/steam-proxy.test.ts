import { strict as assert } from 'node:assert';
import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { test, type TestContext } from 'node:test';
import { getSteamProxyOptions, getSteamCommunityProxyOptions } from '../src/steam/proxy';

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const { LoginSession } = require('steam-session');
const { createSteamLoginService } = require('../src/steam/lifecycle');

test('Steam proxy is opt-in, supports HTTP/SOCKS and rejects invalid URLs without exposing credentials', () => {
  assert.deepEqual(getSteamProxyOptions({}), {});
  assert.deepEqual(getSteamProxyOptions({ STEAM_CHAT_PROXY: '  ' }), {});
  assert.deepEqual(getSteamProxyOptions({ HTTPS_PROXY: 'http://other:8080' }), {});
  for (const scheme of ['http', 'https']) {
    const url = `${scheme}://user:password@localhost:7890`;
    assert.deepEqual(getSteamProxyOptions({ STEAM_CHAT_PROXY: ` ${url} ` }), { httpProxy: url });
  }
  for (const scheme of ['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    const url = `${scheme}://user:password@localhost:1080`;
    assert.deepEqual(getSteamProxyOptions({ STEAM_CHAT_PROXY: url }), { socksProxy: url });
    assert.deepEqual(getSteamProxyOptions({ STEAM_CHAT_PROXY: `${scheme}://localhost` }), {
      socksProxy: `${scheme}://localhost:1080`
    });
  }
  for (const value of ['localhost:7890', 'ftp://user:secret@localhost', 'http://user:secret@',
    'http://user:secret@localhost:99999', 'http://localhost/path', 'http://localhost/?secret']) {
    assert.throws(() => getSteamProxyOptions({ STEAM_CHAT_PROXY: value }), (error: Error) => {
      assert.match(error.message, /Invalid STEAM_CHAT_PROXY/);
      assert.doesNotMatch(error.message, /secret|password|user:/);
      return true;
    });
  }
  assert.deepEqual(getSteamCommunityProxyOptions({}), {});
});

async function listen(t: TestContext, server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

function probeAgent(agent: https.Agent): Promise<Error> {
  return new Promise((resolve, reject) => {
    const req = https.get('https://steam-proxy-test.invalid/probe', { agent }, (res) => {
      res.resume();
      reject(new Error('Expected test proxy to refuse tunnel'));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Probe timeout')));
    req.on('error', resolve);
  });
}

for (const scheme of ['http', 'socks5h']) {
  test(`${scheme} proxy routes installed SteamUser, QR LoginSession and SteamCommunity through loopback`, { timeout: 10000 }, async (t) => {
    const targets: string[] = [];
    const server = scheme === 'http' ? http.createServer((req, res) => {
      targets.push(req.url!);
      res.end('proxy response');
    }).on('connect', (req, socket) => {
      targets.push(req.url!);
      socket.end('HTTP/1.1 502 Test proxy refuses tunnel\r\nContent-Length: 0\r\n\r\n');
    }) : net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let greeted = false;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (!greeted) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          greeted = true;
          socket.write(Buffer.from([5, 0]));
        }
        if (buffer.length < 5) return;
        assert.equal(buffer[3], 3, 'socks5h sends the hostname to the proxy');
        const length = buffer[4];
        if (buffer.length < 7 + length) return;
        targets.push(`${buffer.subarray(5, 5 + length).toString()}:${buffer.readUInt16BE(5 + length)}`);
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
    const port = await listen(t, server);
    const proxy = getSteamProxyOptions({ STEAM_CHAT_PROXY: `${scheme}://127.0.0.1:${port}` });
    const user = new SteamUser({ ...proxy, dataDirectory: null, autoRelogin: false, webCompatibilityMode: true });
    await probeAgent(user._getProxyAgent());
    assert.deepEqual(targets, ['steam-proxy-test.invalid:443']);

    // Exercise the lifecycle's default QR constructor, without starting Steam requests.
    let qrAgent: https.Agent | undefined;
    const original = LoginSession.prototype.startWithQR;
    LoginSession.prototype.startWithQR = async function () {
      qrAgent = this._handler._transport._agent;
      return { qrChallengeUrl: 'https://s.team/q/test' };
    };
    const service = createSteamLoginService({
      steamUser: Object.assign(new EventEmitter(), { logOn() {}, logOff() {}, webLogOn() {} }),
      proxy, logger: { info() {}, warn() {}, error() {} }
    });
    try { service.startQrLogin(); }
    finally {
      service.stop();
      LoginSession.prototype.startWithQR = original;
    }
    assert.ok(qrAgent);
    await probeAgent(qrAgent);
    assert.deepEqual(targets, ['steam-proxy-test.invalid:443', 'steam-proxy-test.invalid:443']);

    const community = new SteamCommunity();
    community.request = community.request.defaults(getSteamCommunityProxyOptions(proxy));
    const result = await new Promise<{ error: Error | null; body: string }>((resolve) => {
      community.request('http://steam-proxy-test.invalid/community', { timeout: 2000 },
        (error: Error | null, _response: unknown, body: string) => resolve({ error, body }));
    });
    if (scheme === 'http') {
      assert.equal(result.error, null);
      assert.equal(result.body, 'proxy response');
      assert.equal(targets[2], 'http://steam-proxy-test.invalid/community');
    } else {
      assert.ok(result.error, 'test SOCKS proxy deliberately refuses the tunnel');
      assert.equal(targets[2], 'steam-proxy-test.invalid:80');
      assert.equal(getSteamCommunityProxyOptions(proxy).proxy, null);
    }
  });
}
