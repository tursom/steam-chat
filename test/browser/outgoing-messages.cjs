// Run after npm run build with Playwright and Chromium available.
// node test/browser/outgoing-messages.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(process.env.STEAM_CHAT_WEB_ROOT || path.join(__dirname, '../../dist/web'));
const peer = '76561198000000001';
const account = '76561198000000009';
const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true };
const friend = { id: peer, name: 'Outgoing regression', online: true };
const fixtures = {
  '/api/auth/me': { user: { id: 1, username: 'Preview', role: 'user' }, permissions: ['chat.use'], steam },
  '/api/steam/status': steam,
  '/api/config': { wsPath: '/ws' },
  '/api/history/status': {},
  '/api/conversations': { items: [friend] },
  '/api/friends': [friend], '/api/groups': [],
  '/api/emoticons': { emoticons: [], stickers: [] }
};

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let socket;
      let previewImage;
      const writes = [];
      const history = Array.from({ length: 30 }, (_, i) => ({ id: peer, eventId: `history-${i}`, type: 'message', message: `History ${i}` }));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.routeWebSocket(/.*/, connection => { socket = connection; });
      await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
      await page.route('http://steam-chat.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/message' || pathname === '/image') {
          await new Promise(done => writes.push({ route, done, body: route.request().postDataJSON() }));
          return;
        }
        if (pathname === '/proxy/image' && previewImage) return route.fulfill({ body: previewImage, contentType: 'image/png' });
        if (pathname === '/api/history') return route.fulfill({ json: { items: history } });
        if (Object.hasOwn(fixtures, pathname)) return route.fulfill({ json: fixtures[pathname] });
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
        try {
          const contentType = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/html';
          await route.fulfill({ body: await fs.readFile(file), contentType });
        } catch { await route.fulfill({ status: 404 }); }
      });
      await page.goto('http://steam-chat.test');
      await page.locator('.list-item').first().click();
      await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 30);
      await page.locator('#messages').hover();
      await page.mouse.wheel(0, -800);
      await page.waitForTimeout(100);
      await page.locator('#messageInput').fill('Optimistic text');
      await page.locator('#sendButton').click();
      const row = page.locator('.msg-row').filter({ hasText: 'Optimistic text' });
      await row.waitFor({ timeout: 3000 });
      assert.match(await row.innerText(), /发送中/);
      await page.waitForTimeout(50);
      assert.ok(await page.locator('#messages').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2), 'sending text must scroll to the bottom');
      assert.equal(await page.locator('#messageInput').inputValue(), '');
      await page.waitForTimeout(50);
      assert.equal(writes.length, 1);
      await page.locator('#messageInput').fill('Queued without waiting');
      await page.locator('#sendButton').click();
      const queued = page.locator('.msg-row').filter({ hasText: 'Queued without waiting' });
      await queued.waitFor({ timeout: 3000 });
      assert.match(await queued.innerText(), /发送中/);
      await page.waitForTimeout(50);
      assert.equal(writes.length, 2);
      const item = { id: peer, eventId: 'confirmed-1', steamAccountId: account, name: 'Preview', type: 'message', echo: true, message: 'Optimistic text', sentAt: new Date().toISOString() };
      history.push(item);
      socket.send(JSON.stringify({ ...item, type: 'message' }));
      await writes[0].route.fulfill({ json: { ok: true, item } });
      writes[0].done();
      await page.waitForTimeout(150);
      assert.equal(await row.count(), 1, 'response and WebSocket echo must not duplicate the local message');
      assert.doesNotMatch(await row.innerText(), /发送中/);
      assert.match(await queued.innerText(), /发送中/);
      const queuedItem = { ...item, eventId: 'confirmed-2', message: 'Queued without waiting' };
      history.push(queuedItem);
      await writes[1].route.fulfill({ json: { ok: true, item: queuedItem } });
      writes[1].done();
      await page.waitForTimeout(100);
      assert.match(await queued.innerText(), /已发送/);

      await page.locator('#messageInput').fill('Rejected text');
      await page.locator('#sendButton').click();
      const failed = page.locator('.msg-row').filter({ hasText: 'Rejected text' });
      await failed.waitFor({ timeout: 3000 });
      await page.waitForTimeout(50);
      await writes[2].route.fulfill({ status: 400, json: { error: 'Rejected for regression test' } });
      writes[2].done();
      await page.waitForTimeout(100);
      assert.match(await failed.innerText(), /失败/);

      await page.locator('#messageInput').fill('Uncertain text');
      await page.locator('#sendButton').click();
      const uncertain = page.locator('.msg-row').filter({ hasText: 'Uncertain text' });
      await uncertain.waitFor({ timeout: 3000 });
      await page.waitForTimeout(50);
      await writes[3].route.abort('failed');
      writes[3].done();
      await page.waitForTimeout(100);
      assert.match(await uncertain.innerText(), /未确认/);
      assert.equal(writes.length, 4, 'uncertain sends must not retry automatically');
      const dataUrl = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 240; canvas.height = 160;
        const context = canvas.getContext('2d');
        context.fillStyle = '#d7ece5'; context.fillRect(0, 0, 240, 160);
        context.fillStyle = '#187c69'; context.fillRect(20, 20, 200, 120);
        return canvas.toDataURL('image/png');
      });
      previewImage = Buffer.from(dataUrl.split(',')[1], 'base64');
      await page.locator('#messages').hover();
      await page.mouse.wheel(0, -800);
      await page.waitForTimeout(100);
      await page.locator('input[type="file"]').setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: previewImage });
      const preview = page.locator('.outgoing-image-preview');
      await preview.waitFor({ timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('.outgoing-image-preview')?.naturalWidth === 240);
      assert.match(await page.locator('.msg-row').filter({ has: preview }).innerText(), /发送中/);
      await page.waitForTimeout(50);
      assert.equal(writes.length, 5);
      assert.ok(await page.locator('#messages').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2), 'sending images must scroll to the bottom');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `steam-chat-outgoing-pending-${width}.png`) });
      const imageItem = { ...item, eventId: 'image-confirmed', type: 'image', message: 'https://images.example.test/confirmed.png' };
      history.push(imageItem);
      await writes[4].route.fulfill({ json: { ok: true, item: imageItem } });
      writes[4].done();
      await page.waitForTimeout(100);
      assert.equal(await preview.count(), 0);
      const confirmedImage = page.locator('[data-event-id="image-confirmed"]');
      assert.match(await confirmedImage.innerText(), /已发送/);
      await page.waitForFunction(() => document.querySelector('[data-event-id="image-confirmed"] img')?.naturalWidth === 240);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `steam-chat-outgoing-${width}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: immediate text and images, consecutive sends, all states, echo deduplication`);
      await page.close();
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
