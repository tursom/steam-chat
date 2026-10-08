// npm run build; NODE_PATH=<Playwright modules> node test/browser/sleep-recovery.cjs
// Real local HTTP/auth/WebSocket/JSONL/RocksDB; no Steam login or real messages.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createAuthStore } = require('../../dist/src/auth/store');
const { createSessionManager } = require('../../dist/src/auth/session');
const { createChatService } = require('../../dist/src/server/chat-service');
const { createHistoryStorage } = require('../../dist/src/storage/history-storage');
const account = '76561198000000009', peer = '76561198000000001', other = '76561198000000002';
const quiet = { info() {}, warn() {}, error() {} };
const eventId = label => createHash('sha256').update(label).digest('hex').slice(0, 32);

async function until(predicate) {
  for (let n = 0; n < 1500; n++) { if (predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for local durable storage');
}

async function run(width, browser) {
  const dir = await mkdtemp(join(tmpdir(), 'steam-chat-sleep-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const user = auth.createInitialAdmin({ username: 'local-test', password: 'password123' });
  const active = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const sessions = createSessionManager({ store: auth });
  const storage = createHistoryStorage({ dbPath: join(dir, 'db'), logPath: join(dir, 'chat.jsonl'), logger: quiet });
  const service = createChatService({ authStore: auth, sessionManager: sessions, historyStorage: storage,
    imageEmoteDir: join(dir, 'image-emotes'), chatConfig: { host: '127.0.0.1', port: 0 }, logger: quiet,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account, activeAccount: active }), ensureOnline() {} },
    getEmoticons: async () => ({ emoticons: [], stickers: [] }) });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  let cdp;
  try {
    service.start(); await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const cookie = sessions.createSetCookie(user).split(';')[0];
    await context.addCookies([{ name: cookie.slice(0, cookie.indexOf('=')), value: cookie.slice(cookie.indexOf('=') + 1), url: base }]);
    const errors = [], requests = [], livePages = [], notifications = [], writes = [];
    let failNextLivePage = false, failedCursor = '';
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.addInitScript(peer => {
      localStorage.setItem('steam-chat.view', 'chat'); localStorage.setItem('steam-chat.target', peer);
      localStorage.setItem('steam-chat.desktop-notifications', 'true');
      window.recoveryAlerts = [];
      window.Notification = class { static permission = 'granted'; constructor() { window.recoveryAlerts.push('notification'); } close() {} };
      window.Audio = class { pause() {} async play() { window.recoveryAlerts.push('sound'); } };
    }, peer);
    await page.route('https://player.bilibili.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<script>window.playbackMarker="initial"</script><p>Playback fixture</p>' }));
    await page.route('**/api/messages/sync?**', async route => {
      const url = new URL(route.request().url()); requests.push(url);
      if (!url.searchParams.has('mode') && failNextLivePage) {
        failNextLivePage = false; failedCursor = url.searchParams.get('cursor');
        return route.fulfill({ status: 503, json: { error: 'One interrupted catch-up page' } });
      }
      const response = await route.fetch();
      if (response.ok() && !url.searchParams.has('mode')) livePages.push(await response.json());
      return route.fulfill({ response });
    });
    const record = (label, n, extra = {}) => ({ id: peer, steamAccountId: account, eventId: eventId(label), name: 'Local peer',
      type: 'message', message: `Message ${n}`, sentAt: new Date(1700000000000 + n * 1000).toISOString(), ...extra });
    await until(() => storage.canSend());
    for (let n = 0; n < 25; n++) storage.append(record(`start-${n}`, n, n === 0 ? { message: 'https://www.bilibili.com/video/BV1xx411c7mD' } : {}));
    await until(() => storage.status().rocksdb.durable === 25 && storage.status().jsonl.durable === 25);
    await page.goto(base); await page.locator('.list-item').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 25);
    await until(() => livePages.length > 0);
    const seedCursor = livePages.at(-1).nextCursor;
    assert.equal(livePages.at(-1).items.length, 0);
    const row = label => page.locator(`[data-event-id="${eventId(label)}"]`);
    const playerCard = row('start-0').locator('.bilibili-player');
    await playerCard.getByRole('button', { name: '▶ 播放 B 站视频' }).click();
    const iframe = await playerCard.locator('iframe').elementHandle();
    const frame = await iframe.contentFrame();
    await frame.waitForFunction(() => window.playbackMarker === 'initial');
    await frame.evaluate(() => window.playbackMarker = 'playing-at-42s');
    await page.locator('#messages').hover(); await page.mouse.wheel(0, -600);
    await page.waitForTimeout(100);
    const top = await page.locator('#messages').evaluate(node => node.scrollTop);
    const alertsBefore = await page.evaluate(() => window.recoveryAlerts.length);
    cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    // The browser cannot consume traffic while frozen; the server keeps receiving and archiving.
    for (const ws of service.clients) ws.terminate();
    for (let n = 1; n <= 620; n++) storage.append(record(`sleep-${n}`, 25 + n, { message: 'Repeated message' }));
    storage.append(record('other-peer', 646, { id: other, name: 'Other peer' }));
    storage.append(record('late-arrival', -1));
    storage.append(record('other-account', 647, { steamAccountId: other }));
    await until(() => storage.status().rocksdb.durable === 648 && storage.status().jsonl.durable === 648);
    const log = (await readFile(join(dir, 'chat.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log.length, 648);
    const first = await storage.sync({ steamAccountId: account, cursor: seedCursor, limit: 500 });
    const last = await storage.sync({ steamAccountId: account, cursor: first.nextCursor, limit: 500 });
    assert.equal(first.items.length + last.items.length, 622); assert.equal(last.hasMore, false);
    assert.equal(storage.status().rocksdb.missed, 0); assert.equal(storage.status().jsonl.missed, 0);
    // A temporary page failure must not discard the last committed arrival cursor.
    failNextLivePage = true;
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row').length === 646, null, { timeout: 25000 });
    assert.ok(failedCursor); assert.ok(requests.filter(url => url.searchParams.get('cursor') === failedCursor).length >= 2);
    assert.equal(requests.filter(url => url.searchParams.get('mode') === 'history').length, 1, 'Wake preserves the established live boundary');
    assert.ok(livePages.some(result => result.items.length === 100 && result.hasMore));
    const ids = await page.locator('#messages .msg-row').evaluateAll(rows => rows.map(row => row.dataset.eventId));
    assert.equal(new Set(ids).size, 646); assert.equal(ids[0], eventId('late-arrival')); assert.equal(ids.includes(eventId('other-account')), false);
    assert.equal(await page.locator('#messages').evaluate(node => node.scrollTop), top);
    assert.equal(await iframe.evaluate(node => node.isConnected), true);
    assert.equal(await frame.evaluate(() => window.playbackMarker), 'playing-at-42s');
    notifications.push(...await page.evaluate(() => window.recoveryAlerts)); assert.equal(notifications.length, alertsBefore);
    assert.ok(await page.locator('.list-item').filter({ hasText: 'Other peer' }).count());
    // Live broadcast overlapping a durable hint is still exactly one timeline row.
    storage.append(record('overlap', 648));
    await row('overlap').waitFor();
    await until(() => storage.status().rocksdb.durable === 649);
    await page.waitForTimeout(150);
    assert.equal(await row('overlap').count(), 1);
    assert.equal(await frame.evaluate(() => window.playbackMarker), 'playing-at-42s');
    // Catch-up must not pull the reader out of a selected date window.
    await page.locator('#historyDate').fill('2023-11-14T22:15'); await page.locator('#historyJump').click();
    await page.waitForFunction(() => !document.querySelector('#historyLatest').hidden);
    const dateIds = await page.locator('#messages .msg-row').evaluateAll(rows => rows.map(row => row.dataset.eventId));
    storage.append(record('while-reading-date', 649), { notify: false });
    await until(() => storage.status().rocksdb.durable === 650);
    await until(() => livePages.some(result => result.items.some(item => item.eventId === eventId('while-reading-date'))));
    assert.deepEqual(await page.locator('#messages .msg-row').evaluateAll(rows => rows.map(row => row.dataset.eventId)), dateIds);
    assert.equal(await page.locator('#historyLatest').isVisible(), true);
    await page.locator('#historyLatest').click(); await row('while-reading-date').waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`PASS ${width}px: frozen browser, 622 durable arrivals, all pages, interrupted request retry, account isolation, no duplicates/alerts, reading position and iframe preserved, date view`);
  } finally {
    if (cdp) await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await context.close(); await service.stop(); await storage.close(); auth.close(); await rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try { for (const width of [1440, 390]) await run(width, browser); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
