// npm run build
// NODE_PATH=<existing Playwright installation>/node_modules node test/browser/web-redesign.cjs
// All requests are intercepted; no Steam connection, uploads or additional dependencies.
const { chromium } = require('playwright');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const permissions = ['user.view', 'user.manage', 'role.manage', 'session.manage', 'audit.view', 'steam.manage',
  'steam.account.manage', 'steam.grant.manage', 'steam.account.all', 'chat.use', 'emote.manage', 'self.password.change'];
const account = '76561198000000009', alice = '76561198000000001', bob = '76561198000000002';
const identities = {
  super: { roleId: 'super', permissions, level: 'full', scope: 'all', pages: ['Steam 账户', '用户', '角色与权限', '审计日志', '图片表情', '设置'] },
  scoped: { roleId: 'member', permissions: ['chat.use', 'emote.manage', 'self.password.change'], level: 'chat', scope: 'some', pages: ['图片表情', '设置'] },
  reader: { roleId: 'member', permissions: ['chat.use', 'self.password.change'], level: 'read', scope: 'all', pages: ['设置'] }
};
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function fixture(t, identity = 'super', width = 1440, initialView = 'chat', colorScheme = 'light', touch = false) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme, serviceWorkers: 'block', hasTouch: touch, isMobile: touch });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors = [], requests = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, () => {});
  const profile = identities[identity];
  const user = { id: 1, username: identity, displayName: '测试用户', roleId: profile.roleId, roleName: identity === 'super' ? '超级管理员' : '成员' };
  const steam = { status: 'online', steamId: account, activeAccount: { id: 1, steamId: account, label: '主号' }, accessAllowed: true,
    steamGrant: { level: profile.level, scope: profile.scope, peerCount: 1, peers: profile.scope === 'some' ? [alice] : [], expiresAt: null, via: identity === 'super' ? 'all' : 'grant' } };
  const me = { user, permissions: [...profile.permissions], permissionDetails: profile.permissions.map(permission => ({ permission, effective: true,
    source: identity === 'scoped' && permission === 'emote.manage' ? 'grant' : identity === 'super' ? 'super' : 'role' })), steam,
    config: { wsPath: '/ws', historyLimit: 100 } };
  const friends = [{ id: alice, name: 'Alice', nickname: '阿丽', online: true }, ...(identity === 'scoped' ? [] : [{ id: bob, name: 'Bob', online: true }])];
  const conversations = friends.map((friend, i) => ({ ...friend, preview: '测试会话', updatedAt: new Date(1800000000000 - i * 60000).toISOString() }));
  const roles = [{ id: 'super', name: '超级管理员', description: '全部权限', permissions, builtin: true, memberCount: 1 },
    { id: 'member', name: '成员', description: '默认成员', permissions: ['chat.use', 'self.password.change'], builtin: true, memberCount: 1 }];
  let denial = null;
  let inventoryHold = null;
  let releaseInventory = null;
  let inventoryPayload = { emoticons: [{ name: 'wave', title: 'Wave' }], stickers: [{ name: 'CatchHeart', title: 'Heart' }], effects: [{ name: 'snow', title: 'Snow' }] };
  await page.addInitScript(view => {
    localStorage.setItem('steam-chat.view', view);
    localStorage.setItem('steam-chat.list-tab', 'recent');
  }, initialView);
  await page.route('http://redesign.test/**', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(url.pathname);
    if (request.method() !== 'GET') writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === '/message') {
      if (denial) return route.fulfill({ status: 403, json: denial });
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/emoticons' && inventoryHold) {
      await inventoryHold;
      return route.fulfill({ status: 503, json: { error: 'Inventory refresh failed' } });
    }
    const data = {
      '/api/auth/me': me, '/api/config': me.config, '/api/steam/status': steam,
      '/api/friends': friends, '/api/groups': [], '/api/conversations': { items: conversations },
      '/api/history': { items: [{ id: alice, steamAccountId: account, eventId: 'message-1', name: 'Alice', message: '回归消息', type: 'message', timestamp: 1800000000, ordinal: 0,
        sentAt: '2027-01-15T08:00:00.000Z' }], hasMore: false },
      '/api/messages/sync': { items: [], steamAccountId: account, liveCursor: 'fixture-cursor', nextCursor: 'fixture-cursor', hasMore: false },
      '/api/message-reactions': { items: [] }, '/api/history/status': { jsonl: { state: 'healthy', queued: 0 }, rocksdb: { state: 'healthy', queued: 0 } },
      '/api/emoticons': inventoryPayload,
      '/api/image-emotes': { groups: [], images: [] }, '/api/steam/accounts': { steamAccounts: [{ id: 1, steamId: account, label: '主号', enabled: true, active: true }] },
      '/api/steam/grants': { accounts: [], users: [] }, '/api/users': { users: [user] }, '/api/roles': { roles }, '/api/audit-logs': { logs: [] }
    };
    if (Object.hasOwn(data, url.pathname)) return route.fulfill({ json: data[url.pathname] });
    if (url.pathname.startsWith('/api/')) throw new Error(`Unmocked API: ${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/proxy/')) return route.fulfill({ status: 404 });
    const file = path.join(__dirname, '../../dist/web', url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      return route.fulfill({ body: await fs.readFile(file), contentType: { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }[path.extname(file)] || 'text/html' });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://redesign.test/');
  await page.locator('.shell#chatLayout').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#chatListSections .conv').length > 0);
  return { page, context, profile, me, steam, requests, writes, errors,
    holdInventory: () => { inventoryHold = new Promise(resolve => { releaseInventory = resolve; }); },
    setInventory: payload => { inventoryPayload = payload; },
    releaseInventory: () => releaseInventory?.(), deny: code => {
    denial = { code, error: '授权已调整，请联系管理员' };
    steam.steamGrant = { ...steam.steamGrant, level: 'read', scope: 'some', peerCount: 1, peers: [alice] };
    me.permissions = ['chat.use', 'self.password.change'];
  } };
}

async function noOverflow(page, label) {
  const result = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    app: document.querySelector('#app').scrollWidth, appWidth: document.querySelector('#app').clientWidth,
    sheet: document.querySelector('.sheet') && { width: document.querySelector('.sheet').clientWidth, scroll: document.querySelector('.sheet').scrollWidth } }));
  assert.ok(result.document <= result.viewport + 1, `${label}: document ${JSON.stringify(result)}`);
  assert.ok(result.app <= result.appWidth + 1, `${label}: app ${JSON.stringify(result)}`);
  if (result.sheet) assert.ok(result.sheet.scroll <= result.sheet.width + 1, `${label}: sheet ${JSON.stringify(result)}`);
}

test('saved picker inventory survives reload and can send stickers during a delayed, failed refresh', async t => {
  const f = await fixture(t, 'super', 390, 'chat', 'light', true);
  const { page, writes } = f;
  await page.locator('#chatListSections .conv').first().tap();
  await page.locator('#pickerToggle').tap();
  await page.locator('#picker .picker-grid button').filter({ hasText: 'Wave' }).waitFor();
  await page.waitForFunction(() => localStorage.getItem('steam-chat.inventory.v1'));
  f.holdInventory();
  await page.reload();
  await page.locator('#chatListSections .conv').first().tap();
  await page.locator('#pickerToggle').tap();
  await page.locator('#picker .picker-grid button').filter({ hasText: 'Wave' }).waitFor();
  await page.locator('#picker .picker-tabs').getByRole('button', { name: '贴纸', exact: true }).tap();
  const heart = page.locator('#picker .picker-grid button').filter({ hasText: 'Heart' });
  const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/message');
  await heart.tap(); await sent;
  assert.ok(writes.some(write => write.path === '/message' && write.body.msg === '/sticker CatchHeart'));
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/emoticons' && response.status() === 503);
  f.releaseInventory(); await failed;
  assert.equal(await heart.isEnabled(), true);
  assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), false);
  assert.deepEqual(f.errors, []);
});

test('cold partial inventory keeps healthy emoticons usable and reports the failed category', async t => {
  const f = await fixture(t, 'super', 390, 'chat', 'light', true);
  const { page } = f;
  f.setInventory({ emoticons: [{ name: 'wave', title: 'Wave' }], stickers: [], effects: [],
    cache: { stale: true, failedCategories: ['stickers'], retryAt: Date.now() + 60_000 } });
  await page.locator('#chatListSections .conv').first().tap();
  await page.locator('#pickerToggle').tap();
  await page.locator('#picker .picker-grid button').filter({ hasText: 'Wave' }).tap();
  assert.equal(await page.locator('#messageInput').inputValue(), ':wave:');
  assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), false);
  await page.locator('#picker .picker-tabs').getByRole('button', { name: '贴纸', exact: true }).tap();
  assert.match(await page.locator('#picker .inventory-status').innerText(), /加载失败/);
  assert.match(await page.locator('#picker .picker-grid').innerText(), /尚未加载成功/);
  assert.doesNotMatch(await page.locator('#picker .picker-grid').innerText(), /暂无素材/);
  await noOverflow(page, 'partial inventory');
  assert.deepEqual(f.errors, []);
});

async function enableReactions(page) {
  await page.route('http://redesign.test/api/message-reactions**', route => route.fulfill({ json: route.request().method() === 'POST'
    ? { users: [account] }
    : { items: [{ timestamp: Math.floor(Date.parse('2027-01-15T08:00:00.000Z') / 1000), ordinal: 0, reactions: [] }] } }));
}

test('reaction picker can use saved inventory without waiting for a slow refresh', async t => {
  const f = await fixture(t);
  const { page } = f;
  await page.locator('#chatListSections .conv').first().click();
  await page.locator('#pickerToggle').click();
  await page.locator('#picker .picker-grid button').filter({ hasText: 'Wave' }).waitFor();
  await page.waitForFunction(() => localStorage.getItem('steam-chat.inventory.v1'));
  f.holdInventory();
  await page.reload(); await enableReactions(page);
  await page.locator('#chatListSections .conv').first().click();
  await page.locator('#messages .reaction-add').first().click();
  const heart = page.locator('.reaction-picker button[title="Heart"]');
  await heart.waitFor(); assert.equal(await heart.isEnabled(), true);
  const reacted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/message-reactions' && response.request().method() === 'POST');
  await heart.click(); await reacted;
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/emoticons' && response.status() === 503);
  f.releaseInventory(); await failed;
  assert.deepEqual(f.errors, []);
});

test('background inventory refresh updates an open reaction picker and removes obsolete materials', async t => {
  const f = await fixture(t);
  const { page } = f;
  await enableReactions(page);
  f.setInventory({ emoticons: [], stickers: [{ name: 'CatchHeart', title: 'Old Heart' }], effects: [], cache: { stale: true, refreshing: true } });
  await page.locator('#chatListSections .conv').first().click();
  await page.locator('#messages .reaction-add').first().click();
  await page.locator('.reaction-picker button[title="Old Heart"]').waitFor();
  f.setInventory({ emoticons: [], stickers: [{ name: 'NewHeart', title: 'New Heart' }], effects: [], cache: { stale: false, refreshing: false } });
  await page.locator('.reaction-picker button[title="New Heart"]').waitFor();
  assert.equal(await page.locator('.reaction-picker button[title="Old Heart"]').count(), 0);
  assert.equal(await page.locator('.reaction-picker button[title="New Heart"]').isEnabled(), true);
  assert.deepEqual(f.errors, []);
});

for (const touch of [true, false]) test(`${touch ? 'touch' : 'desktop'} picker preserves keyboard behavior for emoticons, emoji, stickers and effects`, async t => {
  const { page, writes, errors } = await fixture(t, 'super', touch ? 390 : 1440, 'chat', 'light', touch);
  const activate = locator => touch ? locator.tap() : locator.click();
  await activate(page.locator('#chatListSections .conv').first());
  const input = page.locator('#messageInput');
  const isInputFocused = () => input.evaluate(node => document.activeElement === node);
  await input.focus();
  assert.equal(await isInputFocused(), true);
  await activate(page.locator('#pickerToggle'));
  if (touch) assert.equal(await isInputFocused(), false, 'opening the touch picker dismisses the typing keyboard');
  await activate(page.locator('#picker .picker-grid button').filter({ hasText: 'Wave' }));
  assert.equal(await input.inputValue(), ':wave:');
  assert.equal(await isInputFocused(), !touch);
  await activate(page.locator('#picker').getByRole('button', { name: '😀', exact: true }));
  assert.equal(await input.inputValue(), ':wave:😀');
  assert.equal(await isInputFocused(), !touch);
  for (const [tab, title, command] of [['贴纸', 'Heart', '/sticker CatchHeart'], ['效果', 'Snow', '/roomeffect snow']]) {
    await activate(page.locator('#picker .picker-tabs').getByRole('button', { name: tab, exact: true }));
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/message' && response.request().postDataJSON()?.msg === command);
    await activate(page.locator('#picker .picker-grid button').filter({ hasText: title }));
    await sent;
    assert.equal(await isInputFocused(), !touch);
    assert.ok(writes.some(write => write.path === '/message' && write.body.msg === command));
  }
  assert.deepEqual(errors, []);
});

test('forced password change keeps quick navigation and the console behind the password card', async t => {
  const { page, me, errors } = await fixture(t);
  me.user.forcePasswordChange = true;
  await page.reload();
  await page.getByRole('heading', { name: '设置新密码' }).waitFor();
  assert.equal(await page.locator('#chatLayout').count(), 0);
  await page.keyboard.press('Control+k');
  assert.equal(await page.locator('.palette').count(), 0);
  assert.equal(await page.locator('.sheet').count(), 0);
  assert.deepEqual(errors, []);
});

for (const identity of Object.keys(identities)) for (const width of [390, 960, 1440]) {
  test(`${identity} ${width}px: permissions, console navigation, composer, picker, drop and layout`, async t => {
    const f = await fixture(t, identity, width), { page, profile } = f;
    await noOverflow(page, 'conversation list');
    assert.equal(await page.locator('#chatLayout').getAttribute('data-mobile'), 'list');
    assert.equal(await page.locator('[data-chat-tab="groups"]').isVisible(), identity !== 'scoped');
    assert.equal(await page.locator('.new-chat-btn').isVisible(), identity !== 'scoped');
    await page.locator('#chatListSections .conv').first().click();
    assert.equal(await page.locator('#chatLayout').getAttribute('data-mobile'), 'thread');
    await page.locator('#messages .msg .msg-body').waitFor();
    assert.equal(await page.locator('#messageInput').isVisible(), identity !== 'reader');
    assert.equal(await page.locator('#sendButton').isDisabled(), identity === 'reader');
    assert.equal(await page.locator('#attachmentToggle').isDisabled(), identity !== 'super');
    assert.equal(await page.locator('.msg-tools').getByRole('button', { name: '添加表情回应', exact: true }).isDisabled(), identity !== 'super');
    if (identity !== 'super') assert.match(await page.locator('#chatScopeNote').innerText(), identity === 'reader' ? /只读/ : /聊天.*仅 1 位指定好友/);
    if (identity === 'reader') assert.match(await page.locator('#offlineNote').innerText(), /只读.*不能发送/);
    else {
      await page.locator('#pickerToggle').click();
      for (const name of ['贴纸', '效果', '自定义']) {
        await page.locator('.picker-tabs').getByRole('button', { name, exact: true }).click();
        if (identity === 'scoped') {
          assert.match(await page.locator('#picker').innerText(), /需要「完整」授权/);
          assert.equal(await page.locator('#picker .picker-grid button').count(), 0);
        } else assert.doesNotMatch(await page.locator('#picker').innerText(), /需要「完整」授权/);
      }
      await noOverflow(page, 'picker'); await page.keyboard.press('Escape');
      if (await page.locator('#picker').isVisible()) await page.locator('#pickerToggle').click();
    }
    const drag = await page.evaluate(() => {
      const data = new DataTransfer(); data.items.add(new File(['fixture'], 'drop.png', { type: 'image/png' }));
      const event = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data });
      document.querySelector('.cthread').dispatchEvent(event);
      const accepted = event.defaultPrevented, visible = !document.querySelector('.drop-overlay').hidden;
      document.querySelector('.cthread').dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: data }));
      return { accepted, visible };
    });
    assert.deepEqual(drag, { accepted: identity === 'super', visible: identity === 'super' });
    await noOverflow(page, 'thread');
    if (width === 390) await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.locator('.cstatus').click(); await page.locator('.sheet').waitFor();
    assert.deepEqual(await page.locator('.sheet-links button .nav-label').allTextContents(), profile.pages);
    for (const label of profile.pages) {
      await page.locator('.sheet-links').getByRole('button', { name: label, exact: true }).click();
      await noOverflow(page, `console ${label}`);
    }
    await page.keyboard.press('Escape'); await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.cstatus').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, []);
  });
}

test('console closes by Escape, close button and scrim, and restores focus', async t => {
  const { page, errors } = await fixture(t);
  for (const close of ['Escape', 'button', 'scrim']) {
    await page.locator('.cstatus').click(); await page.locator('.sheet').waitFor();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else if (close === 'button') await page.getByRole('button', { name: '关闭控制台', exact: true }).click();
    else await page.locator('.sheet-scrim').click({ position: { x: 2, y: 2 } });
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.cstatus').evaluate(node => node === document.activeElement), true);
  }
  assert.deepEqual(errors, []);
});

test('console drafts require confirmation, cancel retains draft and discard performs no writes', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('.cstatus').click();
  await page.locator('.sheet-links').getByRole('button', { name: '角色与权限', exact: true }).click();
  await page.locator('.roles-split .list-pane .urow').filter({ has: page.getByText('成员', { exact: true }) }).click();
  await page.getByRole('checkbox', { name: '成员：查看用户', exact: true }).check();
  await page.locator('.savebar').waitFor();
  assert.equal(f.writes.length, 0, 'changes stay local until save');
  await page.keyboard.press('Escape');
  const modal = page.getByRole('dialog', { name: '确认操作', exact: true });
  await modal.waitFor(); assert.match(await modal.innerText(), /放弃未保存的更改/);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '成员：查看用户', exact: true }).isChecked(), true);
  assert.equal(await page.locator('.savebar').isVisible(), true);
  await page.locator('.sheet-links').getByRole('button', { name: '设置', exact: true }).click();
  await modal.waitFor(); await modal.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('.sheet-head h1').filter({ hasText: '设置' }).waitFor();
  await page.locator('.sheet-links').getByRole('button', { name: '角色与权限', exact: true }).click();
  const permission = page.getByRole('checkbox', { name: '成员：查看用户', exact: true });
  assert.equal(await permission.isChecked(), false, 'discard restores the original role permissions');
  await permission.check(); await page.locator('.savebar').waitFor();
  await page.getByRole('button', { name: '关闭控制台', exact: true }).click();
  await modal.waitFor(); await modal.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('.sheet').waitFor({ state: 'detached' });
  assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});

for (const code of ['steam_grant_insufficient', 'steam_peer_out_of_scope']) {
  test(`${code}: send denial refreshes me, preserves the server error and updates composer`, async t => {
    const f = await fixture(t), { page } = f;
    await page.locator('#chatListSections .conv').first().click();
    const before = f.requests.filter(value => value === '/api/auth/me').length;
    f.deny(code);
    await page.locator('#messageInput').fill('denied message'); await page.locator('#sendButton').click();
    await page.waitForFunction(() => document.querySelector('#offlineNote').textContent.includes('只读'));
    await page.locator('#feedback').filter({ hasText: '授权已调整，请联系管理员' }).waitFor();
    assert.equal(f.requests.filter(value => value === '/api/auth/me').length, before + 1);
    assert.match(await page.locator('#feedback').innerText(), /授权已调整，请联系管理员/);
    assert.equal(await page.locator('#messageInput').isVisible(), false);
    assert.equal(await page.locator('#sendButton').isDisabled(), true);
    assert.deepEqual(f.errors, []);
  });
}

test('Ctrl/Meta K supports arrow selection, Enter navigation, filtering and Escape focus restoration', async t => {
  const { page, errors } = await fixture(t, 'scoped');
  await page.locator('.jump').focus(); await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '快速跳转', exact: true }); await palette.waitFor();
  const input = palette.getByRole('combobox');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  const selected = () => palette.locator('[role="option"][aria-selected="true"]').innerText();
  assert.match(await selected(), /Alice/);
  await input.press('ArrowDown'); assert.equal(await selected(), '图片表情');
  await input.press('ArrowUp'); assert.match(await selected(), /Alice/);
  await input.fill('设置'); assert.equal(await selected(), '设置'); await input.press('Enter');
  await page.locator('.sheet-head h1').filter({ hasText: '设置' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.jump').focus(); await page.keyboard.press('Meta+k'); await palette.waitFor();
  await input.fill('Bob'); assert.equal(await palette.getByRole('option').count(), 0, 'scoped users cannot jump to invisible peers');
  await input.fill('用户'); assert.equal(await palette.getByRole('option').count(), 0, 'unauthorized console pages are absent');
  await page.keyboard.press('Escape'); await palette.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.jump').evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});

test('theme auto follows system; light/dark override system and persist across reload', async t => {
  const { page, errors } = await fixture(t, 'reader');
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const choose = async label => { await page.locator('.me-btn').click(); await page.locator('.me-menu').getByRole('button', { name: `主题 · ${label}`, exact: true }).click(); };
  await choose('跟随系统'); const light = await background();
  await page.emulateMedia({ colorScheme: 'dark' }); const dark = await background(); assert.notEqual(dark, light);
  await choose('浅色'); assert.equal(await background(), light);
  await page.reload(); await page.locator('.shell').waitFor(); assert.equal(await background(), light);
  assert.equal(await page.evaluate(() => localStorage.getItem('steam-chat.theme')), 'light');
  await choose('深色'); await page.emulateMedia({ colorScheme: 'light' }); assert.equal(await background(), dark);
  await page.reload(); await page.locator('.shell').waitFor(); assert.equal(await background(), dark);
  assert.equal(await page.evaluate(() => localStorage.getItem('steam-chat.theme')), 'dark');
  await choose('跟随系统'); assert.equal(await background(), light);
  assert.equal(await page.evaluate(() => localStorage.getItem('steam-chat.theme')), 'auto');
  await page.emulateMedia({ colorScheme: 'dark' }); assert.equal(await background(), dark);
  await page.reload(); await page.locator('.shell').waitFor(); assert.equal(await background(), dark);
  assert.deepEqual(errors, []);
});

test('an unauthorized persisted console page falls back to the chat shell', async t => {
  const { page, errors } = await fixture(t, 'reader', 390, 'steamAccounts');
  assert.equal(await page.locator('.sheet').count(), 0);
  await page.locator('.cstatus').click();
  await page.locator('.sheet-head h1').filter({ hasText: '设置' }).waitFor();
  assert.deepEqual(await page.locator('.sheet-links button .nav-label').allTextContents(), ['设置']);
  assert.deepEqual(errors, []);
});

async function loginFixture(t) {
  const f = await fixture(t), { page, steam } = f;
  steam.status = 'logged_out';
  const actions = [];
  await page.route(/\/api\/steam\/(?:login\/qr|accounts\/login|guard)$/, async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname;
    actions.push({ endpoint, method: request.method(), body: request.postData() ? request.postDataJSON() : null });
    if (endpoint.endsWith('/login/qr')) {
      steam.status = request.method() === 'DELETE' ? 'logged_out' : 'waiting_qr';
      steam.qrLogin = request.method() === 'DELETE' ? null : {
        imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        expiresAt: Date.now() + 60000, scanned: false
      };
    } else if (endpoint.endsWith('/accounts/login')) {
      steam.status = 'waiting_guard'; steam.requiresGuard = true; steam.guardType = 'email'; steam.domain = 'example.test';
    } else { steam.status = 'online'; steam.requiresGuard = false; }
    await route.fulfill({ json: steam });
  });
  await page.reload(); await page.locator('.shell').waitFor();
  await page.locator('.cstatus').click(); await page.locator('.sheet').waitFor();
  await page.getByRole('button', { name: '添加账户', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加 Steam 账户', exact: true });
  await modal.waitFor();
  return { ...f, modal, actions };
}

test('add-account modal starts and cancels QR login and locks the password tab while waiting', async t => {
  const { modal, actions, errors } = await loginFixture(t);
  await modal.getByRole('button', { name: '扫码登录 Steam', exact: true }).click();
  await modal.locator('#steamQrLogin img').waitFor();
  assert.deepEqual(actions[0], { endpoint: '/api/steam/login/qr', method: 'POST', body: null });
  await modal.getByRole('button', { name: '密码登录', exact: true }).click();
  const passwordLocked = await modal.locator('[name="accountName"]').isDisabled();
  await modal.getByRole('button', { name: '扫码登录', exact: true }).click();
  await modal.getByRole('button', { name: '取消扫码登录', exact: true }).click();
  await modal.getByRole('button', { name: '重新生成二维码', exact: true }).waitFor();
  assert.deepEqual(actions[1], { endpoint: '/api/steam/login/qr', method: 'DELETE', body: null });
  assert.equal(passwordLocked, true, 'QR waiting locks password submission');
  assert.deepEqual(errors, []);
});

test('add-account modal submits the account endpoint and supports five-digit Guard paste', async t => {
  const { page, modal, actions, errors } = await loginFixture(t);
  await modal.getByRole('button', { name: '密码登录', exact: true }).click();
  await modal.locator('[name="accountName"]').fill('fixture-account');
  await modal.locator('[name="password"]').fill('fixture-password');
  await modal.locator('[name="label"]').fill('扫码回归'); await modal.locator('[name="logonID"]').fill('42');
  await modal.getByRole('button', { name: '登录账户', exact: true }).click();
  await modal.getByLabel('验证码第 1 位').waitFor();
  assert.deepEqual(actions[0], { endpoint: '/api/steam/accounts/login', method: 'POST',
    body: { accountName: 'fixture-account', password: 'fixture-password', label: '扫码回归', logonID: 42 } });
  assert.equal(await modal.locator('.guard-code input').count(), 5);
  await modal.getByLabel('验证码第 1 位').evaluate(node => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text', 'a1b2c');
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  assert.deepEqual(await modal.locator('.guard-code input').evaluateAll(nodes => nodes.map(node => node.value)), ['A', '1', 'B', '2', 'C']);
  await modal.getByRole('button', { name: '提交验证', exact: true }).click();
  await modal.getByText('已登录，账户已添加。', { exact: true }).waitFor();
  assert.deepEqual(actions[1], { endpoint: '/api/steam/guard', method: 'POST', body: { code: 'A1B2C' } });
  assert.equal(await page.locator('.shell').count(), 1);
  assert.deepEqual(errors, []);
});

for (const [old, current] of [['steam', 'Steam 账户'], ['steamAccounts', 'Steam 账户'], ['account', '设置'], ['imageEmotes', '图片表情']]) {
  test(`legacy ${old} opens ${current} above the persistent chat shell`, async t => {
    const { page, errors } = await fixture(t, 'super', 1440, old);
    await page.locator('.sheet-head h1').filter({ hasText: current }).waitFor();
    assert.equal(await page.locator('.shell').count(), 1);
    await page.keyboard.press('Escape'); await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => localStorage.getItem('steam-chat.view')), 'chat');
    assert.deepEqual(errors, []);
  });
}
