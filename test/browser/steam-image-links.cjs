// Build first. Uses real local auth and image proxy; HTTP history and WS events are fixtures.
// STEAM_IMAGE_FIXTURE_URLS='["https://images.steamusercontent.com/ugc/.../", "..."]'
// optionally verifies two real resources. Defaults mock all external image requests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const account = '76561198000000009', peer = '76561198000000001';
const fixtures = process.env.STEAM_IMAGE_FIXTURE_URLS ? JSON.parse(process.env.STEAM_IMAGE_FIXTURE_URLS) : [
  'https://images.steamusercontent.com/ugc/13625097894513798381/0123456789ABCDEF0123456789ABCDEF01234567/',
  'https://images.steamusercontent.com/ugc/13627318694928895524/FEDCBA9876543210FEDCBA9876543210FEDCBA98/'
];
const broken = 'https://images.steamusercontent.com/ugc/123/0000000000000000000000000000000000000000/';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

(async () => {
  assert.equal(fixtures.length, 2);
  for (const url of fixtures) assert.match(url, /^https:\/\/images\.steamusercontent\.com\/ugc\/\d+\/[A-Fa-f0-9]{40}\/$/);
  const dir = await mkdtemp(join(tmpdir(), 'steam-image-links-'));
  process.env.STEAM_CHAT_DATA_DIR = dir;
  const { createAuthStore } = require('../../dist/src/auth/store');
  const { createSessionManager } = require('../../dist/src/auth/session');
  const { createChatService } = require('../../dist/src/server/chat-service');
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const user = auth.createInitialAdmin({ username: 'image-test', password: 'password123' });
  const active = auth.upsertSteamAccount({ steamId: account, setActive: true });
  const sessions = createSessionManager({ store: auth });
  const service = createChatService({ authStore: auth, sessionManager: sessions,
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account, activeAccount: active }), ensureOnline() {} },
    chatConfig: { host: '127.0.0.1', port: 0 }, logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, options) => {
      if (String(url) === broken) return new Response('', { status: 404 });
      assert.ok(fixtures.includes(String(url)), 'Only declared image fixtures may be downloaded');
      return process.env.STEAM_IMAGE_FIXTURE_URLS ? fetch(url, options) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
    } });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    service.start(); await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const cookie = sessions.createSetCookie(user).split(';')[0], separator = cookie.indexOf('=');
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
        const page = await context.newPage(); const errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
        let socket;
        await page.routeWebSocket(/.*/, connection => {
          socket = connection;
          connection.onMessage(raw => { if (JSON.parse(String(raw)).type === 'ping') connection.send(JSON.stringify({ type: 'pong' })); });
        });
        await page.addInitScript(peer => {
          localStorage.setItem('steam-chat.view', 'chat'); localStorage.setItem('steam-chat.target', peer);
        }, peer);
        const history = fixtures.map((message, index) => ({ id: peer, steamAccountId: account, type: 'message', message,
          eventId: `history-${index}`, echo: false, sentAt: new Date(1700000000000 + index * 1000).toISOString() }));
        const replies = {
          '/api/conversations': { items: [{ id: peer, name: 'Image regression' }] },
          '/api/history': { items: history }, '/api/history/status': {}, '/api/friends': [], '/api/groups': [],
          '/api/emoticons': {}, '/api/message-reactions': { items: [] }
        };
        await page.route('**/api/**', route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api/messages/sync') return route.fulfill({ json: { items: [], steamAccountId: account,
            nextCursor: 'fixture', liveCursor: 'fixture', hasMore: false } });
          return Object.hasOwn(replies, url.pathname) ? route.fulfill({ json: replies[url.pathname] }) : route.continue();
        });
        await page.goto(base); await page.locator('.list-item').first().click();
        for (const [index, url] of fixtures.entries()) {
          const row = page.locator(`[data-event-id="history-${index}"]`);
          const image = row.locator('.bbcode-image'); await image.scrollIntoViewIfNeeded();
          await image.evaluate(node => node.decode());
          assert.equal(await image.getAttribute('src'), `/proxy/image?url=${encodeURIComponent(url)}`);
          assert.equal(await row.locator('.message-content a').count(), 0);
          assert.ok(await image.evaluate(node => node.naturalWidth > 0 && node.naturalHeight > 0));
          const bounds = await image.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          await row.getByRole('button', { name: '查看大图' }).click();
          await page.locator('#lightboxImage').evaluate(node => node.decode());
          assert.equal(await page.locator('#lightboxImage').getAttribute('src'), `/proxy/image?url=${encodeURIComponent(url)}`);
          await page.locator('#lightboxClose').click();
        }
        socket.send(JSON.stringify({ ...history[0], eventId: 'live-image', type: 'message', sentAt: new Date().toISOString() }));
        const live = page.locator('[data-event-id="live-image"] .bbcode-image'); await live.scrollIntoViewIfNeeded(); await live.evaluate(node => node.decode());
        socket.send(JSON.stringify({ ...history[0], eventId: 'broken-image', type: 'message', message: broken, sentAt: new Date().toISOString() }));
        const failed = page.locator('[data-event-id="broken-image"]'); await failed.scrollIntoViewIfNeeded();
        await failed.locator('.bbcode-image-fallback').waitFor(); assert.equal(await failed.locator('a').getAttribute('href'), broken);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        console.log(`PASS ${width}px: two ${process.env.STEAM_IMAGE_FIXTURE_URLS ? 'real' : 'fixture'} PNGs decoded through authenticated image proxy, text history and WS images, lightbox, failed-image link and responsive layout`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
