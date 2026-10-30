import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the built browser code and its real event handlers without a browser dependency.
class Element {
  id = ''; className = ''; name = ''; value = ''; disabled = false;
  src = ''; type = ''; parent: Element | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, (event: any) => unknown>();
  private text = '';
  constructor(public tagName: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set innerHTML(value: string) {
    this.replaceChildren();
    for (const match of value.matchAll(/<(input|button)\b([^>]*)(?:>([^<]*))?/g)) {
      const child = new Element(match[1]);
      for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) (child as any)[attr[1]] = attr[2];
      if (match[1] === 'button') child.textContent = match[3] || '';
      this.append(child);
    }
  }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(child: Element) { child.parent = this; this.children.unshift(child); }
  replaceChildren(...children: Element[]) { this.children = []; this.text = ''; this.append(...children); }
  replaceWith(child: Element) {
    const parent = this.parent!;
    child.parent = parent;
    parent.children[parent.children.indexOf(this)] = child;
    this.parent = null;
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: any) => unknown) { this.listeners.set(name, listener); }
  reset() { this.querySelectorAll('input').forEach(input => { input.value = ''; }); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector: string): Element[] {
    const matches = (node: Element, part: string): boolean => {
      const tokens = part.trim().split(/\s+/);
      const last = tokens.pop()!;
      const own = last.startsWith('#') ? node.id === last.slice(1) : last.startsWith('.')
        ? node.className.split(' ').includes(last.slice(1)) : node.tagName === last;
      if (!own || !tokens.length) return own;
      for (let parent = node.parent; parent; parent = parent.parent) if (matches(parent, tokens.join(' '))) return true;
      return false;
    };
    return this.children.flatMap(child => [
      ...(selector.split(',').some(part => matches(child, part)) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  fire(name: string) { return this.listeners.get(name)?.({ preventDefault() {} }); }
}

function harness(view = 'steam', manage = true) {
  const root = new Element('main');
  const requests: Array<{ path: string; options: any; resolve: (body: unknown, ok?: boolean, status?: number) => void }> = [];
  const intervals: Array<() => Promise<void>> = [];
  let time = 1_000_000;
  const sandbox: any = {
    document: {
      visibilityState: 'visible', createElement: (tag: string) => new Element(tag), addEventListener() {},
      querySelector: (selector: string) => selector === '#app' ? root : root.querySelector(selector),
      querySelectorAll: (selector: string) => root.querySelectorAll(selector)
    },
    localStorage: { getItem: (): null => null, setItem() {} },
    Date: class extends Date { static now() { return time; } },
    Headers, AbortController, URL, URLSearchParams, console,
    WebSocket: { OPEN: 1 },
    FormData: class {
      constructor(private form: Element) {}
      get(name: string) { return this.form.querySelectorAll('input').find(input => input.name === name && !input.disabled)?.value || null; }
    },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (callback: () => Promise<void>) => { intervals.push(callback); return intervals.length; }, clearInterval() {},
    fetch: (path: string, options: any) => new Promise(resolve => requests.push({
      path, options, resolve: (body, ok = true, status = ok ? 200 : 400) => resolve({ ok, status, json: async () => body })
    }))
  };
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  runInNewContext(`${source.slice(0, source.lastIndexOf('bootstrap().catch'))}
    invalidateChat = stopWebSocket = syncFriendDetails = updateChatAvailability = requestDurableSync = () => {};
    ensureWebSocket = () => {};
    renderShell = () => { throw new Error('Unexpected full shell render'); };
    state.me = {id: 1, role: 'admin'};
    state.permissions = ${JSON.stringify(manage ? ['steam.manage', 'steam.account.manage'] : ['steam.account.manage'])};
    state.view = ${JSON.stringify(view)};
    globalThis.testApi = { state, updateSteamStatus, startStatusPolling, changeSteamQrLogin,
      mount(view) { state.view = view; root.replaceChildren(view === 'steam' ? renderSteamView() : renderSteamAccountsView()); syncSteamLoginUi(); } };
  `, sandbox);
  const app = sandbox.testApi;
  app.mount(view);
  const button = (text: string) => root.querySelectorAll('button').find(item => item.textContent === text)!;
  const form = () => root.querySelector('.steam-password-login')!;
  const input = (name: string) => form().querySelectorAll('input').find(item => item.name === name)!;
  const waiting = (qr: Record<string, unknown> | null = null) => app.updateSteamStatus({ status: 'waiting_qr', qrLogin: qr });
  return { ...app, root, requests, button, form, input, waiting, tick: () => intervals[0](), advance: (ms: number) => { time += ms; } };
}

const qr = (overrides: Record<string, unknown> = {}) => ({ imageDataUrl: 'data:image/png;base64,YWJj', scanned: false, expiresAt: 1_060_000, ...overrides });
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

for (const view of ['steam', 'steamAccounts']) {
  test(`${view}: QR start is bodyless, locks password login, and ignores duplicate actions`, async () => {
    const h = harness(view);
    h.input('accountName').value = 'keep-account';
    const form = h.form();
    const start = h.button('扫码登录 Steam');
    const pending = start.fire('click');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].path, '/api/steam/login/qr');
    assert.equal(h.requests[0].options.method, 'POST');
    assert.equal(h.requests[0].options.body, undefined);
    assert.match(h.root.textContent, /正在生成二维码/);
    assert.ok(h.input('accountName').disabled);
    await start.fire('click');
    await form.fire('submit');
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve({ status: 'waiting_qr', qrLogin: null });
    await pending;
    assert.match(h.root.textContent, /正在加载二维码/);
    const data = qr();
    h.waiting(data);
    assert.equal(h.root.querySelector('img')?.src, data.imageDataUrl);
    assert.match(h.root.textContent, /手机 Steam App/);
    assert.equal(h.form(), form);
    assert.equal(h.input('accountName').value, 'keep-account');
    const image = h.root.querySelector('img');
    h.waiting(data);
    assert.equal(h.root.querySelector('img'), image, 'unchanged polls retain the QR image');
    h.waiting(qr({ scanned: true }));
    assert.match(h.root.textContent, /已扫码.*确认登录/);
    assert.equal(h.root.querySelector('img'), null);
    const cancelled = h.button('取消扫码登录').fire('click');
    assert.equal(h.requests[1].options.method, 'DELETE');
    assert.equal(h.requests[1].options.body, undefined);
    assert.ok(h.button('取消扫码登录').disabled);
    h.requests[1].resolve({ status: 'logged_out' });
    await cancelled;
    assert.equal(h.form(), form);
    assert.equal(h.input('accountName').disabled, false);
    assert.equal(h.input('accountName').value, 'keep-account');
    assert.equal(h.root.querySelector('img'), null);
  });

  test(`${view}: successful QR login refreshes account list and current page`, async () => {
    const h = harness(view);
    h.waiting(qr());
    h.updateSteamStatus({ status: 'online', steamId: '76561198000000001', accessAllowed: true,
      activeAccount: { id: 7, steamId: '76561198000000001', label: '扫码账户' } });
    assert.equal(h.root.querySelector('img'), null);
    const request = h.requests.find((item: any) => item.path === '/api/steam/accounts');
    assert.ok(request);
    request.resolve({ steamAccounts: [{ id: 7, steamId: '76561198000000001', label: '扫码账户', enabled: true, active: true }] });
    await settle();
    if (view === 'steam') {
      assert.match(h.root.textContent, /在线/);
      assert.match(h.root.textContent, /扫码账户/);
      assert.equal(h.root.querySelector('.steam-password-login'), null);
      h.mount('steamAccounts');
    } else assert.equal(h.input('accountName').disabled, false);
    assert.match(h.root.querySelector('#steamAccountTable')!.textContent, /扫码账户.*当前活动/);
    assert.ok(h.root.querySelector('.steam-account-connect')!.disabled);
  });

  test(`${view}: password login keeps its endpoint and payload and still enters Guard`, async () => {
    const h = harness(view);
    h.input('accountName').value = 'alice'; h.input('password').value = 'secret';
    h.input('label').value = '客服'; h.input('logonID').value = '42';
    const pending = h.form().fire('submit');
    assert.equal(h.requests[0].path, view === 'steam' ? '/api/steam/login' : '/api/steam/accounts/login');
    assert.deepEqual(JSON.parse(h.requests[0].options.body), { accountName: 'alice', password: 'secret', label: '客服', logonID: 42 });
    assert.ok(h.button('扫码登录 Steam').disabled);
    await h.changeSteamQrLogin('POST');
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve({ status: 'waiting_guard', requiresGuard: true, guardType: 'email', domain: 'example.com' });
    await settle();
    if (view === 'steamAccounts') {
      h.requests[1].resolve({ steamAccounts: [] });
      await pending;
      h.mount('steam');
    } else await pending;
    assert.match(h.root.textContent, /Steam Guard.*邮箱验证码：example.com/);
    assert.ok(h.button('扫码登录 Steam').disabled);
    assert.equal(h.root.querySelector('input')!.name, 'code');
  });
}

test('QR expiry, server failure and request failure each allow regeneration', async () => {
  const h = harness();
  h.waiting(qr()); h.advance(61_000); h.waiting(qr());
  assert.match(h.root.textContent, /二维码已过期/);
  assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.button('重新生成二维码').disabled, false);
  const pending = h.button('重新生成二维码').fire('click');
  assert.equal(h.requests[0].options.method, 'DELETE');
  h.requests[0].resolve({ status: 'logged_out' });
  await settle();
  assert.equal(h.requests[1].options.method, 'POST');
  h.requests[1].resolve({ status: 'waiting_qr', qrLogin: qr({ expiresAt: 1_120_000 }) });
  await pending;
  assert.ok(h.root.querySelector('img'));
  h.updateSteamStatus({ status: 'error', error: 'Steam 拒绝登录' });
  assert.match(h.root.textContent, /Steam 拒绝登录/);
  assert.equal(h.input('password').disabled, false);
  const retry = h.button('重新生成二维码').fire('click');
  h.requests[2].resolve({ error: '二维码生成失败' }, false);
  await retry;
  assert.match(h.root.textContent, /二维码生成失败/);
  assert.equal(h.button('重新生成二维码').disabled, false);
});

