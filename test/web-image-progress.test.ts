import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

class Element {
  id = '';
  className = '';
  textContent = '';
  value: string | number = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  listeners = new Map<string, (event: any) => void>();
  constructor(public tagName: string) {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'value') this.value = ''; }
  hasAttribute(name: string) { return this.attributes.has(name) || (name === 'value' && this.value !== ''); }
  addEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, handler); }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const data = /^\[data-(transfer-id|stage)(?:="([^"]+)")?\]$/.exec(selector);
    if (data) {
      const key = data[1] === 'transfer-id' ? 'transferId' : 'stage';
      return data[2] === undefined ? key in this.dataset : this.dataset[key] === data[2];
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.split(',').some(part => child.matches(part.trim())) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
}

type Transfer = { id: number; context: string; peerId: string; name: string; stage: string; percent: number | null; error?: string };
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
function harness() {
  const root = new Element('main');
  const requests: MockXHR[] = [];
  const fetches: Array<{ path: string; options: RequestInit }> = [];
  const readers: Reader[] = [];
  const history: Array<() => void> = [];
  class Reader {
    result: string | null = null;
    aborted = false;
    onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    constructor() { readers.push(this); }
    readAsDataURL() {}
    abort() { this.aborted = true; this.onabort?.(); }
    finish() { this.result = 'data:image/png;base64,YWJj'; this.onload?.(); }
  }
  class MockXHR {
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null, onload: null as (() => void) | null };
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    onabort?: () => void;
    timeout = 0;
    withCredentials = false;
    status = 0;
    responseText = '';
    method = '';
    path = '';
    async = false;
    body: unknown;
    sends = 0;
    aborted = false;
    headers = new Headers();
    constructor() { requests.push(this); }
    open(method: string, path: string, async: boolean) { this.method = method; this.path = path; this.async = async; }
    setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
    send(body: unknown) { this.body = body; this.sends++; }
    abort() { this.aborted = true; this.onabort?.(); }
    progress(loaded: number, total: number, lengthComputable = true) { this.upload.onprogress?.({ loaded, total, lengthComputable }); }
    respond(status: number, payload: unknown) { this.status = status; this.responseText = JSON.stringify(payload); this.onload?.(); }
  }
  class SandboxURL extends URL {
    static createObjectURL() { return 'blob:test-image'; }
    static revokeObjectURL() {}
  }
  const sandbox = {
    document: { querySelector: (selector: string) => selector === '#app' ? root : root.querySelector(selector),
      querySelectorAll: (selector: string) => root.querySelectorAll(selector), createElement: (tag: string) => new Element(tag),
      addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (): null => null, setItem() {} },
    XMLHttpRequest: MockXHR, FileReader: Reader, URL: SandboxURL, URLSearchParams, Headers, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (path: string, options: RequestInit) => { fetches.push({ path, options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    holdHistory: () => new Promise<void>(resolve => history.push(resolve)),
    __test: undefined as unknown
  };
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  runInNewContext(`${source.slice(0, source.lastIndexOf('bootstrap().catch'))}
    state.me = {id:1}; state.view = 'chat'; state.activeId = 'peer';
    state.steam = {...state.steam, status:'online', accessAllowed:true, steamId:'account-A'};
    root.append(renderComposer());
    loadHistory = holdHistory;
    globalThis.__test = {api, uploadRequest, sendImage, sendFiles, resetHistory, invalidateChat, renderImageTransfers, state,
      transfers: () => Array.from(imageTransfers.values())};`, sandbox);
  const api = sandbox.__test as {
    api: (path: string, options?: RequestInit, callback?: (percent: number | null) => void) => Promise<unknown>;
    uploadRequest: (path: string, options: RequestInit, callback: (percent: number | null) => void) => Promise<Reply>;
    sendFiles: (files: Array<{ name: string; type: string; size: number }>) => void;
    sendImage: (payload: Record<string, string>) => Promise<void>;
    resetHistory: () => void; invalidateChat: () => void; renderImageTransfers: () => void;
    transfers: () => Transfer[];
    state: { activeId: string; feedback: string; me: unknown; permissions: string[]; steam: { steamId: string } };
  };
  function paste() {
    let prevented = false;
    const file = { name: 'clipboard.png', type: 'image/png', size: 3 };
    root.querySelector('#messageInput')!.listeners.get('paste')!({ clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }], files: [file]
    }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  return { ...api, root, requests, fetches, readers, history, paste,
    row: (transfer: Transfer) => root.querySelector(`[data-transfer-id="${transfer.id}"]`) };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test('api uses fetch without progress and XHR with progress, preserving headers and JSON', async () => {
  const h = harness();
  await h.api('/api/example');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.fetches[0].options.credentials, 'same-origin');
  const progress: Array<number | null> = [];
  const request = h.api('/image', { method: 'POST', body: '{"img":"abc"}', headers: { 'X-Test': 'yes' } }, value => progress.push(value));
  const xhr = h.requests[0];
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.path, '/image');
  assert.equal(xhr.async, true);
  assert.equal(xhr.timeout, 120000);
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers.get('Accept'), 'application/json');
  assert.equal(xhr.headers.get('Content-Type'), 'application/json');
  assert.equal(xhr.headers.get('X-Test'), 'yes');
  assert.equal(xhr.body, '{"img":"abc"}');
  xhr.progress(1, 4);
  assert.equal(progress.at(-1), 25);
  xhr.progress(4, 4);
  assert.equal(progress.at(-1), 99);
  xhr.progress(5, 4);
  assert.equal(progress.at(-1), 99);
  xhr.progress(1, 0, false);
  assert.equal(progress.at(-1), null);
  xhr.upload.onload?.();
  assert.equal(progress.at(-1), 100);
  xhr.respond(200, { ok: true });
  assert.equal((await request as { ok: boolean }).ok, true);
  assert.equal(h.fetches.length, 1);
  assert.equal(xhr.sends, 1);
});

