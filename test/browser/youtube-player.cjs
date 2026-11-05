// Build first. Playwright Chromium; all API and YouTube requests are mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../../dist/web');
const account = '76561198000000009', peer = '76561198000000001';
const videoId = '_mLzFeqWePo';
const source = `https://www.youtube.com/watch?v=${videoId}`;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390 });
      page.setDefaultTimeout(6000);
      try {
        const frames = [], errors = [];
        const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true,
          steamGrant: { level: 'full', scope: 'all', peerCount: 0, expiresAt: null } };
        const history = [`[youtube=${source} v=${videoId}]${source}[/youtube]`,
          `https://youtu.be/${videoId}?t=1m30s`, `https://www.youtube.com/shorts/${videoId}`,
          `[url=https://www.youtube.com/live/${videoId}]Live video[/url]`,
          `[og url="${source}" title="YouTube preview"]${source}[/og]`,
          `[youtube=${source} v=dQw4w9WgXcQ]${source}[/youtube]`]
          .map((message, index) => ({ id: peer, eventId: `youtube-${index}`, name: 'Video', type: 'message',
            message, ordinal: 0, sentAt: new Date(Date.now() - (6 - index) * 1000).toISOString() }));
        const fixtures = {
          '/api/auth/me': { user: { id: 1, username: 'Test', roleId: 'member' }, permissions: ['chat.use', 'self.password.change'], steam },
          '/api/config': { wsPath: '/ws' }, '/api/steam/status': steam, '/api/history/status': {},
          '/api/conversations': { items: [{ id: peer, name: 'YouTube videos' }, { id: 'other', name: 'Other conversation' }] },
          '/api/friends': [], '/api/groups': [], '/api/message-reactions': { items: [] },
          '/api/messages/sync': { steamAccountId: account, items: [], hasMore: false, liveCursor: 'youtube-cursor', nextCursor: 'youtube-cursor' }
        };
        page.on('pageerror', error => errors.push(error.message));
        await page.routeWebSocket(/.*/, () => {});
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
        await page.route('https://www.youtube-nocookie.com/**', route => {
          frames.push({ url: route.request().url(), referer: route.request().headers().referer });
          return route.fulfill({ contentType: 'text/html', body: '<script>window.playbackMarker="ready"</script><p>YouTube player fixture</p>' });
        });
        await page.route('http://youtube.test/**', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/message') {
            const item = { id: peer, steamAccountId: account, eventId: 'sent', type: 'message', echo: true,
              message: route.request().postDataJSON().msg, sentAt: new Date().toISOString(), ordinal: 0 };
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
        await page.goto('http://youtube.test/'); await page.locator('#chatListSections .conv').first().click();
        const card = index => page.locator(`[data-event-id="youtube-${index}"] .youtube-player`);
        await card(0).waitFor();
        assert.equal(await page.locator('.youtube-player').count(), 5);
        assert.equal(frames.length, 0, 'History must not contact YouTube before a playback click');
        assert.doesNotMatch(await page.locator('[data-event-id="youtube-0"] .msg-body').innerText(), /\[\/?youtube/i);
        assert.match(await page.locator('[data-event-id="youtube-5"] .msg-body').innerText(), /\[youtube=/);
        await card(0).getByRole('button', { name: '▶ 播放 YouTube 视频' }).click();
        const frameElement = await card(0).locator('iframe').elementHandle();
        const player = await frameElement.contentFrame();
        await player.waitForFunction(() => window.playbackMarker === 'ready');
        assert.equal(frames[0].url, `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&playsinline=1`);
        assert.equal(frames[0].referer, 'http://youtube.test/');
        assert.equal(await frameElement.evaluate(node => node.allowFullscreen), true);
        await player.evaluate(() => window.playbackMarker = 'playing-at-42');
        await page.locator('#messageInput').fill('Keep playing'); await page.locator('#sendButton').click();
        await page.locator('[data-event-id="sent"]').waitFor();
        assert.equal(await player.evaluate(() => window.playbackMarker), 'playing-at-42');
        assert.equal(frames.length, 1);
        await card(1).getByRole('button', { name: '▶ 播放 YouTube 视频' }).click();
        assert.equal(await card(1).locator('iframe').getAttribute('src'), `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&playsinline=1&start=90`);
        const bounds = await card(1).locator('iframe').boundingBox();
        assert.ok(Math.abs(bounds.width / bounds.height - 16 / 9) < 0.1);
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await card(0).locator('iframe').evaluate(node => node.dispatchEvent(new Event('error')));
        assert.match(await card(0).getByRole('status').innerText(), /加载失败/);
        assert.equal(await card(0).getByRole('link', { name: '打开原视频' }).getAttribute('href'), source);
        await card(0).getByRole('button', { name: '关闭播放器' }).click();
        assert.equal(await frameElement.evaluate(node => node.isConnected), false);
        assert.equal(await card(0).locator('iframe').count(), 0);
        await card(0).getByRole('button', { name: '▶ 播放 YouTube 视频' }).click();
        await card(0).locator('iframe').waitFor();
        await page.locator('#chatListSections .conv').filter({ hasText: 'Other conversation' }).evaluate(node => node.click());
        assert.equal(await page.locator('.youtube-player iframe').count(), 0);
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: YouTube BBCode, links, click-only playback, start time, referrer, stable player, layout and close`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