test('QR regeneration continues when the server has already expired the old attempt', async () => {
  const h = harness();
  h.waiting(qr()); h.advance(61_000); h.waiting(qr());
  const pending = h.button('重新生成二维码').fire('click');
  h.requests[0].resolve({ error: 'Steam QR login is not pending' }, false, 409);
  await settle();
  assert.equal(h.requests[1].options.method, 'POST');
  h.requests[1].resolve({ status: 'waiting_qr', qrLogin: qr({ expiresAt: 1_120_000 }) });
  await pending;
  assert.ok(h.root.querySelector('img'));
});

test('QR regeneration stops if cancellation fails, and online accounts disable QR login', async () => {
  const h = harness();
  h.waiting(qr()); h.advance(61_000); h.waiting(qr());
  const pending = h.button('重新生成二维码').fire('click');
  h.requests[0].resolve({ error: '无法取消旧二维码' }, false);
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.steam.status, 'waiting_qr');
  assert.match(h.root.textContent, /无法取消旧二维码/);
  h.updateSteamStatus({ status: 'online' });
  assert.ok(h.button('重新生成二维码').disabled);
  assert.match(h.root.textContent, /先退出当前账户/);
  await h.changeSteamQrLogin('POST');
  assert.equal(h.requests.length, 2, 'only account-list refresh is issued on becoming online');
});