test('scoped file send renders reading, upload, processing and sent before history resolves', async () => {
  const h = harness();
  const input = h.root.querySelector('#messageInput')!;
  input.value = 'keep draft';
  h.sendFiles([{ name: 'clipboard.png', type: 'image/png', size: 3 }]);
  const transfer = h.transfers()[0];
  assert.equal(transfer.name, 'clipboard.png');
  assert.equal(transfer.peerId, 'peer');
  assert.equal(transfer.stage, 'reading');
  assert.equal(h.row(transfer)?.dataset.stage, 'reading');
  assert.equal(Number(h.row(transfer)?.querySelector('progress')?.value), 0);
  h.readers[0].onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
  assert.equal(h.row(transfer)?.querySelector('progress')?.hasAttribute('value'), false);
  h.readers[0].finish();
  const xhr = h.requests[0];
  assert.equal(transfer.stage, 'uploading');
  assert.deepEqual(JSON.parse(String(xhr.body)), { id: 'peer', img: 'data:image/png;base64,YWJj', steamAccountId: 'account-A' });
  xhr.progress(1, 2);
  assert.equal(transfer.percent, 50);
  assert.equal(Number(h.row(transfer)?.querySelector('progress')?.value), 50);
  xhr.progress(1, 0, false);
  assert.equal(transfer.percent, null);
  assert.equal(h.row(transfer)?.querySelector('progress')?.hasAttribute('value'), false);
  xhr.upload.onload?.();
  assert.equal(transfer.stage, 'processing');
  assert.equal(h.row(transfer)?.dataset.stage, 'processing');
  assert.equal(h.row(transfer)?.querySelector('progress')?.hasAttribute('value'), false);
  assert.match(h.row(transfer)?.querySelector('.image-transfer-status')?.textContent || '', /Steam/);
  xhr.respond(200, { ok: true });
  await settle();
  assert.equal(h.history.length, 0);
  assert.equal(transfer.stage, 'sent');
  assert.equal(h.row(transfer)?.dataset.stage, 'sent');
  await settle();
  assert.equal(input.value, 'keep draft');
  assert.equal(h.requests.length, 1);
});

for (const event of ['onerror', 'ontimeout', 'onabort'] as const) {
  test(`XHR ${event} rejects as uncertain and never resends`, async () => {
    const h = harness();
    const request = h.uploadRequest('/image', { method: 'POST', body: '{}' }, () => {});
    const rejection = assert.rejects(request, (error: unknown) => (error as { uncertain?: boolean }).uncertain === true);
    h.requests[0][event]?.();
    await rejection;
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].sends, 1);
  });
}

