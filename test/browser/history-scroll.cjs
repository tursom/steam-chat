// Run after npm run build, with Playwright installed and Chromium available:
// node test/browser/history-scroll.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(process.env.STEAM_CHAT_WEB_ROOT || path.join(__dirname, '../../dist/web'));
const peer = '76561198000000001';
const steamId = '76561198000000009';
const friend = { id: peer, name: 'Scroll regression', online: true };
const steam = { status: 'online', steamId, activeAccount: { id: 1, steamId }, accessAllowed: true };
const fixtures = {
  '/api/auth/me': { user: { id: 1, username: 'Test', role: 'user' }, permissions: ['chat.use'], steam },
  '/api/steam/status': steam,
  '/api/config': { wsPath: '/ws' },
  '/api/history/status': {},
  '/api/conversations': { items: [friend] },
  '/api/friends': [friend],
  '/api/groups': [],
  '/api/emoticons': { emoticons: [], stickers: [] },
  '/api/history': { items: Array.from({ length: 30 }, (_, i) => ({ id: peer, eventId: String(i), message: `Message ${i}`, type: 'message' })) }
};

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440]) {
      for (const anchor of ['auto', 'none']) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          let socket;
          await page.routeWebSocket(/.*/, connection => { socket = connection; });
          await page.addInitScript(peer => {
            localStorage.setItem('steam-chat.view', 'chat');
            localStorage.setItem('steam-chat.target', peer);
          }, peer);
          await page.route('http://steam-chat.test/**', async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (Object.hasOwn(fixtures, pathname)) return route.fulfill({ json: fixtures[pathname] });
            const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
            try {
              const contentType = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/html';
              await route.fulfill({ body: await fs.readFile(file), contentType });
            } catch { await route.fulfill({ status: 404 }); }
          });
          await page.goto('http://steam-chat.test');
          await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 30);
          await page.locator('.list-item').first().click();
          await page.evaluate(anchor => {
            const messages = document.querySelector('#messages');
            messages.style.overflowAnchor = anchor;
            messages.firstElementChild.style.height = '500px';
          }, anchor);
          await page.waitForTimeout(100);
          // Force native anchor adjustment before ResizeObserver delivery.
          // No wheel, touch, or explicit scroll-position change occurs here.
          await page.evaluate(() => {
            const messages = document.querySelector('#messages');
            messages.firstElementChild.style.height = '';
            messages.children[27].style.height = '300px';
            void messages.scrollHeight;
          });
          await page.waitForTimeout(200);
          const snapshot = () => page.locator('#messages').evaluate(messages => {
            const bottom = messages.getBoundingClientRect().bottom;
            return {
              gap: messages.scrollHeight - messages.clientHeight - messages.scrollTop,
              lastTwoVisible: [...messages.children].slice(-2).every(row => row.getBoundingClientRect().bottom <= bottom),
              top: messages.scrollTop
            };
          });
          assert.equal((await snapshot()).gap, 0, `${width}/${anchor}: native anchor adjustment`);
          assert.equal((await snapshot()).lastTwoVisible, true);
          assert.ok(socket);
          socket.send(JSON.stringify({ type: 'message', id: peer, eventId: 'delayed', message: 'Delayed live message' }));
          await page.waitForTimeout(100);
          assert.equal((await snapshot()).gap, 0, 'live message must retain bottom following');
          await page.locator('#messages').hover();
          await page.mouse.wheel(0, -500);
          await page.waitForTimeout(150);
          const reading = await snapshot();
          assert.ok(reading.gap > 100);
          await page.locator('#messages').evaluate(messages => { messages.lastElementChild.style.height = '400px'; });
          await page.waitForTimeout(100);
          assert.equal((await snapshot()).top, reading.top, 'manual reading position must be preserved');
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px, overflow-anchor=${anchor}, attempt ${attempt + 1}`);
          await page.close();
        }
      }
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
