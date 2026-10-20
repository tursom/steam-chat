import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sendSteamImage, ImageUploadPhase } from '../src/server/image-upload';
const SteamCommunity = require('steamcommunity');
const { createChatService } = require('../src/server/chat-service');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const peer = '76561198000000001';
const image = 'https://images.steamusercontent.com/ugc/123/0123456789ABCDEF0123456789ABCDEF01234567/';
type Complete = (error: unknown, response?: unknown, body?: unknown) => void;

function fixture(onRequest: (phase: ImageUploadPhase, complete: Complete) => boolean = () => false) {
  const community = new SteamCommunity();
  const calls: string[] = [], waits: number[] = [], logs: string[] = [];
  let authorizations = 0;
  community.getSessionID = () => 'PRIVATE_SESSION';
  // Exercise the installed SDK's real HTTP/error-processing methods. Nothing
  // reaches Steam; only its lowest-level request transport is replaced.
  community.request = (options: { uri: string; method: string }, complete: Complete) => {
    const phase = options.uri.includes('beginfileupload') ? 'begin' : options.uri.includes('commitfileupload') ? 'commit' : 'upload';
    calls.push(phase);
    if (onRequest(phase, complete)) return;
    const body = phase === 'begin' ? { success: 1, hmac: 'PRIVATE_HMAC', timestamp: 1,
      result: { ugcid: '1', url_host: 'upload.invalid', url_path: '/PRIVATE_UPLOAD_URL', use_https: true,
        request_headers: [{ name: 'Authorization', value: 'PRIVATE_HEADER' }] } }
      : phase === 'commit' ? { success: 1, result: { success: 1, details: { url: image } } } : '';
    complete(null, { statusCode: 200, headers: {} }, body);
  };
  const send = (receiver: typeof community) => new Promise((resolve, reject) => {
    community.sendImageToUser.call(receiver, peer, png, {}, (error: unknown, result: unknown) => error ? reject(error) : resolve(result));
  });
  const options = { authorize() { authorizations++; }, logger: { warn(message: string) { logs.push(message); } },
    async wait(ms: number) { waits.push(ms); } };
  return { community, calls, waits, logs, send, options, authorizations: () => authorizations };
}

function timeout(complete: Complete, phase: ImageUploadPhase) {
  if (phase === 'upload') {
    complete(null, { statusCode: 200, headers: {} }, '<h1>Sorry!</h1><h3>A server error occurred. (16)</h3>');
  } else complete(null, { statusCode: phase === 'begin' ? 500 : 200, headers: {} }, { success: 16, message: 'A server error occurred. (16)' });
}

for (const phase of ['begin', 'upload'] as const) {
  test(`installed SDK ${phase} Timeout/16 safely retries with exponential delays before the only commit`, async () => {
    let failures = 0;
    const f = fixture((step, complete) => {
      if (step !== phase || failures >= 2) return false;
      failures++; timeout(complete, step); return true;
    });
    const originalPost = f.community.httpRequestPost, originalHttp = f.community.httpRequest;
    assert.equal(await sendSteamImage(f.community, f.send, f.options), image);
    assert.deepEqual(f.waits, [1000, 2000]); assert.equal(f.authorizations(), 3);
    assert.equal(f.calls.filter(step => step === 'commit').length, 1);
    assert.equal(f.community.httpRequestPost, originalPost); assert.equal(f.community.httpRequest, originalHttp);
    assert.equal(f.logs.length, 2); assert.ok(f.logs.every(line => line.includes('"eresult":16') && line.includes('"uncertain":false')));
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE_|76561198000000001|file_sha|sessionid/);
  });

  test(`installed SDK exhausted ${phase} Timeout/16 is confirmed unsent and bounded at three attempts`, async () => {
    const f = fixture((step, complete) => { if (step !== phase) return false; timeout(complete, step); return true; });
    await assert.rejects(sendSteamImage(f.community, f.send, f.options), (error: any) => {
      assert.equal(error.imageUploadPhase, phase); assert.equal(error.uncertain, false); assert.equal(error.eresult, 16);
      assert.match(error.message, /已自动重试 2 次/); return true;
    });
    assert.deepEqual(f.waits, [1000, 2000]); assert.equal(f.calls.includes('commit'), false); assert.equal(f.authorizations(), 3);
  });
}

