// npm run build; NODE_PATH=<Playwright installation>/node_modules node test/browser/image-emotes.cjs
// Real backend/auth/store, mock Steam sender; no external messages or uploads.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { createAuthStore } = require('../../dist/src/auth/store');
const { createSessionManager } = require('../../dist/src/auth/session');
const { createChatService } = require('../../dist/src/server/chat-service');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const directory = await mkdtemp(join(tmpdir(), 'image-emotes-browser-'));
      const auth = createAuthStore({ dbPath: join(directory, 'auth.sqlite') });
      const admin = auth.createInitialAdmin({ username: 'admin', password: 'password123' });
      const sessions = createSessionManager({ store: auth });
      const account = auth.upsertSteamAccount({ steamId: '76561198000000002', setActive: true });
      const steam = { status: 'online', steamId: account.steamId, accessAllowed: true };
      const pending = [], requests = [], errors = [];
      const service = createChatService({ authStore: auth, sessionManager: sessions,
        config: { host: '127.0.0.1', port: 0 }, logPath: join(directory, 'chat.jsonl'), imageEmoteDir: join(directory, 'image-emotes'),
        logger: { info() {}, warn() {}, error() {} }, getEmoticons: async () => ({ emoticons: [], stickers: [] }),
        steamLoginService: { getStatus: () => steam, ensureOnline() {} },
        steamCommunity: { sendImageToUser(id, buffer, options, callback) { pending.push({ id, buffer, callback }); } }
      });
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
        const base = `http://127.0.0.1:${service.server.address().port}`;
        const cookie = sessions.createSetCookie(admin).split(';')[0];
        const separator = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept());
        page.on('request', r => { if (new URL(r.url()).pathname === '/image') requests.push(r.postDataJSON()); });
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'imageEmotes'));
        await page.route('**/api/conversations?*', route => route.fulfill({ json: { items: [{ id: '76561198000000001', name: 'Test friend' }] } }));
        await page.route('**/api/history?*', route => route.fulfill({ json: { items: [] } }));
        await page.route('**/api/history/status', route => route.fulfill({ json: { jsonl: { state: 'healthy', queued: 0 }, rocksdb: { state: 'healthy', queued: 0 } } }));
        await page.goto(base);
        await page.getByLabel('新分组名称').fill('猫猫'); await page.getByRole('button', { name: '新建分组', exact: true }).click();
        await page.getByLabel('上传图片表情').waitFor();
        const data = await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 120;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#19816f'; ctx.fillRect(0, 0, 180, 120);
          ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif'; ctx.fillText('Custom image', 10, 65);
          return canvas.toDataURL('image/png');
        });
        const buffer = Buffer.from(data.split(',')[1], 'base64');
        await page.getByLabel('上传图片表情').setInputFiles({ name: '开心.png', mimeType: 'image/png', buffer });
        await page.locator('.image-emote-card').waitFor();
        await page.getByLabel('新分组名称').fill('日常'); await page.getByRole('button', { name: '新建分组', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.image-emote-card select option').length === 2);
        const card = page.locator('.image-emote-card');
        await card.getByLabel('图片名称').fill('你好');
        await card.getByLabel('图片分组').selectOption({ label: '日常' });
        await card.getByRole('button', { name: '保存名称 / 分组' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.image-emote-card').length === 0);
        await page.locator('.image-emote-tools select').selectOption({ label: '日常' });
        await page.locator('.image-emote-card').waitFor();
        assert.equal(await page.locator('.image-emote-card').getByLabel('图片名称').inputValue(), '你好');
        await page.reload(); await page.locator('#imageEmoteManager').waitFor();
        await page.locator('.image-emote-tools select').selectOption({ label: '日常' });
        await page.locator('.image-emote-card').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `image-emote-manager-${width}.png`) });
        await page.getByRole('button', { name: '聊天', exact: true }).click();
        await page.locator('.list-item').first().click(); await page.locator('#pickerToggle').click();
        await page.locator('.picker-tabs button').filter({ hasText: '自定义' }).click();
        await page.locator('.custom-emote-picker select').selectOption({ label: '日常' });
        await page.locator('.custom-emote-picker .picker-grid button').waitFor();
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `image-emote-picker-${width}.png`) });
        await page.locator('#messageInput').fill('未发送的文字');
        // Input focus closes the floating picker; reopen on the retained custom tab.
        if (!(await page.locator('#picker').isVisible())) await page.locator('#pickerToggle').click();
        await page.locator('.custom-emote-picker .picker-grid button').click();
        await page.locator('.outgoing-image-preview').waitFor();
        await page.waitForTimeout(100);
        assert.equal(pending.length, 1); assert.deepEqual(pending[0].buffer, buffer);
        assert.ok(requests[0].emoteId); assert.equal(requests[0].img, undefined); assert.equal(requests[0].url, undefined);
        assert.equal(await page.locator('#messageInput').inputValue(), '未发送的文字');
        assert.equal(requests[0].steamAccountId, account.steamId);
        await page.route('**/proxy/image?*', route => route.fulfill({ body: buffer, contentType: 'image/png' }));
        pending[0].callback(null, 'https://images.steamusercontent.com/custom-test.png');
        await page.locator('[data-send-state="sent"]').first().waitFor();
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: grouped CRUD and reload, real authenticated asset, ID-only send, original bytes, optimistic preview`);
      } finally { await context.close(); await service.stop(); auth.close(); await rm(directory, { recursive: true, force: true }); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
