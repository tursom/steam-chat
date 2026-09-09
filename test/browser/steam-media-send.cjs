// npm run build; node test/browser/steam-media-send.cjs
// Requires Playwright with Chromium. Only Steam's network reply is mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const SteamUser = require('steam-user');
const { createChatService } = require('../../dist/src/server/chat-service');
const peer = '76561198000000001';
const account = '76561198000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const packets = [], records = [], httpMessages = [];
      let onMessage;
      const sdk = new SteamUser({ dataDirectory: null, autoRelogin: false });
      sdk._sendUnified = (method, payload, callback) => {
        packets.push({ method, ...payload });
        assert.equal(payload.contains_bbcode, true);
        let modified = payload.message;
        if (modified === '/sticker Show Love') modified = '[sticker type="Show Love" limit="0"][/sticker]';
        if (modified === ':Khappy:') modified = '[emoticon]Khappy[/emoticon]';
        callback({ modified_message: modified, server_timestamp: 1700000000, ordinal: packets.length }, { proto: { eresult: 1 } });
      };
      const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true };
      const service = createChatService({ steamUser: sdk, getSelfName: async () => 'Sender',
        steamLoginService: { getStatus: () => steam, ensureOnline() {} },
        config: { host: '127.0.0.1', port: 0 }, logger: { info() {}, warn() {}, error() {} },
        historyStorage: {
          canSend: () => true,
          append(record) {
            const item = { ...record, eventId: `confirmed-${records.length + 1}` };
            records.push(item); onMessage?.(item); return item;
          },
          onMessage(callback) { onMessage = callback; return () => {}; },
          onStatus: () => () => {}, onDurable: () => () => {}
        }
      });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        service.server.listen(0, '127.0.0.1');
        await once(service.server, 'listening');
        await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
        await page.route('**/api/**', route => {
          const pathname = new URL(route.request().url()).pathname;
          const data = {
            '/api/auth/me': { user: { id: 1, username: 'Sender', role: 'user' }, permissions: ['chat.use'], steam },
            '/api/steam/status': steam, '/api/config': { wsPath: '/ws' }, '/api/history/status': {},
            '/api/conversations': { items: [{ id: peer, name: 'Receiver' }] },
            '/api/friends': [{ id: peer, name: 'Receiver' }], '/api/groups': [],
            '/api/history': { items: records },
            '/api/emoticons': { emoticons: [{ name: ':Khappy:' }], stickers: [{ name: 'Show Love' }] }
          };
          return route.fulfill({ json: data[pathname] || {} });
        });
        await page.route('**/proxy/**', route => route.fulfill({ body: png, contentType: 'image/png' }));
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/message') httpMessages.push(request.postDataJSON().msg);
        });
        await page.goto(`http://127.0.0.1:${service.server.address().port}`);
        await page.locator('.list-item').first().click();
        await page.locator('#pickerToggle').click();
        await page.locator('.picker-grid button').first().click();
        assert.equal(await page.locator('#messageInput').inputValue(), ':Khappy:');
        await page.locator('#pickerToggle').click();
        await page.locator('#sendButton').click();
        await page.locator('[data-event-id="confirmed-1"] .emoticon').waitFor();
        assert.equal(records[0].message, '[emoticon]Khappy[/emoticon]');

        await page.locator('#messageInput').fill('Keep this text draft');
        await page.locator('#pickerToggle').click();
        await page.locator('.picker-tabs button').filter({ hasText: '贴纸' }).click();
        await page.locator('.picker-grid button').click();
        await page.locator('[data-event-id="confirmed-2"] .sticker').waitFor();
        assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this text draft');
        assert.equal(records[1].message, '[sticker type="Show Love" limit="0"][/sticker]');
        await page.locator('#pickerToggle').click();

        const literal = '[emoticon]Khappy[/emoticon]';
        await page.locator('#messageInput').fill(literal);
        await page.locator('#sendButton').click();
        const delivered = page.locator('[data-event-id="confirmed-3"]');
        await delivered.waitFor();
        assert.equal(await delivered.locator('.message-content').textContent(), literal);
        assert.equal(await delivered.locator('img').count(), 0);
        assert.deepEqual(httpMessages, [':Khappy:', '/sticker Show Love', literal]);
        assert.deepEqual(packets.map(packet => packet.message), [':Khappy:', '/sticker Show Love', '\\[emoticon]Khappy\\[/emoticon]']);
        assert.equal(records[2].message, packets[2].message);
        assert.equal(await page.locator('.msg-row').count(), 3);
        console.log(`PASS ${width}px: actual browser -> HTTP backend -> installed SDK -> canonical record and echo`);
      } finally {
        await page.close();
        await service.stop();
      }
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
