// Build first. Requires Playwright Chromium. Uses a local service, no Steam login.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { createAuthStore } = require('../../dist/src/auth/store');
const { createSessionManager } = require('../../dist/src/auth/session');
const { createChatService } = require('../../dist/src/server/chat-service');
(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steam-pwa-'));
  const auth = createAuthStore({ dbPath: join(dir, 'auth.sqlite') });
  const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
  const sessions = createSessionManager({ store: auth });
  const service = createChatService({ authStore: auth, sessionManager: sessions, logPath: join(dir, 'chat.jsonl'),
    logger: { info() {}, warn() {}, error() {} }, config: { host: '127.0.0.1', port: 0 } });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const cookie = sessions.createSetCookie(admin).split(';')[0], separator = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
        const page = await context.newPage(); const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'account'));
        await page.goto(base); await page.locator('#installApp').waitFor();
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        const manifestResponse = await context.request.get(`${base}/manifest.webmanifest`);
        assert.match(manifestResponse.headers()['content-type'], /application\/manifest\+json/);
        const manifest = await manifestResponse.json();
        assert.equal(manifest.display, 'standalone');
        for (const icon of manifest.icons) {
          assert.equal((await context.request.get(base + icon.src)).status(), 200);
          const size = await page.evaluate(async src => { const image = new Image(); image.src = src; await image.decode(); return `${image.naturalWidth}x${image.naturalHeight}`; }, icon.src);
          assert.equal(size, icon.sizes);
        }
        await page.evaluate(() => {
          const event = new Event('beforeinstallprompt', { cancelable: true });
          event.prompt = async () => { window.installPromptCalled = true; };
          event.userChoice = Promise.resolve({ outcome: 'accepted' });
          window.dispatchEvent(event);
        });
        await page.locator('#installApp').click();
        assert.equal(await page.evaluate(() => window.installPromptCalled), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `steam-pwa-settings-${width}.png`) });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Page.enable');
        const result = await cdp.send('Page.getAppManifest');
        assert.deepEqual(result.errors, []);
        const installability = await cdp.send('Page.getInstallabilityErrors');
        assert.deepEqual(installability.installabilityErrors, []);
        await context.setOffline(true);
        await page.reload(); await page.getByRole('heading', { name: '暂时无法连接 Steam Chat' }).waitFor();
        await context.setOffline(false);
        await page.getByRole('link', { name: '重新连接' }).click(); await page.locator('#installApp').waitFor();
        assert.deepEqual(await page.evaluate(() => caches.keys()), []);
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: manifest/icons, install prompt, settings, service worker, offline recovery, no cached data`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await service.stop(); auth.close(); await rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
