// Build first; requires Playwright Chromium. Real local auth, HTTP, WS and dual
// history storage. Only Steam's network responses and external player are mocked.
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
const account = '76561198000000009', peer = '76561198000000001';
const quiet = { info() {}, warn() {}, error() {} };
async function until(check) { for (let n = 0; n < 1000; n++) { if (check()) return; await delay(5); } assert.fail('Timed out'); }

async function run(browser, width) {
  const dir = await mkdtemp(join(tmpdir(), 'image-operation-browser-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const user = auth.createInitialAdmin({ username: 'send-test', password: 'password123' });
  auth.upsertSteamAccount({ steamId: account, setActive: true });
  const sessions = createSessionManager({ store: auth });
  const storage = createHistoryStorage({ dbPath: join(dir, 'db'), logPath: join(dir, 'chat.jsonl'), logger: quiet });
  const community = new SteamCommunity(); community.getSessionID = () => 'fixture';
  let mode = 'recover', begins = 0, puts = 0, commits = 0, held, committed = 0;
  let original;
  community.request = (options, reply) => {
    if (options.uri.includes('beginfileupload')) {
      begins++;
      if (mode === 'exhaust' || (mode === 'recover' && begins <= 2)) return reply(null, { statusCode: 500, headers: {} }, { success: 16, message: 'A server error occurred. (16)' });
      return reply(null, { statusCode: 200, headers: {} }, { success: 1, hmac: 'fixture', timestamp: 1,
        result: { ugcid: '1', url_host: 'upload.invalid', url_path: '/image', request_headers: [], use_https: true } });
    }
    if (options.method === 'PUT') {
      puts++; assert.deepEqual(options.body, original);
      if (mode === 'hold-upload') { held = reply; return; }
      return reply(null, { statusCode: 200, headers: {} }, '');
    }
    commits++;
    if (mode === 'uncertain') return reply(null, { statusCode: 200, headers: {} }, { success: 16 });
    const complete = () => {
      committed++;
      const hash = createHash('sha1').update(String(committed)).digest('hex');
      reply(null, { statusCode: 200, headers: {} }, { success: 1, result: { success: 1,
        details: { url: `https://images.steamusercontent.com/ugc/123/${hash}/` } } });
    };
    if (mode === 'hold-commit') { held = complete; return; } complete();
  };
  const service = createChatService({ authStore: auth, sessionManager: sessions, historyStorage: storage, steamCommunity: community,
    imageEmoteDir: join(dir, 'emotes'), chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} },
    getEmoticons: async () => ({}), sendOperationOptions: { tickMs: 10, delaysMs: [50, 70, 90, 110, 130], random: () => 0.5 } });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    await until(() => storage.canSend()); storage.append({ steamAccountId: account, id: peer, name: 'Retry regression',
      eventId: '1'.repeat(32), message: 'https://music.163.com/song?id=347230', sentAt: '2026-01-01T00:00:00Z' });
    await until(() => storage.status().rocksdb.durable >= 1);
    service.start(); await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const cookie = sessions.createSetCookie(user).split(';')[0], separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
    const page = await context.newPage(), errors = [], created = [], starts = [];
    let loseStartReply = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => { if (new URL(response.url()).pathname === '/api/send-operations' && response.status() === 201) created.push((await response.json()).id); });
    page.on('request', request => { if (/\/start$/.test(new URL(request.url()).pathname)) starts.push(request.url()); });
    await page.addInitScript(peer => { localStorage.setItem('steam-chat.view', 'chat'); localStorage.setItem('steam-chat.target', peer); }, peer);
    await page.route('https://music.163.com/outchain/player**', route => route.fulfill({ contentType: 'text/html', body: '<script>window.marker="playing"</script>' }));
    await page.route('**/proxy/image?**', route => route.fulfill({ body: original, contentType: 'image/png' }));
    await page.route('**/api/send-operations/*/start', async route => {
      if (!loseStartReply) return route.continue();
      loseStartReply = false;
      await route.fetch(); // The server has accepted the task; only the reply is lost.
      await route.abort('failed');
    });
    await page.goto(base); await page.locator('.list-item').first().click();
    original = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#73bda5'; ctx.fillRect(0, 0, 240, 160);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    const send = name => page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: original });
    const row = id => page.locator(`[data-operation-id="${id}"]`);
    await page.getByRole('button', { name: '♫ 播放网易云音乐' }).click();
    const frame = await (await page.locator('.netease-player iframe').elementHandle()).contentFrame(); await frame.waitForFunction(() => window.marker === 'playing');
    await send('recover.png'); await until(() => created.length === 1);
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row[data-event-id]').length === 2);
    assert.equal(begins, 3); assert.equal(puts, 1); assert.equal(commits, 1); assert.equal(await row(created[0]).count(), 0);
    assert.equal(await frame.evaluate(() => window.marker), 'playing');
    mode = 'exhaust'; await send('exhaust.png'); await until(() => created.length === 2);
    await row(created[1]).getByRole('button', { name: '重试发送', exact: true }).waitFor();
    const localId = await row(created[1]).getAttribute('data-outgoing-id');
    mode = 'success'; await row(created[1]).getByRole('button', { name: '重试发送', exact: true }).dblclick();
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row[data-event-id]').length === 3);
    assert.equal(created.length, 2); assert.equal(commits, 2); assert.equal(await page.locator(`[data-outgoing-id="${localId}"]`).count(), 0);
    assert.equal(await frame.evaluate(() => window.marker), 'playing');
    mode = 'hold-commit'; held = undefined; loseStartReply = true; await send('pending.png'); await until(() => Boolean(held) && created.length === 3);
    await row(created[2]).getByRole('button', { name: '停止等待', exact: true }).click();
    await row(created[2]).getByRole('button', { name: '检查发送结果' }).waitFor();
    const postCount = starts.length; await page.reload();
    await row(created[2]).getByRole('button', { name: '检查发送结果' }).waitFor();
    assert.equal(starts.length, postCount);
    const metadata = await page.evaluate(() => sessionStorage.getItem(`steam-chat.send-operations.${1}.${'76561198000000009'}`));
    assert.doesNotMatch(metadata || '', /base64|data:image|img|pending\.png/);
    held(); held = undefined;
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row[data-event-id]').length === 4);
    assert.equal(await row(created[2]).count(), 0);
    mode = 'uncertain'; await send('unknown.png'); await until(() => created.length === 4);
    await row(created[3]).getByRole('button', { name: '仍要发送一份' }).waitFor();
    const before = commits; await row(created[3]).getByRole('button', { name: '检查发送结果' }).click(); await page.waitForTimeout(100);
    assert.equal(commits, before);
    mode = 'success'; await row(created[3]).getByRole('button', { name: '仍要发送一份' }).click(); await until(() => created.length === 5);
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row[data-event-id]').length === 5);
    assert.equal(await row(created[3]).count(), 1); assert.equal(committed, 4);
    mode = 'hold-upload'; held = undefined; await send('cancel.png'); await until(() => Boolean(held) && created.length === 6);
    await row(created[5]).getByRole('button', { name: '停止重试', exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-operation-id="${id}"]`)?.dataset.sendState === 'failed', created[5]);
    const commitCount = commits; held(null, { statusCode: 200, headers: {} }, ''); held = undefined; await page.waitForTimeout(100);
    assert.equal(commits, commitCount);
    await page.route(`**/api/send-operations/${created[3]}`, route => route.fulfill({ status: 410, json: { error: 'State lost' } }));
    const startedBeforeReload = starts.length; await page.reload();
    await row(created[3]).getByText('原发送状态已失效，请检查聊天记录。').waitFor();
    assert.equal(starts.length, startedBeforeReload);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: auto recovery, manual same-task retry, reload without resend, late commit success, explicit new copy, cancel before commit, expired state and player preserved`);
  } finally {
    if (held) { mode = 'success'; held(null, { statusCode: 200, headers: {} }, ''); }
    await context.close(); await service.stop(); await storage.close(); auth.close(); await rm(dir, { recursive: true, force: true });
  }
}
(async () => { const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try { for (const width of [1440, 390]) await run(browser, width); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
