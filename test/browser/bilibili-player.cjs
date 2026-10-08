// Build first. Requires Playwright Chromium; all external requests are mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../../dist/web');
const account = '76561198000000009', peer = '76561198000000001';
const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true };
const direct = 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&autoplay=1';
const short = 'https://b23.tv/Short1';
const other = { id: '76561198000000002', name: 'Other conversation' };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let release = () => {};
      try {
        const errors = [], frames = [], resolutions = [], writes = [];
        const history = [direct, `[og url="${short}" title="B站视频"][url=${short}]${short}[/url][/og]`,
          '[url=https://m.bilibili.com/video/av170001]AV video[/url]', 'https://b23.tv/NotVideo', 'https://b23.tv/Late']
          .map((message, index) => ({ id: peer, eventId: `bili-${index}`, type: 'message', message, ordinal: 0,
            sentAt: new Date(Date.now() - (5 - index) * 1000).toISOString() }));
        const fixtures = {
          '/api/auth/me': { user: { id: 1, username: 'Test', role: 'user' }, permissions: ['chat.use'], steam },
          '/api/steam/status': steam, '/api/config': { wsPath: '/ws' }, '/api/history/status': {},
          '/api/conversations': { items: [{ id: peer, name: 'Bilibili regression' }, other] },
          '/api/friends': [], '/api/groups': [], '/api/emoticons': {}, '/api/message-reactions': { items: [] }
        };
        page.on('pageerror', error => errors.push(error.message));
        await page.routeWebSocket(/.*/, () => {});
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
        await page.route('https://player.bilibili.com/**', route => {
          frames.push(route.request().url());
          return route.fulfill({ contentType: 'text/html', body: '<script>window.playbackMarker="initial"</script><p>Official player fixture</p>' });
        });
        await page.route('http://bili.test/**', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api/bilibili/resolve') {
            const input = url.searchParams.get('url'); resolutions.push(input);
            if (input.endsWith('/NotVideo')) return route.fulfill({ status: 400, json: { error: 'Not a video' } });
            if (input.endsWith('/Late')) await new Promise(resolve => { release = resolve; });
            return route.fulfill({ json: { url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=3' } });
          }
          if (url.pathname === '/message') {
            writes.push(route.request().postDataJSON());
            const item = { id: peer, steamAccountId: account, eventId: 'sent', type: 'message', echo: true,
              message: writes[0].msg, sentAt: new Date().toISOString(), ordinal: 0 };
            history.push(item); return route.fulfill({ json: { ok: true, item } });
          }
          if (url.pathname === '/api/history') return route.fulfill({ json: { items: url.searchParams.get('id') === peer ? history : [] } });
          if (Object.hasOwn(fixtures, url.pathname)) return route.fulfill({ json: fixtures[url.pathname] });
          const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
          if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
          try { return route.fulfill({ body: await fs.readFile(file), contentType: {
            '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'
          }[path.extname(file)] || 'text/html' }); } catch { return route.fulfill({ status: 404 }); }
        });
        await page.goto('http://bili.test/'); await page.locator('.list-item').first().click();
        const card = index => page.locator(`[data-event-id="bili-${index}"] .bilibili-player`);
        await card(0).waitFor();
        assert.equal(frames.length, 0); assert.equal(resolutions.length, 0);
        await card(0).getByRole('button', { name: '▶ 播放 B 站视频' }).click();
        await page.waitForFunction(() => document.querySelector('iframe'));
        const iframe = await card(0).locator('iframe').elementHandle();
        const player = await iframe.contentFrame();
        await player.waitForFunction(() => window.playbackMarker === 'initial');
        assert.equal(frames[0], 'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=2&autoplay=0');
        assert.equal(await iframe.evaluate(node => node.allowFullscreen), true);
        await player.evaluate(() => window.playbackMarker = 'playing-at-42s');
        await page.locator('#messageInput').fill('Player continues'); await page.locator('#sendButton').click();
        await page.locator('[data-event-id="sent"]').waitFor();
        assert.equal(frames.length, 1);
        assert.equal(await player.evaluate(() => window.playbackMarker), 'playing-at-42s');
        assert.equal(await iframe.evaluate(node => node.isConnected), true);
        await card(1).getByRole('button', { name: '▶ 播放 B 站视频' }).click();
        await card(1).locator('iframe').waitFor();
        assert.deepEqual(resolutions, [short]);
        assert.equal(await card(1).locator('iframe').getAttribute('src'), 'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=3&autoplay=0');
        await card(2).getByRole('button', { name: '▶ 播放 B 站视频' }).click();
        assert.equal(await card(2).locator('iframe').getAttribute('src'), 'https://player.bilibili.com/player.html?aid=170001&page=1&autoplay=0');
        await card(3).getByRole('button', { name: '▶ 播放 B 站视频' }).click();
        await card(3).getByRole('status').filter({ hasText: '解析失败' }).waitFor();
        assert.equal(await card(3).locator('iframe').count(), 0);
        assert.equal(await card(3).getByRole('link', { name: '打开原视频' }).getAttribute('href'), 'https://b23.tv/NotVideo');
        const frameBounds = await card(1).locator('iframe').boundingBox();
        assert.ok(Math.abs(frameBounds.width / frameBounds.height - 16 / 9) < 0.1);
        assert.ok(frameBounds.x >= 0 && frameBounds.x + frameBounds.width <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `bilibili-player-${width}.png`) });
        await card(0).getByRole('button', { name: '关闭播放器' }).click();
        assert.equal(await card(0).locator('iframe').count(), 0);
        assert.equal(await iframe.evaluate(node => node.isConnected), false);
        await card(4).getByRole('button', { name: '▶ 播放 B 站视频' }).click();
        await card(4).getByRole('status').filter({ hasText: '正在解析' }).waitFor();
        await page.evaluate(() => Array.from(document.querySelectorAll('.list-item'))
          .find(node => node.textContent.includes('Other conversation')).click());
        const frameCount = frames.length;
        release(); await page.waitForTimeout(100);
        assert.equal(frames.length, frameCount, 'Late share resolution cannot create a player after switching conversations');
        assert.equal(await page.locator('.bilibili-player iframe').count(), 0);
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: BV/av/short links, page, click-only loading, iframe preservation, close, failure and stale completion`);
      } finally { release(); await page.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
