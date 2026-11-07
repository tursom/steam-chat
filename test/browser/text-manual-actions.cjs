// Run after npm run build with Playwright and Chromium available.
// node test/browser/text-manual-actions.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(process.env.STEAM_CHAT_WEB_ROOT || path.join(__dirname, '../../dist/web'));
const peer = '76561198000000001';
const account = '76561198000000009';
const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account }, accessAllowed: true,
  steamGrant: { level: 'full', scope: 'all', peerCount: 0, expiresAt: null } };
const fixtures = {
  '/api/auth/me': { user: { id: 1, username: 'Preview', roleId: 'member' }, permissions: ['chat.use'], steam },
  '/api/steam/status': steam, '/api/config': { wsPath: '/ws' }, '/api/history/status': {},
  '/api/conversations': { items: [{ id: peer, name: 'Manual text actions', online: true }] },
  '/api/friends': [{ id: peer, name: 'Manual text actions', online: true }], '/api/groups': [],
  '/api/emoticons': { emoticons: [], stickers: [] }, '/api/history': { items: [] }
};

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const writes = [], checks = [], errors = [];
      let socket;
      page.on('pageerror', error => errors.push(error.message));
      await page.routeWebSocket(/.*/, connection => { socket = connection; });
      await page.addInitScript(() => localStorage.setItem('steam-chat.view', 'chat'));
      await page.route('http://steam-chat.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/message' || pathname === '/api/messages/check') {
          await new Promise(done => (pathname === '/message' ? writes : checks).push({ route, done,
            method: route.request().method(), body: route.request().postDataJSON() }));
          return;
        }
        if (Object.hasOwn(fixtures, pathname)) return route.fulfill({ json: fixtures[pathname] });
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
        try {
          const contentType = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/html';
          await route.fulfill({ body: await fs.readFile(file), contentType });
        } catch { await route.fulfill({ status: 404 }); }
      });
      const waitRequest = async (requests, count) => {
        await assert.doesNotReject(async () => {
          for (let i = 0; i < 100 && requests.length < count; i++) await page.waitForTimeout(20);
          assert.equal(requests.length, count);
        });
        return requests[count - 1];
      };
      const respond = async (request, status, json) => { await request.route.fulfill({ status, json }); request.done(); };
      const localRow = id => page.locator(`[data-outgoing-id="${id}"]`);
      const attempt = async (text, certainty) => {
        const index = writes.length;
        await page.locator('#messageInput').fill(text);
        await page.locator('#sendButton').click();
        const request = await waitRequest(writes, index + 1);
        const row = page.locator('.msg-row').filter({ hasText: text }).last();
        const id = await row.getAttribute('data-outgoing-id');
        await respond(request, certainty === 'failed' ? 400 : 502, { error: certainty === 'failed' ? 'Actual rejection' : '文字发送结果未确认，请先检查聊天记录。', uncertain: certainty === 'unknown' });
        await page.waitForFunction(({ id, certainty }) => document.querySelector(`[data-outgoing-id="${id}"]`)?.dataset.sendState === certainty, { id, certainty });
        return { id, request, row: localRow(id) };
      };
      const event = (message, eventId) => ({ id: peer, steamAccountId: account, echo: true, type: 'message', message, eventId, sentAt: new Date().toISOString() });
      await page.goto('http://steam-chat.test');
      await page.locator('.list-item').first().click();
      await page.locator('#messageInput').waitFor();

      const failed = await attempt('Original [failed] body', 'failed');
      await page.locator('#messageInput').fill('New edited draft');
      const retryIndex = writes.length;
      await failed.row.getByRole('button', { name: '重试发送' }).evaluate(button => { button.click(); button.click(); });
      const retry = await waitRequest(writes, retryIndex + 1);
      assert.deepEqual(retry.body, failed.request.body, 'retry sends immutable original body');
      assert.equal(await failed.row.getAttribute('data-send-state'), 'sending');
      assert.equal(await page.locator('.msg-row').filter({ hasText: 'Original [failed] body' }).count(), 1);
      assert.equal(await page.locator('#messageInput').inputValue(), 'New edited draft');
      await respond(retry, 400, { error: 'Retry actually rejected', uncertain: false });
      await failed.row.getByRole('button', { name: '重试发送' }).waitFor();
      assert.equal(await failed.row.getAttribute('data-send-state'), 'failed');
      assert.match(await failed.row.innerText(), /Retry actually rejected/);
      assert.equal(writes.length, retryIndex + 1);

      const unknown = await attempt('Original unknown body', 'unknown');
      assert.match(await unknown.row.innerText(), /可能已经送达.*重复消息/);
      assert.equal(await unknown.row.getByRole('button', { name: '检查发送结果' }).count(), 1);
      assert.equal(await unknown.row.getByRole('button', { name: '仍要发送一份' }).count(), 1);
      assert.doesNotMatch(await unknown.row.innerText(), /文字发送结果未确认，请先检查聊天记录/, 'generic warning is not repeated');
      await page.locator('#messageInput').fill('Draft while checking');
      const writeCount = writes.length;
      const sentAt = await page.evaluate(id => outgoingMessages.get(Number(id)).item.sentAt, unknown.id);
      await unknown.row.getByRole('button', { name: '检查发送结果' }).evaluate(button => { button.click(); button.click(); });
      const check = await waitRequest(checks, 1);
      assert.equal(check.method, 'POST');
      assert.deepEqual(check.body, { id: peer, msg: 'Original unknown body', sentAt, steamAccountId: account });
      assert.equal(await unknown.row.getByRole('button', { name: '仍要发送一份' }).isDisabled(), true);
      await respond(check, 200, { items: [] });
      await unknown.row.locator('.outgoing-check-reason').waitFor();
      assert.equal(await unknown.row.getAttribute('data-send-state'), 'unknown');
      assert.match(await unknown.row.innerText(), /未找到.*仍可能已发送/);
      assert.equal(writes.length, writeCount, 'check must not call /message');
      assert.equal(await page.locator('#messageInput').inputValue(), 'Draft while checking');
      await unknown.row.getByRole('button', { name: '检查发送结果' }).click();
      await respond(await waitRequest(checks, 2), 503, { error: 'History unavailable' });
      await page.waitForFunction(id => document.querySelector(`[data-outgoing-id="${id}"]`)?.textContent.includes('检查失败'), unknown.id);
      assert.equal(await unknown.row.getAttribute('data-send-state'), 'unknown');

      // Keep real DOM buttons from the old render and exercise their closures
      // after context changes, without relying on hidden/disabled replacement UI.
      for (const change of ['peer', 'account', 'activeAccount', 'access', 'permission', 'grant', 'offline']) {
        const before = [writes.length, checks.length];
        await page.evaluate(({ failedId, unknownId, change }) => {
          const buttons = [...document.querySelectorAll(`[data-outgoing-id="${failedId}"] .outgoing-retry, [data-outgoing-id="${unknownId}"] .outgoing-check, [data-outgoing-id="${unknownId}"] .outgoing-resend`)];
          const previous = { id: state.activeId, steam: structuredClone(state.steam), permissions: [...state.permissions] };
          if (change === 'peer') state.activeId = 'other';
          if (change === 'account') state.steam.steamId = 'other';
          if (change === 'activeAccount') state.steam.activeAccount.steamId = 'other';
          if (change === 'access') state.steam.accessAllowed = false;
          if (change === 'permission') state.permissions = [];
          if (change === 'grant') state.steam.steamGrant.level = 'read';
          if (change === 'offline') state.steam.status = 'offline';
          // Offline history checking is allowed; only sends require a live Steam connection.
          for (const button of buttons) if (change !== 'offline' || !button.classList.contains('outgoing-check')) button.click();
          state.activeId = previous.id; state.steam = previous.steam; state.permissions = previous.permissions;
          refreshOutgoing();
        }, { failedId: failed.id, unknownId: unknown.id, change });
        await page.waitForTimeout(40);
        assert.deepEqual([writes.length, checks.length], before, `stale ${change} buttons must not issue requests`);
      }

      // The check's actual recorded event replaces the unknown row normally.
      await unknown.row.getByRole('button', { name: '检查发送结果' }).click();
      const checkedItem = { ...event('Original unknown body', 'checked-original'), sentAt };
      await respond(await waitRequest(checks, 3), 200, { items: [checkedItem] });
      await page.locator('[data-event-id="checked-original"]').waitFor();
      assert.equal(await unknown.row.count(), 0);
      assert.equal(writes.length, writeCount);
      assert.equal(await page.locator('#messageInput').inputValue(), 'Draft while checking');

      const original = await attempt('Explicit extra copy', 'unknown');
      const originalSentAt = await page.evaluate(id => outgoingMessages.get(Number(id)).item.sentAt, original.id);
      await page.locator('#messageInput').fill('Draft while resending');
      const replacementIndex = writes.length;
      await original.row.getByRole('button', { name: '仍要发送一份' }).evaluate(button => { button.click(); button.click(); });
      const replacementRequest = await waitRequest(writes, replacementIndex + 1);
      assert.deepEqual(replacementRequest.body, original.request.body);
      assert.equal(await page.locator('.msg-row').filter({ hasText: 'Explicit extra copy' }).count(), 2);
      assert.equal(await original.row.getAttribute('data-send-state'), 'unknown');
      assert.equal(await original.row.getByRole('button', { name: '仍要发送一份' }).isDisabled(), true);
      assert.equal(await page.locator('#messageInput').inputValue(), 'Draft while resending');
      const replacementItem = event('Explicit extra copy', 'replacement-confirmed');
      socket.send(JSON.stringify(replacementItem));
      await page.locator('[data-event-id="replacement-confirmed"]').waitFor();
      assert.equal(await original.row.getAttribute('data-send-state'), 'unknown', 'replacement realtime confirmation leaves original unknown');
      await respond(replacementRequest, 200, { ok: true, item: replacementItem });
      await page.waitForTimeout(80);
      assert.equal(await original.row.getAttribute('data-send-state'), 'unknown');
      assert.equal(await page.locator('[data-event-id="replacement-confirmed"]').count(), 1);
      await original.row.getByRole('button', { name: '仍要发送一份' }).evaluate(button => button.click());
      assert.equal(writes.length, replacementIndex + 1, 'replacement remains deduplicated after confirmation');
      await original.row.getByRole('button', { name: '检查发送结果' }).click();
      await respond(await waitRequest(checks, 4), 200, { items: [{ ...event('Explicit extra copy', 'original-confirmed'), sentAt: originalSentAt }] });
      await page.locator('[data-event-id="original-confirmed"]').waitFor();
      assert.equal(await original.row.count(), 0);
      assert.equal(await page.locator('.msg-row').filter({ hasText: 'Explicit extra copy' }).count(), 2);

      const rejectedOriginal = await attempt('Rejected extra copy', 'unknown');
      const rejectedIndex = writes.length;
      await rejectedOriginal.row.getByRole('button', { name: '仍要发送一份' }).click();
      await respond(await waitRequest(writes, rejectedIndex + 1), 400, { error: 'Extra copy rejected', uncertain: false });
      await page.locator('.msg-row[data-send-state="failed"]').filter({ hasText: 'Rejected extra copy' }).waitFor();
      assert.equal(await rejectedOriginal.row.getAttribute('data-send-state'), 'unknown');
      assert.equal(await rejectedOriginal.row.getByRole('button', { name: '仍要发送一份' }).isDisabled(), true);

      const cooldownUnknown = await attempt('Unknown before cooldown', 'unknown');
      await page.clock.install({ time: new Date() });
      await page.clock.pauseAt(new Date(Date.now() + 100));
      const limitedIndex = writes.length;
      await page.locator('#messageInput').fill('Rate limited original [body]');
      await page.locator('#sendButton').click();
      const limitedRequest = await waitRequest(writes, limitedIndex + 1);
      const limitedRow = page.locator('.msg-row').filter({ hasText: 'Rate limited original [body]' }).last();
      const limitedId = await limitedRow.getAttribute('data-outgoing-id');
      const clockNow = await page.evaluate(() => Date.now());
      await respond(limitedRequest, 429, { code: 'steam_rate_limited', error: 'RateLimitExceeded', uncertain: false,
        retryAt: clockNow + 30000, retryAfterMs: 30000 });
      await limitedRow.getByRole('button', { name: '30 秒后可重试' }).waitFor();
      assert.equal(await limitedRow.getAttribute('data-send-state'), 'failed');
      assert.match(await limitedRow.innerText(), /Steam 发送频率受限/);
      for (const row of [failed.row, limitedRow, cooldownUnknown.row]) {
        const action = row.locator('.outgoing-retry, .outgoing-resend');
        assert.equal(await action.innerText(), '30 秒后可重试');
        assert.equal(await action.isDisabled(), true);
      }
      assert.equal(await page.locator('#sendButton').isDisabled(), true);
      assert.match(await page.locator('#sendButton').getAttribute('title'), /30 秒后可重试/);
      assert.equal(await page.locator('#messageInput').isEditable(), true);
      await page.locator('#messageInput').fill('Edited draft during cooldown');
      const cooldownWriteCount = writes.length;
      const outgoingCount = await page.locator('[data-outgoing-id]').count();
      await page.locator('#messageInput').press('Enter');
      const helperResults = await page.evaluate(async ({ failedId, unknownId, limitedId }) => [
        await sendText(), await sendText('/sticker must-wait'),
        await retryOutgoingText(outgoingMessages.get(Number(failedId))),
        await retryOutgoingText(outgoingMessages.get(Number(limitedId))),
        await resendOutgoingText(outgoingMessages.get(Number(unknownId)))
      ], { failedId: failed.id, unknownId: cooldownUnknown.id, limitedId });
      assert.deepEqual(helperResults, [false, false, false, false, false]);
      assert.equal(writes.length, cooldownWriteCount);
      assert.equal(await page.locator('[data-outgoing-id]').count(), outgoingCount);
      assert.equal(await page.locator('#messageInput').inputValue(), 'Edited draft during cooldown');

      const cooldownCheckIndex = checks.length;
      await cooldownUnknown.row.getByRole('button', { name: '检查发送结果' }).click();
      await respond(await waitRequest(checks, cooldownCheckIndex + 1), 200, { items: [] });
      await cooldownUnknown.row.locator('.outgoing-check-reason').waitFor();
      assert.equal(await cooldownUnknown.row.getAttribute('data-send-state'), 'unknown');
      // Navigate to a different peer: failed rows and new sends share the account deadline.
      await page.evaluate(() => openConversation('76561198000000002', 'Other peer'));
      assert.equal(await page.locator('#sendButton').isDisabled(), true);
      await page.locator('#messageInput').fill('Other peer draft');
      assert.equal(await page.evaluate(() => sendText()), false);
      assert.equal(await page.locator('#messageInput').inputValue(), 'Other peer draft');
      await page.evaluate(peer => openConversation(peer, 'Manual text actions'), peer);
      await failed.row.locator('.outgoing-retry').waitFor();
      assert.equal(await failed.row.locator('.outgoing-retry').innerText(), '30 秒后可重试');
      await page.locator('#messageInput').fill('Draft stays through expiry');
      // The account cache is keyed independently; another account can still send.
      const differentAccountIndex = writes.length;
      await page.evaluate(() => {
        globalThis.savedCooldownSteam = structuredClone(state.steam);
        state.steam = { ...state.steam, steamId: '76561198000000008', activeAccount: { id: 2, steamId: '76561198000000008' } };
        void sendText('Different account is available');
      });
      const differentAccountRequest = await waitRequest(writes, differentAccountIndex + 1);
      assert.equal(differentAccountRequest.body.steamAccountId, '76561198000000008');
      await respond(differentAccountRequest, 400, { error: 'Test rejection', uncertain: false });
      await page.waitForFunction(() => [...outgoingMessages.values()].some(entry => entry.retryText === 'Different account is available' && entry.state === 'failed'));
      await page.evaluate(() => { state.steam = globalThis.savedCooldownSteam; refreshOutgoing(); updateChatAvailability(); });
      assert.equal(await page.locator('#sendButton').isDisabled(), true);
      await page.evaluate(() => { globalThis.cooldownRows = [...document.querySelectorAll('.msg-row')]; });
      const expiryWriteCount = writes.length;
      await page.clock.fastForward(1000);
      assert.equal(await limitedRow.locator('.outgoing-retry').innerText(), '29 秒后可重试');
      await page.clock.fastForward(28000);
      assert.equal(await limitedRow.locator('.outgoing-retry').innerText(), '1 秒后可重试');
      await page.clock.fastForward(1000);
      assert.equal(await limitedRow.locator('.outgoing-retry').innerText(), '重试发送');
      assert.equal(await limitedRow.locator('.outgoing-retry').isEnabled(), true);
      assert.equal(await cooldownUnknown.row.locator('.outgoing-resend').innerText(), '仍要发送一份');
      assert.equal(await cooldownUnknown.row.locator('.outgoing-resend').isEnabled(), true);
      assert.equal(await page.locator('#sendButton').isEnabled(), true);
      assert.equal(await page.locator('#messageInput').inputValue(), 'Draft stays through expiry');
      assert.equal(writes.length, expiryWriteCount, 'expiry does not automatically send');
      assert.equal(await page.evaluate(() => globalThis.cooldownRows.every((row, index) => row === document.querySelectorAll('.msg-row')[index])), true, 'ticks preserve history/media nodes');
      await limitedRow.locator('.outgoing-retry').click();
      const afterCooldown = await waitRequest(writes, expiryWriteCount + 1);
      assert.deepEqual(afterCooldown.body, limitedRequest.body, 'manual retry after expiry keeps the original body');
      await respond(afterCooldown, 429, { code: 'steam_rate_limited', error: 'Friendly rate limit', uncertain: false });
      await limitedRow.getByRole('button', { name: '30 秒后可重试' }).waitFor();
      assert.equal(await page.locator('#messageInput').inputValue(), 'Draft stays through expiry');
      assert.deepEqual(await page.evaluate(() => {
        invalidateChat();
        return { timerStopped: textCooldownTimer === null, cacheCleared: textAccountCooldowns.size === 0 };
      }), { timerStopped: true, cacheCleared: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: manual text actions, account cooldown controls, draft preservation, expiry and timer cleanup`);
      await page.close();
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