test('installed SDK commit timeout is unknown and never replays begin, PUT or commit', async () => {
  const f = fixture((phase, complete) => { if (phase !== 'commit') return false; timeout(complete, phase); return true; });
  await assert.rejects(sendSteamImage(f.community, f.send, f.options), (error: any) => {
    assert.equal(error.uncertain, true); assert.equal(error.imageUploadPhase, 'commit'); assert.equal(error.eresult, 16);
    assert.match(error.message, /提交图片超时/); return true;
  });
  assert.deepEqual(f.calls, ['begin', 'upload', 'commit']); assert.deepEqual(f.waits, []);
});

test('transport timeout retries before commit, while an opaque custom sender fails closed', async () => {
  let failures = 0;
  const f = fixture((phase, complete) => {
    if (phase !== 'upload' || failures++) return false;
    complete(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })); return true;
  });
  assert.equal(await sendSteamImage(f.community, f.send, f.options), image); assert.deepEqual(f.waits, [1000]);
  let sends = 0;
  const custom = { sendImageToUser() {} };
  await assert.rejects(sendSteamImage(custom, async () => { sends++; throw new Error('A server error occurred. (16)'); }, f.options),
    (error: any) => error.uncertain === true && error.imageUploadPhase === 'unknown');
  assert.equal(sends, 1); assert.deepEqual(f.waits, [1000]);
});

test('permission/online/account checks run again after the delay and can stop the next attempt', async () => {
  const f = fixture((phase, complete) => { timeout(complete, phase); return true; });
  let allowed = true;
  await assert.rejects(sendSteamImage(f.community, f.send, { ...f.options,
    authorize() { if (!allowed) throw Object.assign(new Error('Account changed'), { statusCode: 409 }); },
    async wait() { allowed = false; }
  }), (error: any) => error.statusCode === 409);
  assert.deepEqual(f.calls, ['begin']);
});

test('concurrent installed SDK uploads keep independent phases without mutating shared methods', async () => {
  let heldCommit: Complete | undefined, begins = 0;
  const f = fixture((phase, complete) => {
    if (phase === 'begin' && ++begins === 2) { timeout(heldCommit!, 'commit'); heldCommit = undefined; }
    if (phase === 'commit' && begins === 1) { heldCommit = complete; return true; }
    return false;
  });
  const first = sendSteamImage(f.community, f.send, f.options);
  const rejected = assert.rejects(first, (error: any) => error.imageUploadPhase === 'commit' && error.uncertain === true);
  assert.ok(heldCommit);
  const second = sendSteamImage(f.community, f.send, f.options);
  await rejected; assert.equal(await second, image); assert.deepEqual(f.waits, []);
  assert.deepEqual(f.calls, ['begin', 'upload', 'commit', 'begin', 'upload', 'commit']);
});

for (const phase of ['begin', 'commit'] as const) {
  test(`HTTP image ${phase} error preserves certainty and does not persist a successful message`, async t => {
    const f = fixture((step, complete) => {
      if (step !== phase) return false;
      complete(null, { statusCode: 200, headers: {} }, { success: phase === 'begin' ? 9 : 16 }); return true;
    });
    let saved = 0;
    const service = createChatService({ steamCommunity: f.community, historyStorage: {
      canSend: () => true, append() { saved++; }, onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
    }, steamLoginService: { getStatus: () => ({ status: 'online', steamId: '76561198000000002' }) }, logger: f.options.logger });
    t.after(() => service.stop()); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/image`, {
      method: 'POST', body: JSON.stringify({ id: peer, img: png.toString('base64') })
    });
    assert.equal(response.status, 502);
    const body = await response.json(); assert.equal(body.imageUploadPhase, phase); assert.equal(body.uncertain, phase === 'commit');
    assert.equal(saved, 0); assert.equal(f.calls.filter(step => step === 'begin').length, 1);
  });
}

test('commit login rejection must not refresh and replay a possibly delivered upload', async t => {
  const f = fixture((phase, complete) => { if (phase !== 'commit') return false;
    complete(null, { statusCode: 200, headers: {} }, { success: 21 }); return true; });
  let refreshed = 0;
  const service = createChatService({ steamCommunity: f.community, refreshWebSession() { refreshed++; }, logger: f.options.logger });
  t.after(() => service.stop());
  await assert.rejects(service.sendImageMessage(peer, { img: png.toString('base64') }), (error: any) => error.uncertain === true);
  assert.equal(refreshed, 0); assert.deepEqual(f.calls, ['begin', 'upload', 'commit']);
});
