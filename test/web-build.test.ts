'use strict';

export {};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const projectRoot = path.resolve(__dirname, '../..');
const { buildWeb } = require(path.join(projectRoot, 'scripts/build-web.cjs'));
const hashBytes = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-chat-web-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  for (const name of ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'icons', 'sounds', 'third-party']) {
    fs.cpSync(path.join(projectRoot, 'web', name), path.join(root, 'web', name), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'dist/web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/web/app.js'), 'console.log("fixture app");');
  fs.mkdirSync(path.join(root, 'node_modules/artplayer/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/artplayer/dist/artplayer.mjs'), 'export default {};');
  return root;
}

// Execute the generated worker against browser-like CacheStorage and real Response
// objects. Network bytes come from a build directory, not SW source-text assertions.
function worker(root: string, storage = new Map<string, Map<string, Response>>()) {
  const origin = 'https://chat.example';
  const absolute = (url: string) => new URL(url, origin).href;
  const listeners = new Map<string, (event: any) => void>();
  const requests: { url: string; options: any }[] = [];
  let offline = false;
  let badPath = '';
  let badStatus = 200;
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  const caches = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name)!;
      return {
        async put(url: string, response: Response) { entries.set(absolute(url), response.clone()); },
        async match(url: string) { return entries.get(absolute(url))?.clone(); }
      };
    },
    async keys() { return [...storage.keys()]; },
    async delete(name: string) { return storage.delete(name); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dist/web/sw.js'), 'utf8'), {
    self: {
      location: { origin },
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      skipWaiting: () => { skipWaitingCalls++; },
      clients: { claim: () => { claimCalls++; } }
    },
    caches, URL, Response, Uint8Array, crypto: webcrypto,
    fetch: async (url: string, options: any) => {
      requests.push({ url, options });
      if (offline) throw new TypeError('Network offline');
      const pathname = new URL(url).pathname;
      if (pathname === badPath) return new Response('wrong build or error page', { status: badStatus });
      return new Response(fs.readFileSync(path.join(root, 'dist/web', pathname)));
    }
  });
  return {
    storage, requests,
    offline() { offline = true; },
    corrupt(pathname: string, status = 200) { badPath = pathname; badStatus = status; },
    lifecycleCalls() { return { skipWaitingCalls, claimCalls }; },
    async dispatch(name: string) {
      let completion: Promise<void> | undefined;
      listeners.get(name)!({ waitUntil(value: Promise<void>) { completion = value; } });
      await completion;
    },
    request(url: string, mode = 'cors', method = 'GET'): Promise<Response> | undefined {
      let response: Promise<Response> | undefined;
      listeners.get('fetch')!({
        request: { url: absolute(url), mode, method },
        respondWith(value: Promise<Response>) { response = value; }
      });
      return response;
    }
  };
}

test('web app build emits a browser-compatible script', () => {
  const appPath = path.resolve(__dirname, '../web/app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');

  assert.doesNotMatch(appSource, /\bexports\b|module\.exports|require\(/);
});

test('web app build emits the local chat icon assets', () => {
  const iconDir = path.resolve(__dirname, '../web/icons');
  const icons = ['arrow-left', 'image', 'link', 'paperclip', 'plus', 'search', 'send', 'smile', 'x', 'panel-right', 'messages-square', 'gamepad-2', 'users', 'settings-2', 'shield', 'scroll-text', 'log-out', 'external-link'];

  for (const icon of icons) {
    const source = fs.readFileSync(path.join(iconDir, `${icon}.svg`), 'utf8');
    assert.match(source, /@license lucide/);
    assert.match(source, /<svg\b/);
  }
});

test('built HTML uses exact content hashes while source HTML stays unversioned', () => {
  const output = path.join(projectRoot, 'dist/web');
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(projectRoot, 'web/index.html'), 'utf8');
  for (const name of ['app.js', 'style.css']) {
    const hash = hashBytes(fs.readFileSync(path.join(output, name)));
    assert.ok(html.includes(`"/${name}?v=${hash}"`));
    assert.ok(source.includes(`"/${name}"`));
    assert.ok(!source.includes(`/${name}?v=`));
  }
});

