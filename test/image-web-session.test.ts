import { strict as assert } from 'node:assert';
import { test } from 'node:test';
const { createChatService } = require('../src/server/chat-service');
const SteamCommunity = require('steamcommunity');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

for (const reason of ['Not Logged on.', 'Not Logged In', 'NotLoggedOn']) {
  test(`installed image SDK refreshes expired begin-upload session: ${reason}`, async t => {
    const community = new SteamCommunity();
    const calls: string[] = [];
    let refreshed = false;
    community.httpRequestPost = (options: { uri: string }, callback: (error: unknown, response?: unknown, body?: unknown) => void) => {
      if (options.uri.includes('beginfileupload')) {
        calls.push('begin');
        if (!refreshed) { callback(new Error('HTTP error 403'), { statusCode: 403 }, { success: 21, message: reason }); return; }
        callback(null, { statusCode: 200 }, { success: 1, hmac: 'test', timestamp: 1, result: { ugcid: '1', url_host: 'test.invalid', url_path: '/test', request_headers: [], use_https: true } });
      } else {
        calls.push('commit'); callback(null, { statusCode: 200 }, { success: 1, result: { success: 1, details: { url: 'https://images.steamusercontent.com/image.png' } } });
      }
    };
    community.httpRequest = (_options: unknown, callback: (error: null) => void) => { calls.push('PUT'); callback(null); };
    const service = createChatService({ steamCommunity: community,
      refreshWebSession: async () => { calls.push('refresh'); refreshed = true; },
      logger: { info() {}, warn() {}, error() {} } });
    t.after(() => service.stop());
    await service.sendImageMessage('76561198000000001', { img: png });
    assert.deepEqual(calls, ['begin', 'refresh', 'begin', 'PUT', 'commit']);
  });
}

test('repeated login rejection refreshes only once and never records success', async t => {
  let sends = 0, refreshes = 0, records = 0;
  const service = createChatService({ steamCommunity: {
    sendImageToUser(_id: string, _buffer: Buffer, callback: (error: Error) => void) {
      sends++; callback(Object.assign(new Error('Not Logged on.'), { eresult: 21 }));
    }
  }, refreshWebSession: async () => { refreshes++; }, historyStorage: {
    canSend: () => true, append() { records++; }, onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
  }, logger: { info() {}, warn() {}, error() {} } });
  t.after(() => service.stop());
  await assert.rejects(service.sendImageMessage('76561198000000001', { img: png }, '76561198000000002'), /Not Logged on/);
  assert.equal(sends, 2); assert.equal(refreshes, 1); assert.equal(records, 0);
});

test('image transport timeout never automatically repeats an uncertain send', async t => {
  let calls = 0;
  const service = createChatService({ steamCommunity: {
    sendImageToUser(_id: string, _buffer: Buffer, callback: (error: Error) => void) { calls++; callback(new Error('socket timeout')); }
  }, logger: { info() {}, warn() {}, error() {} } });
  t.after(() => service.stop());
  await assert.rejects(service.sendImageMessage('76561198000000001', { img: png }), /timeout/);
  assert.equal(calls, 1);
});

test('parallel expired image sessions share one refresh and retry at most once', async t => {
  let refreshes = 0, attempts = 0, refreshed = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = createChatService({ steamCommunity: {
    sendImageToUser(_id: string, _buffer: Buffer, callback: (error: unknown, result?: string) => void) {
      attempts++;
      if (!refreshed) callback(Object.assign(new Error('Not Logged on.'), { eresult: 21 }));
      else callback(null, 'https://images.steamusercontent.com/test.png');
    }
  }, refreshWebSession: async () => { refreshes++; await gate; refreshed = true; }, logger: { info() {}, warn() {}, error() {} } });
  t.after(() => service.stop());
  const first = service.sendImageMessage('76561198000000001', { img: png });
  const second = service.sendImageMessage('76561198000000001', { img: png });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(refreshes, 1);
  release(); await Promise.all([first, second]);
  assert.equal(attempts, 4);
});
