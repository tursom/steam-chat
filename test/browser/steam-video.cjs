// Build first. Requires Playwright Chromium and ffmpeg with libx264.
// Runs entirely against fixtures; sends no real Steam messages.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');

const root = path.resolve(__dirname, '../../dist/web');
const peer = '76561198000000001';
const account = '76561198000000009';
const source = `https://cdn.steamusercontent.com/ugc/123/${'A'.repeat(40)}/`;
const brokenSource = `https://cdn.steamusercontent.com/ugc/124/${'B'.repeat(40)}/`;
const markup = url => `[video src=${url} type=video/mp4 steamvideo=true]${url}[/video]`;
const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true };
const friend = { id: peer, name: 'Video regression' };
const other = { id: '76561198000000002', name: 'Other conversation' };
const fixtures = {
  '/api/auth/me': { user: { id: 1, username: 'Test', role: 'user' }, permissions: ['chat.use'], steam },
  '/api/steam/status': steam,
  '/api/config': { wsPath: '/ws' },
  '/api/history/status': {},
  '/api/conversations': { items: [friend, other] },
  '/api/friends': [friend, other], '/api/groups': [],
  '/api/emoticons': { emoticons: [], stickers: [], effects: [] },
  '/api/message-reactions': { items: [] }
};

(async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'steam-video-browser-'));
  let browser;
  try {
    const file = path.join(directory, 'sample.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
      '-t', '30', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', file], { timeout: 20000 });
    const buffer = await fs.readFile(file);
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    for (const { width, moduleFailure = false, delayedModule = false } of [
      { width: 1440 }, { width: 390 }, { width: 390, moduleFailure: true }, { width: 390, delayedModule: true }
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 },
        ...(width === 390 ? { isMobile: true, hasTouch: true,
          userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' } : {}) });
      try {
        const errors = [], writes = [], requestedVideos = [];
        let playerModuleRequests = 0;
        let releaseModule, moduleRequested;
        const moduleGate = delayedModule ? new Promise(resolve => { releaseModule = resolve; }) : Promise.resolve();
        const moduleReached = new Promise(resolve => { moduleRequested = resolve; });
        let socket;
        const history = [source, brokenSource].map((url, index) => ({
          id: peer, eventId: `video-${index}`, type: 'message', echo: false, name: friend.name,
          sentAt: new Date(Date.now() - (2 - index) * 10000).toISOString(), ordinal: 0, message: markup(url)
        }));
        page.on('pageerror', error => errors.push(error.message));
        await page.routeWebSocket(/.*/, connection => { socket = connection; });
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
        await page.route('https://cdn.steamusercontent.com/**', async route => {
          requestedVideos.push(route.request().url());
          if (route.request().url() === brokenSource) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
          assert.equal(route.request().url(), source);
          const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1;
          return route.fulfill({ status: range ? 206 : 200, body: buffer.subarray(start, end + 1), headers: {
            'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } : {})
          } });
        });
        await page.route('http://steam-video.test/**', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/vendor/artplayer-5.4.0.mjs') {
            playerModuleRequests++;
            moduleRequested();
            if (moduleFailure) return route.fulfill({ status: 503 });
            await moduleGate;
          }
          if (pathname === '/message') {
            await new Promise(done => writes.push({ route, done }));
            return;
          }
          if (pathname === '/api/history') return route.fulfill({ json: {
            items: new URL(route.request().url()).searchParams.get('id') === peer ? history : []
          } });
          if (Object.hasOwn(fixtures, pathname)) return route.fulfill({ json: fixtures[pathname] });
          const staticFile = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
          if (!staticFile.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
          try {
            await route.fulfill({ body: await fs.readFile(staticFile), contentType: {
              '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'
            }[path.extname(staticFile)] || 'text/html' });
          } catch { await route.fulfill({ status: 404 }); }
        });
        await page.goto('http://steam-video.test/');
        await page.locator('.list-item').first().click();
        const shell = page.locator('[data-event-id="video-0"] .steam-video');
        await shell.waitFor();
        assert.equal(await page.locator('video').count(), 0);
        assert.equal(requestedVideos.length, 0, 'History must not download videos');
        assert.equal(playerModuleRequests, 0, 'History must not load the player module');
        assert.equal(await shell.getByRole('link', { name: '打开原视频' }).getAttribute('href'), source);
        await shell.getByRole('button', { name: '▶ 播放视频' }).click();
        if (moduleFailure) {
          await shell.getByRole('status').filter({ hasText: '播放器加载失败' }).waitFor();
          assert.equal(await shell.locator('video').count(), 0);
          assert.equal(requestedVideos.length, 0);
          assert.equal(await shell.getByRole('link', { name: '打开原视频' }).getAttribute('href'), source);
          assert.deepEqual(errors, []);
          console.log('PASS player module failure: visible error and original link, no media request');
          continue;
        }
        if (delayedModule) {
          await moduleReached;
          await page.evaluate(() => Array.from(document.querySelectorAll('.list-item'))
            .find(node => node.textContent.includes('Other conversation')).click());
          releaseModule();
          const instances = await page.evaluate(async () => {
            const module = await import('/vendor/artplayer-5.4.0.mjs');
            await Promise.resolve();
            return module.default.instances.length;
          });
          assert.equal(instances, 0);
          assert.equal(requestedVideos.length, 0);
          assert.deepEqual(errors, []);
          console.log('PASS conversation switch during module loading: late completion cannot start playback');
          continue;
        }
        const video = await shell.locator('video').elementHandle();
        await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2);
        assert.equal(await video.evaluate(node => !node.controls && node.playsInline && node.preload === 'none' && !node.autoplay), true);
        await shell.locator('.art-video-player').hover();
        assert.equal(await shell.locator('.art-control-fullscreenWeb').count(), 1);
        assert.equal(await shell.locator('.art-control-fullscreen').count(), 1);
        await video.evaluate(node => {
          node.currentTime = 4;
          node.dataset.loadStarts = '0';
          node.addEventListener('loadstart', () => node.dataset.loadStarts = String(Number(node.dataset.loadStarts) + 1));
        });
        await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 4 && !document.querySelector('video')?.seeking);
        const chatScroll = await page.locator('#messages').evaluate(node => node.scrollTop);
        await shell.locator('.art-control-fullscreenWeb').click();
        await page.waitForFunction(() => document.documentElement.classList.contains('video-web-fullscreen'));
        const full = await shell.locator('.art-video-player').boundingBox();
        assert.ok(Math.abs(full.width - width) < 2 && Math.abs(full.height - 900) < 2, 'Web fullscreen covers the browser viewport');
        assert.equal(await page.evaluate(() => document.fullscreenElement === null), true, 'Web fullscreen does not require system fullscreen');
        assert.equal(await video.evaluate(node => node.isConnected && node.currentTime >= 4 && !node.paused), true);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `steam-video-web-fullscreen-${width}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.documentElement.classList.contains('video-web-fullscreen'));
        await page.waitForFunction(top => Math.abs(document.querySelector('#messages').scrollTop - top) < 2, chatScroll);
        assert.equal(await video.evaluate(node => node.dataset.loadStarts), '0');
        await shell.locator('.art-video-player').hover();
        await shell.locator('.art-control-fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement !== null);
        await page.evaluate(() => document.exitFullscreen());
        assert.equal(await video.evaluate(node => node.dataset.loadStarts), '0');
        await shell.locator('.art-video-player').hover();
        await shell.locator('.art-control-setting').click();
        await shell.locator('.art-setting-item').filter({ hasText: '播放速度' }).click();
        assert.equal(await shell.locator('.art-setting-item[data-value="0.75"] .art-setting-item-left-text').textContent(), '0.75x');
        assert.equal(await shell.locator('.art-setting-item[data-value="1.25"] .art-setting-item-left-text').textContent(), '1.25x');
        await shell.locator('.art-setting-item[data-value="1.5"]').click();
        assert.equal(await video.evaluate(node => node.playbackRate), 1.5);
        await page.locator('#messageInput').fill('Video keeps playing');
        await page.locator('#messageInput').press('Space');
        assert.equal(await video.evaluate(node => node.paused), false, 'Typing spaces in chat must not pause the player');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => document.querySelector('[data-send-state="sending"]'));
        assert.equal(await video.evaluate(node => node.isConnected && node.currentTime >= 4 && !node.paused), true);
        assert.equal(await video.evaluate(node => node.dataset.loadStarts), '0');
        assert.equal(writes.length, 1);
        const confirmed = { id: peer, eventId: 'confirmed', steamAccountId: account, echo: true, type: 'message',
          name: 'Test', message: 'Video keeps playing', ordinal: 0, sentAt: new Date().toISOString() };
        history.push(confirmed);
        socket.send(JSON.stringify(confirmed));
        await writes[0].route.fulfill({ json: { ok: true, item: confirmed } }); writes[0].done();
        await page.locator('[data-event-id="confirmed"]').waitFor();
        assert.equal(await video.evaluate(node => node.isConnected && node.currentTime >= 4 && !node.paused), true);
        assert.equal(await video.evaluate(node => node.dataset.loadStarts), '0');
        const failed = page.locator('[data-event-id="video-1"] .steam-video');
        await failed.getByRole('button', { name: '▶ 播放视频' }).click();
        await failed.getByRole('status').filter({ hasText: '视频无法播放' }).waitFor();
        assert.equal(await failed.getByRole('link', { name: '打开原视频' }).getAttribute('href'), brokenSource);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const fits = await shell.evaluate(node => {
          const video = node.querySelector('.art-video-player').getBoundingClientRect();
          const bubble = node.closest('.bubble').getBoundingClientRect();
          return video.left >= Math.max(0, bubble.left) && video.right <= Math.min(innerWidth, bubble.right)
            && video.width >= 260 && video.width / video.height > 1.7;
        });
        assert.equal(fits, true, 'Player stays inside the message bubble after exiting fullscreen');
        assert.deepEqual(errors, []);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `steam-video-${width}.png`) });
        await shell.locator('.art-video-player').hover();
        await shell.locator('.art-control-fullscreenWeb').click();
        await page.evaluate(() => {
          const other = Array.from(document.querySelectorAll('.list-item')).find(node => node.textContent.includes('Other conversation'));
          other.click();
        });
        // Navigation can also happen through notifications or account switching while full screen.
        await page.waitForFunction(() => !document.documentElement.classList.contains('video-web-fullscreen'));
        assert.equal(await video.evaluate(node => node.isConnected), false);
        assert.equal(await page.evaluate(async () => (await import('/vendor/artplayer-5.4.0.mjs')).default.instances.length), 0);
        await page.evaluate(() => {
          const original = Array.from(document.querySelectorAll('.list-item')).find(node => node.textContent.includes('Video regression'));
          original.click();
        });
        await shell.getByRole('button', { name: '▶ 播放视频' }).waitFor();
        assert.equal(await shell.locator('video').count(), 0, 'Returning to a conversation offers playback again without loading automatically');
        assert.equal(playerModuleRequests, 1, 'The local player module is loaded once across messages');
        console.log(`PASS ${width}px: ArtPlayer playback/rate, web/system fullscreen, Escape, retained state, cleanup and error fallback`);
      } finally { await page.close(); }
    }
  } finally { await browser?.close(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