test('failed cancellation retains QR wait, password lock and a retryable cancel action', async () => {
  const h = harness(); h.waiting(qr());
  const pending = h.button('取消扫码登录').fire('click');
  h.requests[0].resolve({ error: '取消失败' }, false);
  await pending;
  assert.equal(h.state.steam.status, 'waiting_qr');
  assert.match(h.root.textContent, /取消失败/);
  assert.ok(h.input('password').disabled);
  assert.equal(h.button('取消扫码登录').disabled, false);
});

test('expiry remains actionable when status polling fails', async () => {
  const h = harness(); h.waiting(qr()); h.startStatusPolling(); h.advance(61_000);
  const poll = h.tick();
  h.requests[0].resolve({ error: '暂时无法读取状态' }, false);
  await poll;
  assert.match(h.root.textContent, /二维码已过期/);
  assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.button('重新生成二维码').disabled, false);
});

test('read-only connection page still updates access changes while Steam remains online', () => {
  const h = harness('steam', false);
  h.state.me.role = 'user'; h.mount('steam');
  h.updateSteamStatus({ status: 'online', steamId: '123', accessAllowed: true });
  assert.match(h.root.textContent, /普通用户只能/);
  h.updateSteamStatus({ status: 'online', steamId: '123', accessAllowed: false });
  assert.match(h.root.textContent, /当前账号未被授权访问活动 Steam 账户/);
});

test('polling updates QR locally every five seconds and rejects pre-action responses', async () => {
  const h = harness();
  const form = h.form();
  h.input('password').value = 'keep-draft';
  h.startStatusPolling();
  const stalePoll = h.tick();
  const start = h.button('扫码登录 Steam').fire('click');
  h.requests[1].resolve({ status: 'waiting_qr', qrLogin: qr() });
  await start;
  h.requests[0].resolve({ status: 'logged_out' });
  await stalePoll;
  assert.equal(h.state.steam.status, 'waiting_qr');
  h.advance(5000);
  const poll = h.tick();
  assert.equal(h.requests[2].path, '/api/steam/status');
  h.requests[2].resolve({ status: 'waiting_qr', qrLogin: qr({ imageDataUrl: 'data:image/png;base64,ZGVm' }) });
  await poll;
  assert.equal(h.root.querySelector('img')!.src, 'data:image/png;base64,ZGVm');
  assert.equal(h.form(), form);
  assert.equal(h.input('password').value, 'keep-draft');
});

test('account connect is disabled during QR wait and entries honor steam.manage permission', async () => {
  const h = harness('steamAccounts');
  h.state.steamAccounts = [{ id: 1, steamId: '123', enabled: true, active: false }];
  h.mount('steamAccounts');
  const connect = h.root.querySelector('.steam-account-connect')!;
  h.waiting(qr());
  assert.ok(connect.disabled);
  await connect.fire('click');
  assert.equal(h.requests.length, 0);
  h.updateSteamStatus({ status: 'logged_out' });
  assert.equal(connect.disabled, false);
  for (const view of ['steam', 'steamAccounts']) {
    const restricted = harness(view, false);
    assert.equal(restricted.root.querySelector('#steamQrLogin'), null);
    await restricted.changeSteamQrLogin('POST');
    assert.equal(restricted.requests.length, 0);
  }
});
