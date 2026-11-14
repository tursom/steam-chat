// Build first. Real auth/HTTP/WS and steamcommunity SDK; only its request boundary
// is faked. Native FileReaders are gated to deterministically reverse uploads.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const SteamCommunity = require('steamcommunity');
const { createAuthStore } = require('../../dist/src/auth/store');
const { createSessionManager } = require('../../dist/src/auth/session');
const { createHistoryStorage } = require('../../dist/src/storage/history-storage');
const { createChatService } = require('../../dist/src/server/chat-service');
const account = '76561198000000009', otherAccount = '76561198000000008', peer = '76561198000000001';
const quiet = { info() {}, warn() {}, error() {} };
const sha = buffer => createHash('sha1').update(buffer).digest('hex');
async function until(check, label) {
  for (let n = 0; n < 1000; n++) { if (await check()) return; await delay(5); }
  assert.fail(`Timed out: ${label}`);
}

async function run(browser, width) {
  const dir = await mkdtemp(join(tmpdir(), 'image-batch-browser-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const user = auth.createInitialAdmin({ username: 'batch-test', password: 'password123' });
  const firstAccount = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const secondAccount = auth.upsertSteamAccount({ steamId: otherAccount });
  let activeAccount = account;
  const sessions = createSessionManager({ store: auth });
  const storage = createHistoryStorage({ dbPath: join(dir, 'db'), logPath: join(dir, 'chat.jsonl'), logger: quiet });
  const community = new SteamCommunity(); community.getSessionID = () => 'fixture';
  const begins = [], puts = [], commits = [], modes = new Map(), held = new Map();
  community.request = (options, reply) => {
    const hash = options.method === 'PUT' ? sha(options.body) : options.formData.file_sha;
    const mode = modes.get(hash);
    if (options.uri.includes('beginfileupload')) {
      begins.push(hash);
      if (mode === 'failed') return reply(null, { statusCode: 500, headers: {} }, { success: 16 });
      return reply(null, { statusCode: 200, headers: {} }, { success: 1, hmac: 'fixture', timestamp: 1,
        result: { ugcid: hash, url_host: 'upload.invalid', url_path: `/${hash}`, request_headers: [], use_https: true } });
    }
    if (options.method === 'PUT') {
      puts.push(hash);
      const finish = () => reply(null, { statusCode: 200, headers: {} }, '');
      if (mode === 'hold-put') { held.set(hash, finish); return; }
      return finish();
    }
    assert.ok(options.uri.includes('commitfileupload'), options.uri);
    commits.push(hash);
    if (mode === 'unknown') return reply(null, { statusCode: 200, headers: {} }, { success: 16 });
    const finish = () => reply(null, { statusCode: 200, headers: {} }, { success: 1, result: { success: 1,
      details: { url: `https://images.steamusercontent.com/ugc/123/${sha(`${hash}-${commits.length}`)}/` } } });
    if (mode === 'hold-commit') { held.set(hash, finish); return; }
    finish();
  };
  const service = createChatService({ authStore: auth, sessionManager: sessions, historyStorage: storage, steamCommunity: community,
    imageEmoteDir: join(dir, 'emotes'), chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: activeAccount }), ensureOnline() {},
      connectWithRefreshToken: (_token, id) => { activeAccount = id; return { status: 'online', steamId: id }; } },
    getEmoticons: async () => ({}), sendOperationOptions: { tickMs: 10, maxAttempts: 1 } });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    await until(() => storage.canSend(), 'storage');
    storage.append({ steamAccountId: account, id: peer, name: 'Batch order', eventId: '1'.repeat(32),
      message: 'Batch order regression', sentAt: '2026-01-01T00:00:00Z' });
    await until(() => storage.status().rocksdb.durable >= 1, 'seed history');
    service.start(); await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const cookie = sessions.createSetCookie(user).split(';')[0], separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
    const page = await context.newPage(), errors = [], starts = [], batchRequests = [], wsOperations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const text = String(frame.payload); if (text.includes('send_operation')) wsOperations.push(text);
    }));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/send-operations/batch') batchRequests.push(request.postDataJSON());
      if (request.method() === 'POST' && /\/api\/send-operations\/.+\/start$/.test(path)) starts.push(path.split('/')[3]);
      assert.notEqual(path, '/api/send-operations/upload', 'batches must activate reserved IDs');
      assert.notEqual(path, '/image', 'no legacy fallback');
    });
    await page.addInitScript(peer => {
      localStorage.setItem('steam-chat.view', 'chat'); localStorage.setItem('steam-chat.target', peer);
      window.imageReads = [];
      const NativeReader = window.FileReader;
      window.FileReader = class extends NativeReader {
        readAsDataURL(file) { window.imageReads.push(() => super.readAsDataURL(file)); }
      };
    }, peer);
    await page.goto(base); await page.locator('.list-item').first().click();
    const images = (await page.evaluate(() => ['#73bda5', '#ba735a', '#536abc'].map(color => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 24, 16);
      return canvas.toDataURL('image/png').split(',')[1];
    }))).map(value => Buffer.from(value, 'base64'));
    const hashes = images.map(sha);
    // Only image display is stubbed; every send-operation request reaches the server.
    await page.route('**/proxy/image?**', route => route.fulfill({ body: images[0], contentType: 'image/png' }));
    const row = id => page.locator(`[data-operation-id="${id}"]`);
    const operation = async id => {
      const response = await context.request.get(`${base}/api/send-operations/${id}`);
      assert.equal(response.status(), 200); return response.json();
    };
    const release = hash => { const finish = held.get(hash); assert.ok(finish); held.delete(hash); finish(); };
    async function batch(count, label) {
      const before = starts.length;
      await page.evaluate(() => { window.imageReads = []; });
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/send-operations/batch');
      await page.locator('input[type="file"]').setInputFiles(images.slice(0, count).map((buffer, i) => ({
        name: `${label}-${i}.png`, mimeType: 'image/png', buffer
      })));
      const response = await responsePromise; assert.equal(response.status(), 201);
      const result = await response.json();
      const ids = result.operations.map(op => op.id);
      assert.deepEqual(result.operations.map(op => op.batchIndex), Array.from({ length: count }, (_, i) => i));
      assert.ok(result.operations.every(op => op.batchId === result.batchId && op.batchSize === count && op.state === 'prepared'));
      await page.waitForFunction(count => window.imageReads.length === count, count);
      assert.equal(starts.length, before, 'registration does not upload unread images');
      assert.deepEqual(await page.locator('#messages [data-operation-id]').evaluateAll((nodes, ids) =>
        nodes.map(node => node.dataset.operationId).filter(id => ids.includes(id)), ids), ids);
      for (let i = count - 1; i >= 0; i--) {
        const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === `/api/send-operations/${ids[i]}/start`);
        await page.evaluate(i => window.imageReads[i](), i);
        assert.equal((await uploaded).status(), 202);
        if (i > 0) assert.equal((await operation(ids[i])).waitingForOperationId, ids[0]);
      }
      assert.deepEqual(starts.slice(before), [...ids].reverse());
      return ids;
    }
    async function sent(ids) {
      await until(async () => (await Promise.all(ids.map(operation))).every(op => op.state === 'sent'), 'sent operations');
      for (const id of ids) await row(id).waitFor({ state: 'detached' });
    }

    modes.set(hashes[0], 'hold-commit');
    const ordered = await batch(3, 'order');
    await until(() => held.has(hashes[0]), 'head commit');
    assert.deepEqual(begins, [hashes[0]]); assert.deepEqual(puts, [hashes[0]]); assert.deepEqual(commits, [hashes[0]]);
    await row(ordered[1]).getByText('等待前一张图片确认…', { exact: true }).waitFor();
    release(hashes[0]); await sent(ordered);
    assert.deepEqual(commits, hashes); assert.deepEqual(puts, hashes);

    modes.set(hashes[0], 'failed');
    const failed = await batch(2, 'retry');
    await row(failed[0]).getByRole('button', { name: '重试发送', exact: true }).waitFor();
    assert.equal((await operation(failed[1])).state, 'queued'); assert.equal(commits.length, 3);
    modes.delete(hashes[0]);
    await row(failed[0]).getByRole('button', { name: '重试发送', exact: true }).click();
    await sent(failed); assert.deepEqual(commits.slice(3), hashes.slice(0, 2));

    // Stop must reach the server even while /start has not finished uploading.
    const uploadReply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/send-operations/batch');
    await page.evaluate(() => { window.imageReads = []; });
    await page.locator('input[type="file"]').setInputFiles(images.slice(0, 2).map((buffer, i) => ({
      name: `cancel-start-${i}.png`, mimeType: 'image/png', buffer
    })));
    const uploadIds = (await (await uploadReply).json()).operations.map(op => op.id);
    await page.waitForFunction(() => window.imageReads.length === 2);
    let heldStart;
    const startUrl = `${base}/api/send-operations/${uploadIds[0]}/start`;
    await page.route(startUrl, route => { heldStart = route; });
    const beforeStartCancel = commits.length;
    await page.evaluate(() => window.imageReads[0]());
    await until(() => heldStart, 'pending browser start upload');
    await row(uploadIds[0]).getByRole('button', { name: '停止重试', exact: true }).click();
    await until(async () => (await operation(uploadIds[0])).state === 'cancelled', 'cancel during start upload');
    const rejectedStart = page.waitForResponse(response => response.url() === startUrl);
    await heldStart.continue(); assert.equal((await rejectedStart).status(), 409);
    await page.unroute(startUrl);
    assert.equal(commits.length, beforeStartCancel, 'the stopped head cannot reach Steam');
    await page.evaluate(() => window.imageReads[1]()); await sent([uploadIds[1]]);
    assert.deepEqual(commits.slice(beforeStartCancel), [hashes[1]]);

    modes.set(hashes[0], 'hold-put');
    const cancelled = await batch(2, 'cancel');
    await until(() => held.has(hashes[0]), 'head PUT');
    const beforeCancel = commits.length, beforeDrain = begins.length;
    await row(cancelled[0]).getByRole('button', { name: '停止重试', exact: true }).click();
    await until(async () => (await operation(cancelled[0])).state === 'cancelled', 'cancel acknowledged');
    await delay(80); // Several manager ticks must not bypass the outstanding SDK callback.
    assert.equal((await operation(cancelled[1])).state, 'queued');
    assert.equal(begins.length, beforeDrain); assert.equal(commits.length, beforeCancel);
    modes.delete(hashes[0]); release(hashes[0]); await sent([cancelled[1]]);
    assert.deepEqual(commits.slice(beforeCancel), [hashes[1]], 'cancelled head never commits after PUT drains');
    modes.set(hashes[0], 'unknown');
    const unknown = await batch(2, 'unknown');
    await row(unknown[0]).getByRole('button', { name: '检查发送结果' }).waitFor();
    const startCount = starts.length, batchCount = batchRequests.length, commitCount = commits.length;
    await row(unknown[0]).getByRole('button', { name: '检查发送结果' }).click();
    await page.reload();
    await row(unknown[0]).getByRole('button', { name: '检查发送结果' }).waitFor();
    await row(unknown[1]).getByText('等待前一张图片确认…', { exact: true }).waitFor();
    assert.equal((await operation(unknown[0])).state, 'unknown');
    assert.equal((await operation(unknown[1])).state, 'queued');
    const metadata = await page.evaluate(() => sessionStorage.getItem('steam-chat.send-operations.1.76561198000000009'));
    assert.doesNotMatch(metadata || '', /base64|data:image|unknown-0\.png/);
    for (const target of [secondAccount, firstAccount]) {
      const response = await context.request.post(`${base}/api/steam/accounts/${target.id}/connect`, { data: {} });
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).steamId, target.steamId);
      await page.reload();
      await page.locator('#messageInput').waitFor({ state: 'attached' });
    }
    await row(unknown[0]).getByRole('button', { name: '检查发送结果' }).waitFor();
    assert.equal(starts.length, startCount); assert.equal(batchRequests.length, batchCount); assert.equal(commits.length, commitCount);
    assert.ok(wsOperations.length > 0, 'operation updates traversed a real WebSocket');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: reverse reads/uploads, ordered commits, failed retry, cancel drains transport, unknown blocks tail, account switch/reload never resend`);
  } finally {
    modes.clear(); for (const finish of held.values()) finish(); held.clear();
    await context.close(); await service.stop(); await storage.close(); auth.close(); await rm(dir, { recursive: true, force: true });
  }
}
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try { for (const width of [1440, 390]) await run(browser, width); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
