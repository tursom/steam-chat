import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { createChatService } = require('../src/server/chat-service');

async function fixture(t: any, enabled = true) {
  const calls: Array<{ body: string; headers: Record<string, unknown>; url: string }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ body: Buffer.concat(chunks).toString(), headers: req.headers, url: req.url! });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const service = createChatService({ deploymentWebhookUrl: enabled ? `http://127.0.0.1:${(upstream.address() as any).port}/deploy` : '',
    chatConfig: { host: '127.0.0.1', port: 0, auth: { username: 'test', password: 'secret' } },
    logger: { info() {}, warn() {}, error() {} } });
  service.start();
  await once(service.server, 'listening');
  t.after(async () => { await service.stop(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const headers = { 'X-Deploy-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Deploy-Signature': 'a'.repeat(64) };
  return { calls, base, headers };
}

test('deployment relay preserves signed bytes without chat authentication or arbitrary target selection', async t => {
  const f = await fixture(t);
  const body = '{ "image": "example", "run_number": 12 }\n';
  const response = await fetch(f.base + '/api/deploy?target=http://other.test', { method: 'POST', headers: f.headers, body });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'accepted' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body, body);
  assert.equal(f.calls[0].url, '/deploy');
  assert.equal(f.calls[0].headers['x-deploy-signature'], f.headers['X-Deploy-Signature']);
  assert.equal(f.calls[0].headers.authorization, undefined);
});

test('deployment relay rejects missing signatures, stale requests, oversized bodies and non-POST methods', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/deploy', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(f.base + '/api/deploy', { method: 'POST', headers: { ...f.headers, 'X-Deploy-Timestamp': '1000000000' }, body: '{}' })).status, 401);
  assert.equal((await fetch(f.base + '/api/deploy', { method: 'POST', headers: f.headers, body: 'x'.repeat(4097) })).status, 413);
  assert.equal((await fetch(f.base + '/api/deploy')).status, 405);
  assert.equal(f.calls.length, 0);
});

test('deployment relay is disabled without explicit host configuration', async t => {
  const f = await fixture(t, false);
  assert.equal((await fetch(f.base + '/api/deploy', { method: 'POST', headers: f.headers, body: '{}' })).status, 404);
  assert.equal(f.calls.length, 0);
});