test('build versions are reproducible and track JS, CSS, HTML, icons and worker policy', (t: any) => {
  const root = fixture(t);
  const sourceHtml = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  let previous = buildWeb(root);
  const firstWorker = fs.readFileSync(path.join(root, 'dist/web/sw.js'), 'utf8');
  assert.deepEqual(buildWeb(root), previous);
  assert.equal(fs.readFileSync(path.join(root, 'dist/web/sw.js'), 'utf8'), firstWorker);
  for (const [name, suffix] of [
    ['dist/web/app.js', '\nconsole.log("new app");'],
    ['web/style.css', '\nbody { color: red; }'],
    ['web/index.html', '\n<!-- new shell -->'],
    ['web/icons/send.svg', '\n<!-- new icon -->'],
    ['web/sw.js', '\n// new cache policy']
  ]) {
    fs.appendFileSync(path.join(root, name), suffix);
    const current = buildWeb(root);
    assert.notEqual(current.version, previous.version, name);
    assert.deepEqual(buildWeb(root), current);
    for (const entry of current.resources) {
      const bytes = fs.readFileSync(path.join(root, 'dist/web', entry.url.split('?')[0]));
      assert.equal(entry.hash, hashBytes(bytes));
      if (/^\/(app.js|style.css)\?/.test(entry.url)) assert.ok(entry.url.endsWith(`?v=${entry.hash}`));
    }
    previous = current;
  }
  assert.equal(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'), sourceHtml + '\n<!-- new shell -->');
  fs.writeFileSync(path.join(root, 'dist/web/icons/stale.svg'), '<svg/>');
  buildWeb(root);
  assert.equal(fs.existsSync(path.join(root, 'dist/web/icons/stale.svg')), false);
});

test('worker serves an offline shell and exact public assets, never intercepts private or unknown URLs', async (t: any) => {
  const root = fixture(t);
  const build = buildWeb(root);
  const sw = worker(root);
  await sw.dispatch('install');
  await sw.dispatch('activate');
  assert.equal(sw.requests.length, build.resources.length);
  for (const request of sw.requests) {
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.redirect, 'error');
  }
  sw.offline();
  for (const url of ['/', '/index.html']) {
    const response = (await sw.request(url, 'navigate'))!;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fs.readFileSync(path.join(root, 'dist/web/index.html'), 'utf8'));
  }
  for (const entry of build.resources.filter((entry: any) => entry.url !== '/index.html')) {
    const response = (await sw.request(entry.url))!;
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(root, 'dist/web', entry.url.split('?')[0])));
  }
  const app = build.resources.find((entry: any) => entry.url.startsWith('/app.js?')).url;
  for (const url of [
    '/api/auth', '/api/session', '/api/chats', '/api/history', '/api/images/private.png',
    '/images/avatar.png', '/icons/unknown.svg', '/icons/send.svg?user=123',
    '/app.js', '/style.css', '/app.js?v=0000000000000000', `${app}&extra=1`,
    '/manifest.webmanifest?x=1', '/sw.js', '/sounds/default.m4a', '/vendor/artplayer-5.4.0.mjs',
    '/unknown', '/?token=private', '/index.html?token=private',
    'https://other.example/icons/send.svg'
  ]) {
    assert.equal(sw.request(url), undefined, url);
    assert.equal(sw.request(url, 'navigate'), undefined, url);
  }
  assert.equal(sw.request('/index.html'), undefined);
  assert.equal(sw.request('/icons/send.svg', 'cors', 'POST'), undefined);
  assert.equal(sw.request(app, 'cors', 'HEAD'), undefined);
  assert.equal(sw.requests.length, build.resources.length, 'cache hits and bypasses perform no worker fetches');
  assert.deepEqual(sw.lifecycleCalls(), { skipWaitingCalls: 0, claimCalls: 0 });
  const cached = [...sw.storage.values()][0];
  assert.deepEqual([...cached.keys()].sort(), build.resources.map((entry: any) => `https://chat.example${entry.url}`).sort());
});

test('new installation preserves the old coherent shell until activation, then cleans only app caches', async (t: any) => {
  const root = fixture(t);
  const oldBuild = buildWeb(root);
  const oldHtml = fs.readFileSync(path.join(root, 'dist/web/index.html'), 'utf8');
  const oldWorker = worker(root);
  await oldWorker.dispatch('install');
  await oldWorker.dispatch('activate');
  fs.appendFileSync(path.join(root, 'dist/web/app.js'), '\nconsole.log("version two");');
  fs.appendFileSync(path.join(root, 'web/style.css'), '\n/* version two */');
  const nextBuild = buildWeb(root);
  const nextWorker = worker(root, oldWorker.storage);
  oldWorker.storage.set('another-app-cache', new Map());
  await nextWorker.dispatch('install');
  oldWorker.offline();
  assert.equal(await (await oldWorker.request('/', 'navigate'))!.text(), oldHtml);
  const oldApp = oldBuild.resources.find((entry: any) => entry.url.startsWith('/app.js?')).url;
  assert.equal(await (await oldWorker.request(oldApp))!.text(), 'console.log("fixture app");');
  assert.equal(oldWorker.storage.has(`steam-chat-shell-${oldBuild.version}`), true);
  assert.deepEqual(nextWorker.lifecycleCalls(), { skipWaitingCalls: 0, claimCalls: 0 });
  await nextWorker.dispatch('activate');
  assert.deepEqual([...oldWorker.storage.keys()].sort(), ['another-app-cache', `steam-chat-shell-${nextBuild.version}`].sort());
  nextWorker.offline();
  assert.equal(await (await nextWorker.request('/', 'navigate'))!.text(), fs.readFileSync(path.join(root, 'dist/web/index.html'), 'utf8'));
  assert.equal(nextWorker.request(oldApp), undefined);
});

test('mixed deployment bytes, HTTP errors and offline installs reject without replacing the old cache', async (t: any) => {
  const root = fixture(t);
  const oldBuild = buildWeb(root);
  const oldWorker = worker(root);
  await oldWorker.dispatch('install');
  fs.appendFileSync(path.join(root, 'dist/web/app.js'), '\n// next build');
  const nextBuild = buildWeb(root);
  for (const failure of ['hash', 'http', 'offline']) {
    const nextWorker = worker(root, oldWorker.storage);
    if (failure === 'offline') nextWorker.offline();
    else nextWorker.corrupt('/index.html', failure === 'http' ? 503 : 200);
    await assert.rejects(nextWorker.dispatch('install'));
    assert.equal(oldWorker.storage.has(`steam-chat-shell-${oldBuild.version}`), true);
    assert.equal(oldWorker.storage.has(`steam-chat-shell-${nextBuild.version}`), false);
  }
});