for (const failure of ['network', 'timeout', 'http'] as const) {
  test(`image ${failure} failure is terminal without automatic retry`, async () => {
    const h = harness();
    const sending = h.sendImage({ url: 'https://example.com/image.png' });
    const transfer = h.transfers()[0];
    const xhr = h.requests[0];
    if (failure === 'http') xhr.respond(413, { error: 'Image rejected' });
    else if (failure === 'timeout') xhr.ontimeout?.();
    else xhr.onerror?.();
    await sending;
    assert.equal(transfer.stage, failure === 'http' ? 'failed' : 'unknown');
    assert.equal(h.row(transfer)?.dataset.stage, transfer.stage);
    assert.ok(transfer.error);
    assert.equal(h.history.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(xhr.sends, 1);
    assert.equal(h.fetches.length, 0);
  });
}

test('reset cancels a pending reader and ignores its late completion', async () => {
  const h = harness();
  h.paste();
  assert.equal(h.readers.length, 0);
  assert.equal(h.requests.length, 0);
  h.root.querySelector('#sendButton')!.listeners.get('click')!({});
  const transfer = h.transfers()[0];
  h.resetHistory();
  assert.equal(h.readers[0].aborted, true);
  assert.equal(transfer.stage, 'cancelled');
  h.readers[0].finish();
  await settle();
  assert.equal(h.requests.length, 0);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`conversation switch keeps active upload but scopes ${outcome} feedback`, async () => {
    const h = harness();
    const sending = h.sendImage({ img: 'YWJj' });
    const transfer = h.transfers()[0];
    h.state.activeId = 'other';
    h.resetHistory();
    h.renderImageTransfers();
    h.state.feedback = 'other conversation';
    assert.equal(h.row(transfer), null);
    assert.equal(h.requests[0].aborted, false);
    if (outcome === 'success') h.requests[0].respond(200, { ok: true });
    else h.requests[0].onerror?.();
    await sending;
    assert.equal(h.state.feedback, 'other conversation');
    assert.equal(h.history.length, 0);
    assert.equal(h.requests.length, 1);
  });
}

test('account invalidation clears transfers and late upload callbacks do not restore them', async () => {
  const h = harness();
  const sending = h.sendImage({ img: 'YWJj' });
  h.state.steam.steamId = 'account-B';
  h.invalidateChat();
  h.state.feedback = 'new account';
  assert.equal(h.transfers().length, 0);
  h.requests[0].progress(1, 2);
  h.requests[0].respond(200, { ok: true });
  await sending;
  assert.equal(h.transfers().length, 0);
  assert.equal(h.root.querySelectorAll('[data-transfer-id]').length, 0);
  assert.equal(h.state.feedback, 'new account');
  assert.equal(h.history.length, 0);
});

test('successful sends do not start a history refresh or overwrite later conversation feedback', async () => {
  const h = harness();
  const sending = h.sendImage({ img: 'YWJj' });
  h.requests[0].respond(200, { ok: true });
  await settle();
  assert.equal(h.transfers()[0].stage, 'sent');
  assert.equal(h.history.length, 0);
  h.state.activeId = 'other';
  h.resetHistory();
  h.state.feedback = 'new conversation';
  await sending;
  assert.equal(h.state.feedback, 'new conversation');
  assert.equal(h.requests.length, 1);
});

test('an unconfirmed success response leaves the send unknown without retry', async () => {
  const h = harness();
  const sending = h.sendImage({ img: 'YWJj' });
  h.requests[0].respond(200, {});
  await sending;
  assert.equal(h.transfers()[0].stage, 'unknown');
  assert.equal(h.history.length, 0);
  assert.equal(h.requests.length, 1);
});

test('upload 401 preserves shared auth handling and does not resend', async () => {
  const h = harness();
  h.state.permissions = ['chat'];
  const sending = h.sendImage({ img: 'YWJj' });
  h.requests[0].respond(401, { error: 'Session expired' });
  await sending;
  assert.equal(h.state.me, null);
  assert.equal(h.state.permissions.length, 0);
  assert.equal(h.transfers().length, 0);
  assert.equal(h.root.querySelector('#imageTransfers'), null);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].sends, 1);
  assert.equal(h.fetches.length, 0);
});
