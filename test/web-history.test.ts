import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  textContent = '';
  scrollTop = 0;
  clientHeight = 100;
  hidden = false;
  disabled = false;
  value = '';
  isConnected = true;
  extraHeight = 0;
  listeners = new Map<string, Set<() => void>>();
  get scrollHeight() { return this.children.length * 50 + this.extraHeight; }
  append(...nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  prepend(...nodes: Element[]) { for (const node of [...nodes].reverse()) this.insertBefore(node, this.children[0] || null); }
  replaceChildren(...nodes: Element[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  insertBefore(node: Element, before: Element | null) { node.remove(); node.parent = this; const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, node); }
  querySelector(): null { return null; }
  querySelectorAll(): Element[] { return []; }
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight }; }
  removeAttribute() {}
  setAttribute() {}
  addEventListener(name: string, listener: () => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(name) || []) (listener as (event: unknown) => void)(event);
  }
}

type Item = { id: string; eventId: string; message: string; echo?: boolean; name?: string; sentAt?: string; steamAccountId?: string; type?: string };
type OutgoingEntry = { localId: number; state: string; item: Item; context: string; readonly retryText?: string; textCheckBusy?: boolean; textCheckReason?: string; replacementLocalId?: number };
type Pending = { url: URL; method?: string; body?: string; signal?: AbortSignal; resolve: (value: unknown) => void; respond: (status: number, value: unknown) => void; reject: (error: Error) => void };
function harness(withLayout = false, withRealtime = false, disk?: Map<string, unknown>, browserStorage = new Map<string, string>()) {
  let now = Date.now();
  const timers = new Map<number, { delay: number; callback: () => unknown }>();
  let timerId = 0;
  const events = new Element();
  const sockets: FakeSocket[] = [];
  class FakeSocket extends Element {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    constructor(_url: string) { super(); sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.closed = true; this.readyState = 3; this.dispatch('close'); }
  }
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  const observers: Array<{ active: boolean; callback: () => void }> = [];
  class LayoutObserver {
    active = true;
    constructor(readonly callback: () => void) { observers.push(this); }
    observe() {}
    disconnect() { this.active = false; }
  }
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  const nodes: Record<string, Element> = { '#app': new Element(), '#chatLayout': new Element(), '#chatListSections': new Element(), '#messageInput': new Element(), '#messages': new Element(), '#historyOlder': new Element(), '#storageHealth': new Element() };
  const pending: Pending[] = [];
  const sandbox = {
    document: { querySelector: (id: string) => nodes[id] || null, querySelectorAll: (): Element[] => [],
      visibilityState: 'visible', addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), createElement: () => new Element() },
    window: { addEventListener: events.addEventListener.bind(events) },
    location: { protocol: 'http:', host: 'test' }, WebSocket: FakeSocket, AbortController, crypto: webcrypto,
    ...(disk ? { indexedDB: { open: () => {
      const request = { result: { transaction: () => ({ objectStore: () => ({
        get: (key: string) => { const read = { result: disk.get(key), onsuccess: () => {}, onerror: () => {} }; Promise.resolve().then(() => read.onsuccess()); return read; },
        put: (value: unknown, key: string) => disk.set(key, structuredClone(value)), clear: () => disk.clear()
      }) }), close() {} }, onsuccess: () => {}, onerror: () => {}, onblocked: () => {} };
      Promise.resolve().then(() => request.onsuccess()); return request;
    } } } : {}),
    ...(withRealtime ? { Date: class Clock extends Date { static now() { return now; } } } : {}),
    localStorage: { getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => browserStorage.set(key, value), removeItem: (key: string) => browserStorage.delete(key) },
    ...(withLayout ? { ResizeObserver: LayoutObserver,
      requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id: number) => frames.delete(id) } : {}),
    URL, URLSearchParams, Headers, console,
    setTimeout: (callback: () => unknown, delay: number) => { if (!withRealtime) return 0; timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => unknown, delay: number) => { if (!withRealtime) return 0; timers.set(++timerId, { callback, delay }); return timerId; },
    clearInterval: (id: number) => timers.delete(id),
    fetch: (url: string, options: RequestInit = {}) => new Promise((resolve, reject) => pending.push({ url: new URL(url, 'http://test'),
      method: options.method,
      body: typeof options.body === 'string' ? options.body : undefined,
      respond: (status, payload) => resolve({ ok: status < 400, status, json: async () => payload }),
      signal: options.signal || undefined, resolve: (payload) => resolve({ ok: true, json: async () => payload }), reject })),
    __test: undefined as unknown
  };
  runInNewContext(`${source.slice(0, source.indexOf('\nbootstrap().catch'))}
    uploadRequest = (path, options) => fetch(path, options);
    renderMessage = (item) => { const row = document.createElement('article'); row.dataset.eventId = item.eventId; return row; };
    state.me = {id: 1}; state.permissions = ['chat.use', 'self.password.change']; state.activeId = 'peer'; state.steam.accessAllowed = true;
    state.steam.steamGrant = {level:'full', scope:'all', peerCount:0, expiresAt:null};
    resizeComposerInput = () => {};
    globalThis.__test = {refreshChatData, loadChatInventory, updateSteamStatus, sendText, retryOutgoingText, resendOutgoingText, checkOutgoingText, sendImage, loadHistory, loadConversations, receiveHistoryMessage, loadStorageHealth, storageHealthText,
      openConversation, rememberThread, restoreThread, scheduleChatCache, restoreChatCache, clearChatCache,
      bootstrap: () => { setupAppInstallation = () => {}; renderShell = () => {}; restoreImageOperations = () => {}; return bootstrap(); },
      requestDurableSync, ensureWebSocket, stopWebSocket, startStatusPolling, stopStatusPolling, setupRealtimeResume,
      syncTask: () => durableSyncTask, syncCursor: () => durableSyncCursor, setSyncCursor: (cursor) => durableSyncCursor = cursor,
      resetHistory, invalidateChat, state, items: () => historyItems, outgoing: () => Array.from(outgoingMessages.values()),
      switchPeer: (id) => { state.activeId = id; resetHistory(); },
      detached: () => historyDetached, busy: () => historyBusy};`, sandbox);
  const api = sandbox.__test as {
    refreshChatData: (includeConversations?: boolean) => Promise<void>;
    loadChatInventory: () => Promise<void>;
    updateSteamStatus: (status: Record<string, unknown>) => void;
    bootstrap: () => Promise<void>;
    openConversation: (id: string) => void;
    rememberThread: () => void;
    restoreThread: () => boolean;
    scheduleChatCache: () => void;
    restoreChatCache: () => Promise<void>;
    clearChatCache: () => void;
    sendText: (explicitMessage?: string, previewMessage?: string) => Promise<boolean>;
    retryOutgoingText: (entry: OutgoingEntry) => Promise<boolean>;
    resendOutgoingText: (entry: OutgoingEntry) => Promise<boolean>;
    checkOutgoingText: (entry: OutgoingEntry) => Promise<void>;
    sendImage: (payload: Record<string, string>) => Promise<void>;
    loadHistory: (mode?: string, date?: string, options?: { preserve?: boolean; cacheRefresh?: boolean }) => Promise<void>;
    loadConversations: (more?: boolean) => Promise<void>;
    receiveHistoryMessage: (item: Item) => void;
    loadStorageHealth: () => Promise<void>;
    storageHealthText: (payload: unknown) => string;
    resetHistory: () => void;
    invalidateChat: () => void;
    switchPeer: (id: string) => void;
    state: { me: { id: number; sessionVersion?: number }; permissions: string[]; sendOperations: boolean; imageOperationUpload: boolean; activeId: string; view: string; steam: { steamId: string | null; activeAccount?: { id: number; steamId: string; label: string }; status: string; accessAllowed: boolean; accessRevision?: string; steamGrant?: { level: string; scope: string; peerCount: number } }; friends: Array<{id: string; name: string}>; activeName: string;
      conversations: Array<{id: string; name?: string; preview?: string; updatedAt?: string}>; feedback: string;
      emoticons: Array<Record<string, unknown>>; stickers: Array<Record<string, unknown>>; effects: Array<Record<string, unknown>> };
    outgoing: () => OutgoingEntry[];
    items: () => Item[];
    detached: () => boolean;
    busy: () => boolean;
    requestDurableSync: () => void;
    ensureWebSocket: () => void;
    stopWebSocket: () => void;
    startStatusPolling: () => void;
    stopStatusPolling: () => void;
    setupRealtimeResume: () => void;
    syncTask: () => Promise<void> | null;
    syncCursor: () => string;
    setSyncCursor: (cursor: string) => void;
  };
  return { api, pending, messages: nodes['#messages'], nodes, sockets, timers, events, now: () => now, advance: (ms: number) => { now += ms; },
    setVisibility: (value: string) => { sandbox.document.visibilityState = value; },
    flushFrames,
    resize: () => { for (const observer of [...observers]) if (observer.active) observer.callback(); flushFrames(); } };
}
const item = (eventId: string, id = 'peer'): Item => ({ id, eventId, message: eventId });

for (const stale of [false, true]) {
  test(`friend and group requests start without waiting for conversations or inventory, stale context ${stale}`, async () => {
    const { api, pending } = harness();
    api.state.view = 'chat';
    api.state.steam.status = 'online';
    const loading = api.refreshChatData();
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.map(p => p.url.pathname), ['/api/conversations', '/api/friends', '/api/groups']);
    if (stale) {
      api.invalidateChat();
      api.state.friends = [{ id: 'other', name: 'New account friend' }];
    }
    pending[1].resolve([{ id: 'peer', name: 'Current friend' }]);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(api.state.friends[0].name, stale ? 'New account friend' : 'Current friend');
    pending[0].resolve({ items: [{ id: 'peer', name: 'sender name' }] });
    pending[2].resolve([]);
    await loading;
    assert.equal(api.state.friends[0].name, stale ? 'New account friend' : 'Current friend');
  });
}

test('optimistic text appears before the response and reconciles response, WebSocket and history once', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'hello';
  const sending = api.sendText();
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.sendState, 'sending');
  assert.equal(api.outgoing()[0].item.echo, true);
  assert.equal(api.items().length, 0);
  assert.equal(nodes['#messageInput'].value, '');
  const confirmed = { ...item('confirmed'), message: 'hello', echo: true };
  api.receiveHistoryMessage(confirmed);
  pending[0].resolve({ ok: true, item: confirmed });
  await sending;
  api.receiveHistoryMessage(confirmed);
  assert.equal(messages.children.length, 1);
  assert.equal(api.items().length, 1);
  const loading = api.loadHistory();
  pending[1].resolve({ items: [confirmed] });
  await loading;
  assert.equal(messages.children.length, 1);
});

test('a confirmed realtime echo replaces its text placeholder before a delayed HTTP reply', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'hello';
  const sending = api.sendText();
  const confirmed = { ...item('echo-before-response'), message: 'hello', echo: true, sentAt: new Date().toISOString() };
  api.receiveHistoryMessage(confirmed);
  assert.equal(messages.children.length, 1, 'the confirmed echo and the pending placeholder represent one send');
  assert.equal(messages.children[0].dataset.eventId, confirmed.eventId);
  assert.equal(api.outgoing().length, 1, 'echo association must not invent an HTTP acknowledgement');
  assert.equal(api.outgoing()[0].state, 'sending');
  pending[0].resolve({ ok: true, item: confirmed });
  await sending;
  assert.equal(messages.children.length, 1);
});

test('one realtime event consumes at most one of two identical pending sends', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'same'; const first = api.sendText();
  nodes['#messageInput'].value = 'same'; const second = api.sendText();
  const confirmed = { ...item('first-identical'), message: 'same', echo: true, sentAt: new Date().toISOString() };
  api.receiveHistoryMessage(confirmed); api.receiveHistoryMessage(confirmed);
  assert.equal(messages.children.length, 2);
  assert.equal(api.outgoing().length, 2);
  const next = { ...confirmed, eventId: 'second-identical' };
  api.receiveHistoryMessage(next);
  assert.equal(messages.children.length, 2); assert.equal(api.outgoing().length, 2);
  pending[1].resolve({ ok: true, item: next }); await second;
  pending[0].resolve({ ok: true, item: confirmed }); await first;
  assert.equal(messages.children.length, 2); assert.equal(api.items().length, 2);
});

test('an HTTP confirmation does not consume another identical send awaiting its own echo', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'same'; const first = api.sendText();
  nodes['#messageInput'].value = 'same'; const second = api.sendText();
  const confirmed = { ...item('http-first'), message: 'same', echo: true, sentAt: new Date().toISOString() };
  pending[0].resolve({ ok: true, item: confirmed }); await first;
  assert.equal(api.outgoing().length, 1); assert.equal(messages.children.length, 2);
  api.receiveHistoryMessage(confirmed);
  assert.equal(api.outgoing().length, 1);
  const next = { ...confirmed, eventId: 'http-second' };
  api.receiveHistoryMessage(next);
  assert.equal(api.outgoing().length, 1);
  pending[1].resolve({ ok: true, item: next }); await second;
  assert.equal(api.items().length, 2);
});

test('a lost HTTP reply leaves a recorded echo without a false uncertainty warning or second message', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'delivered'; const sending = api.sendText();
  api.receiveHistoryMessage({ ...item('delivered'), echo: true, sentAt: new Date().toISOString() });
  pending[0].reject(new Error('proxy connection reset'));
  assert.equal(await sending, false);
  assert.equal(messages.children.length, 1); assert.equal(api.outgoing().length, 0);
  assert.equal(messages.children[0].dataset.sendState, 'sent');
  assert.equal(pending.length, 1, 'no implicit retry follows a lost HTTP reply');
});

test('a delayed recorded echo clears an uncertain attempt after its HTTP request has failed', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'delivered later'; const sending = api.sendText();
  pending[0].respond(502, { error: 'Acknowledgement lost', uncertain: true });
  assert.equal(await sending, false); assert.equal(api.outgoing()[0].state, 'unknown');
  const confirmed = { ...item('late-echo'), message: 'delivered later', echo: true, sentAt: new Date().toISOString() };
  api.receiveHistoryMessage(confirmed); api.receiveHistoryMessage(confirmed);
  assert.equal(api.outgoing().length, 0); assert.equal(messages.children.length, 1);
  assert.equal(api.items()[0].eventId, 'late-echo');
  assert.equal(pending.length, 1, 'confirmation never resends a message');
});

test('one recorded echo clears only one of two identical uncertain sends', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'same'; const first = api.sendText();
  nodes['#messageInput'].value = 'same'; const second = api.sendText();
  for (const request of pending) request.respond(502, { error: 'Acknowledgement lost', uncertain: true });
  await Promise.all([first, second]);
  const confirmed = { ...item('one-echo'), message: 'same', echo: true, sentAt: new Date().toISOString() };
  api.receiveHistoryMessage(confirmed); api.receiveHistoryMessage(confirmed);
  assert.equal(api.outgoing().length, 1); assert.equal(api.outgoing()[0].state, 'unknown');
  assert.equal(messages.children.length, 2);
  api.receiveHistoryMessage({ ...confirmed, eventId: 'second-echo' });
  assert.equal(api.outgoing().length, 0); assert.equal(messages.children.length, 2);
  assert.equal(pending.length, 2);
});

test('incoming, other-peer, other-account and old echoes cannot confirm a new text send', async () => {
  const { api, pending, nodes } = harness(); api.state.steam.steamId = 'account';
  nodes['#messageInput'].value = 'same'; const sending = api.sendText();
  const confirmed = { ...item('candidate'), message: 'same', echo: true, steamAccountId: 'account', sentAt: new Date().toISOString() };
  for (const candidate of [{ ...confirmed, eventId: 'incoming', echo: false }, { ...confirmed, eventId: 'other-peer', id: 'other' },
    { ...confirmed, eventId: 'other-account', steamAccountId: 'other-account' }, { ...confirmed, eventId: 'old', sentAt: new Date(Date.now() - 60000).toISOString() }]) {
    api.receiveHistoryMessage(candidate); assert.equal(api.outgoing().length, 1);
  }
  api.receiveHistoryMessage(confirmed); assert.equal(api.outgoing().length, 1);
  pending[0].resolve({ ok: true, item: confirmed }); await sending;
});

test('a realtime canonical emoticon echo confirms the same locally typed Steam emoticon', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = ':smile:'; const sending = api.sendText();
  const confirmed = { ...item('emoticon'), message: '[emoticon]smile[/emoticon]', echo: true, sentAt: new Date().toISOString() };
  api.receiveHistoryMessage(confirmed);
  assert.equal(messages.children.length, 1); assert.equal(api.outgoing().length, 1);
  pending[0].resolve({ ok: true, item: confirmed }); await sending;
});

test('latest history reconciles a confirmed text when its WebSocket echo was missed', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'history confirmation'; const sending = api.sendText();
  const confirmed = { ...item('history-confirmed'), message: 'history confirmation', echo: true, sentAt: new Date().toISOString() };
  const loading = api.loadHistory(); pending[1].resolve({ items: [confirmed] }); await loading;
  assert.equal(messages.children.length, 1); assert.equal(api.outgoing().length, 1);
  pending[0].reject(new Error('HTTP reply lost'));
  assert.equal(await sending, false); assert.equal(messages.children.length, 1);
  assert.equal(api.outgoing().length, 0);
});

for (const wrapper of ['[url]https://example.com/video[/url]', '[url="https://example.com/video"]https://example.com/video[/url]']) {
  test(`canonical URL echo clears an uncertain plain URL send: ${wrapper}`, async () => {
    const { api, pending, nodes, messages } = harness();
    nodes['#messageInput'].value = 'https://example.com/video'; const sending = api.sendText();
    pending[0].respond(502, { error: 'Acknowledgement lost', uncertain: true }); await sending;
    api.receiveHistoryMessage({ ...item('url-echo'), echo: true, message: wrapper, sentAt: new Date().toISOString() });
    assert.equal(api.outgoing().length, 0); assert.equal(messages.children.length, 1);
    assert.equal(pending.length, 1);
  });
}

test('a named or different-target URL cannot clear an uncertain plain URL send', async () => {
  const { api, pending, nodes } = harness();
  nodes['#messageInput'].value = 'https://example.com/video'; const sending = api.sendText();
  pending[0].respond(502, { error: 'Acknowledgement lost', uncertain: true }); await sending;
  for (const message of ['[url=https://other.example/]https://example.com/video[/url]', '[url=https://example.com/video]a video[/url]']) {
    api.receiveHistoryMessage({ ...item(message), echo: true, message, sentAt: new Date().toISOString() });
  }
  assert.equal(api.outgoing().length, 1); assert.equal(api.outgoing()[0].state, 'unknown');
});

test('an unconfirmed text request has a finite deadline without being sent again', async () => {
  const { api, pending, nodes, timers } = harness(false, true);
  nodes['#messageInput'].value = 'unconfirmed'; const sending = api.sendText();
  assert.ok(pending[0].signal);
  pending[0].signal!.addEventListener('abort', () => pending[0].reject(new Error('request deadline')));
  const deadline = [...timers.values()].find(timer => timer.delay === 30000)!;
  assert.ok(deadline); deadline.callback();
  assert.equal(await sending, false); assert.equal(api.outgoing()[0].state, 'unknown');
  assert.equal(pending.length, 1);
});

test('durable catch-up associates an echo while the text HTTP response is delayed', async () => {
  const { api, pending, nodes, messages } = harness(); api.state.steam.steamId = 'account'; api.setSyncCursor('before');
  nodes['#messageInput'].value = 'durable echo'; const sending = api.sendText();
  const confirmed = { ...item('durable-echo'), message: 'durable echo', echo: true, steamAccountId: 'account', sentAt: new Date().toISOString() };
  api.requestDurableSync(); const sync = api.syncTask();
  pending[1].resolve({ steamAccountId: 'account', items: [confirmed], hasMore: false, nextCursor: 'after' }); await sync;
  assert.equal(messages.children.length, 1); assert.equal(api.outgoing()[0].state, 'sending');
  pending[0].resolve({ ok: true, item: confirmed }); await sending;
  assert.equal(messages.children.length, 1); assert.equal(api.outgoing().length, 0);
});

test('a similar observed echo cannot turn an explicitly rejected request into a success', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'same text'; const sending = api.sendText();
  api.receiveHistoryMessage({ ...item('observed-echo'), message: 'same text', echo: true, sentAt: new Date().toISOString() });
  assert.equal(messages.children.length, 1);
  pending[0].respond(400, { error: 'Rejected request' }); assert.equal(await sending, false);
  assert.equal(api.outgoing()[0].state, 'failed'); assert.equal(api.items().length, 1);
  assert.equal(messages.children.length, 2, 'the failed attempt stays distinct from the actual observed message');
});

test('image send has a provisional preview source and replaces it with the confirmed URL', async () => {
  const { api, pending, messages } = harness();
  const preview = 'data:image/png;base64,YWJj';
  const sending = api.sendImage({ img: preview });
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.sendState, 'sending');
  assert.equal(api.outgoing()[0].item.message, preview);
  assert.equal(api.outgoing()[0].item.type, 'image');
  const confirmed = { ...item('image-confirmed'), type: 'image', echo: true, message: 'https://example.com/image.png' };
  pending[0].resolve({ ok: true, item: confirmed });
  await sending;
  api.receiveHistoryMessage(confirmed);
  assert.equal(messages.children.length, 1);
  assert.equal(api.outgoing().length, 0);
  assert.equal(api.items()[0].message, confirmed.message);
});

test('success without stable event identity keeps one sent row and no fake history event', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'hello';
  const sending = api.sendText();
  pending[0].resolve({ ok: true, item: { id: 'peer', echo: true, message: 'hello' } });
  await sending;
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.sendState, 'sent');
  assert.equal(api.items().length, 0);
});

test('standalone sticker commands preserve the text draft and adopt the server rendering', async () => {
  const { api, pending, nodes } = harness();
  nodes['#messageInput'].value = 'unfinished text';
  const sending = api.sendText('/sticker Show Love', '[sticker type="Show Love" limit="0"][/sticker]');
  assert.equal(nodes['#messageInput'].value, 'unfinished text');
  assert.equal(api.outgoing()[0].state, 'sending');
  const literal = '\\[sticker type="Show Love" limit="0"]\\[/sticker]';
  pending[0].resolve({ ok: true, item: { id: 'peer', echo: true, message: literal } });
  await sending;
  assert.equal(api.outgoing()[0].item.message, literal);
  assert.equal(api.outgoing()[0].state, 'sent');
  assert.equal(nodes['#messageInput'].value, 'unfinished text');
});

test('identical intentional sends stay distinct and preserve a newer composer draft', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'same';
  const first = api.sendText();
  nodes['#messageInput'].value = 'same';
  const second = api.sendText();
  nodes['#messageInput'].value = 'new draft';
  assert.equal(messages.children.length, 2);
  pending[1].resolve({ ok: true, item: { ...item('two'), message: 'same', echo: true } });
  await second;
  pending[0].resolve({ ok: true, item: { ...item('one'), message: 'same', echo: true } });
  await first;
  assert.equal(messages.children.length, 2);
  assert.equal(nodes['#messageInput'].value, 'new draft');
});

for (const status of [400, 500, undefined]) {
  test(`outgoing failure ${status} is classified without retry`, async () => {
    const { api, pending, nodes, messages } = harness();
    nodes['#messageInput'].value = 'hello';
    const sending = api.sendText();
    pending[0].reject(Object.assign(new Error('rejected'), { status }));
    assert.equal(await sending, false);
    assert.equal(api.outgoing()[0].state, status === 400 ? 'failed' : 'unknown');
    assert.equal(messages.children.length, 1);
    assert.equal(pending.length, 1);
  });
}

async function manualTextAttempt(status: 'failed' | 'unknown') {
  const h = harness();
  h.api.state.steam.steamId = 'account';
  h.api.state.steam.status = 'online';
  h.nodes['#messageInput'].value = 'original [body]';
  const sending = h.api.sendText();
  h.pending[0].respond(status === 'failed' ? 400 : 502, { error: 'send error', uncertain: status === 'unknown' });
  assert.equal(await sending, false);
  const entry = h.api.outgoing()[0];
  assert.equal(entry.state, status);
  return { ...h, entry };
}

test('manual failed retry keeps its bubble and immutable original body without touching the later draft', async () => {
  const { api, pending, nodes, messages, entry } = await manualTextAttempt('failed');
  nodes['#messageInput'].value = 'edited draft';
  const retrying = api.retryOutgoingText(entry);
  assert.equal(entry.state, 'sending');
  assert.equal(await api.retryOutgoingText(entry), false, 'repeated clicks cannot start another attempt');
  assert.equal(pending.length, 2);
  assert.equal(api.outgoing()[0], entry);
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.outgoingId, String(entry.localId));
  assert.deepEqual(JSON.parse(pending[1].body!), { id: 'peer', msg: 'original [body]', steamAccountId: 'account' });
  assert.equal(nodes['#messageInput'].value, 'edited draft');
  pending[1].respond(400, { error: 'still rejected', uncertain: false });
  assert.equal(await retrying, false);
  assert.equal(entry.state, 'failed');
  assert.equal(entry.retryText, 'original [body]');
  assert.equal(nodes['#messageInput'].value, 'edited draft');
  assert.equal(await api.resendOutgoingText(entry), false, 'a rejected send cannot masquerade as an unknown replacement');
  await api.checkOutgoingText(entry);
  assert.equal(pending.length, 2);
});

for (const stale of ['peer', 'account', 'active account', 'access', 'permission', 'read grant', 'invalidate', 'dismissed'] as const) {
  test(`manual text actions refuse stale ${stale} contexts`, async () => {
    for (const state of ['failed', 'unknown'] as const) {
      const { api, pending, messages, entry } = await manualTextAttempt(state);
      if (stale === 'peer') api.state.activeId = 'other';
      if (stale === 'account') api.state.steam.steamId = 'other';
      if (stale === 'active account') api.state.steam.activeAccount = { id: 2, steamId: 'other', label: 'Other' };
      if (stale === 'access') api.state.steam.accessAllowed = false;
      if (stale === 'permission') api.state.permissions = [];
      if (stale === 'read grant') api.state.steam.steamGrant = { level: 'read', scope: 'all', peerCount: 0 };
      if (stale === 'invalidate') api.invalidateChat();
      if (stale === 'dismissed') {
        const dismiss = messages.children[0].children.flatMap(node => node.children).find(node => node.textContent === '移除此提示');
        assert.ok(dismiss);
        dismiss.dispatch('click');
      }
      assert.equal(await api.retryOutgoingText(entry), false);
      assert.equal(await api.resendOutgoingText(entry), false);
      await api.checkOutgoingText(entry);
      assert.equal(pending.length, 1, 'stale actions must neither check nor send');
    }
  });
}

test('manual unknown check posts original attempt metadata and only actual history clears it', async () => {
  const { api, pending, nodes, entry } = await manualTextAttempt('unknown');
  nodes['#messageInput'].value = 'later draft';
  const checking = api.checkOutgoingText(entry);
  await api.checkOutgoingText(entry);
  assert.equal(await api.resendOutgoingText(entry), false, 'a check in flight blocks replacement');
  assert.equal(pending.length, 2);
  assert.equal(pending[1].url.pathname, '/api/messages/check');
  assert.equal(pending[1].method, 'POST');
  assert.deepEqual(JSON.parse(pending[1].body!), { id: 'peer', msg: 'original [body]', sentAt: entry.item.sentAt, steamAccountId: 'account' });
  pending[1].resolve({ items: [] });
  await checking;
  assert.equal(entry.state, 'unknown');
  assert.match(entry.textCheckReason!, /未找到.*仍可能已发送/);
  assert.equal(api.items().length, 0);
  const again = api.checkOutgoingText(entry);
  const confirmed = { ...entry.item, eventId: 'checked', steamAccountId: 'account', message: 'original \\[body]' };
  pending[2].resolve({ items: [confirmed] });
  await again;
  assert.equal(api.outgoing().length, 0);
  assert.equal(api.items()[0].eventId, 'checked');
  assert.equal(nodes['#messageInput'].value, 'later draft');
  assert.equal(pending.filter(request => request.url.pathname === '/message').length, 1, 'check never calls /message');
});

for (const result of ['failure', 'rejected check', 'malformed', 'wrong peer', 'wrong account', 'incoming', 'missing event', 'wrong type', 'missing time', 'other body'] as const) {
  test(`manual unknown check ${result} never invents success or failure`, async () => {
    const { api, pending, entry } = await manualTextAttempt('unknown');
    const checking = api.checkOutgoingText(entry);
    const candidate = { ...entry.item, eventId: 'candidate', steamAccountId: 'account' };
    if (result === 'failure') pending[1].respond(503, { error: 'History unavailable' });
    else if (result === 'rejected check') pending[1].respond(400, { error: 'Check rejected', uncertain: false });
    else if (result === 'malformed') pending[1].resolve({ ok: true });
    else {
      if (result === 'wrong peer') candidate.id = 'other';
      if (result === 'wrong account') candidate.steamAccountId = 'other';
      if (result === 'incoming') candidate.echo = false;
      if (result === 'missing event') candidate.eventId = '';
      if (result === 'wrong type') candidate.type = 'image';
      if (result === 'missing time') candidate.sentAt = '';
      if (result === 'other body') candidate.message = 'different body';
      pending[1].resolve({ items: [candidate] });
    }
    await checking;
    assert.equal(entry.state, 'unknown');
    assert.equal(api.outgoing().length, 1);
    assert.equal(entry.textCheckBusy, false);
    assert.match(entry.textCheckReason!, result === 'failure' || result === 'rejected check' || result === 'malformed' ? /检查失败/ : /未找到/);
    assert.equal(pending.length, 2);
  });
}

for (const stale of ['peer', 'account', 'access', 'invalidate'] as const) {
  test(`check ignores a response after ${stale} changes`, async () => {
    const { api, pending, entry } = await manualTextAttempt('unknown');
    const checking = api.checkOutgoingText(entry);
    if (stale === 'peer') api.state.activeId = 'other';
    if (stale === 'account') api.state.steam.steamId = 'other';
    if (stale === 'access') api.state.steam.accessAllowed = false;
    if (stale === 'invalidate') api.invalidateChat();
    pending[1].resolve({ items: [{ ...entry.item, eventId: 'stale-check' }] });
    await checking;
    assert.equal(api.items().length, 0);
    assert.equal(entry.state, 'unknown');
  });
}

test('explicit unknown resend creates only one new attempt and preserves the original until its own confirmation', async () => {
  const { api, pending, nodes, entry } = await manualTextAttempt('unknown');
  nodes['#messageInput'].value = 'new draft';
  const resending = api.resendOutgoingText(entry);
  assert.equal(await api.resendOutgoingText(entry), false);
  assert.equal(pending.length, 2);
  const replacement = api.outgoing()[1];
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.replacementLocalId, replacement.localId);
  assert.notEqual(entry.localId, replacement.localId);
  assert.equal(replacement.state, 'sending');
  assert.equal(nodes['#messageInput'].value, 'new draft');
  assert.deepEqual(JSON.parse(pending[1].body!), { id: 'peer', msg: 'original [body]', steamAccountId: 'account' });
  const confirmed = { ...replacement.item, eventId: 'replacement-confirmed' };
  api.receiveHistoryMessage(confirmed);
  assert.equal(api.outgoing()[0], entry);
  assert.equal(entry.state, 'unknown', 'replacement echo must not consume the original');
  pending[1].resolve({ ok: true, item: confirmed });
  assert.equal(await resending, true);
  assert.equal(api.outgoing().length, 1);
  assert.equal(api.outgoing()[0], entry);
  assert.equal(await api.resendOutgoingText(entry), false, 'replacement guard survives its confirmation');
  const checking = api.checkOutgoingText(entry);
  pending[2].resolve({ items: [{ ...entry.item, eventId: 'original-confirmed' }] });
  await checking;
  assert.equal(api.outgoing().length, 0);
  assert.equal(api.items().length, 2);
});

test('a rejected replacement leaves the old attempt unknown and the new one failed', async () => {
  const { api, pending, entry } = await manualTextAttempt('unknown');
  const resending = api.resendOutgoingText(entry);
  pending[1].respond(400, { error: 'Actually rejected', uncertain: false });
  assert.equal(await resending, false);
  assert.equal(api.outgoing()[0].state, 'unknown');
  assert.equal(api.outgoing()[1].state, 'failed');
  assert.equal(await api.resendOutgoingText(entry), false);
  assert.equal(pending.length, 2);
});

test('outgoing rows survive peer switches, but account invalidation discards stale completions', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'hello';
  const sending = api.sendText();
  api.switchPeer('other');
  assert.equal(messages.children[0].dataset.outgoingId, undefined);
  pending[0].resolve({ ok: true, item: { ...item('confirmed'), echo: true } });
  await sending;
  api.switchPeer('peer');
  assert.equal(api.outgoing().length, 0);
  const loading = api.loadHistory();
  pending[1].resolve({ items: [{ ...item('confirmed'), echo: true }] });
  await loading;
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.eventId, 'confirmed');
  nodes['#messageInput'].value = 'next';
  const stale = api.sendText();
  api.invalidateChat();
  pending[2].resolve({ ok: true, item: { ...item('stale'), echo: true } });
  await stale;
  assert.equal(api.outgoing().length, 0);
  assert.equal(api.items().length, 0);
});

test('date views exclude provisional messages and old confirmed sends never reappear', async () => {
  const { api, pending, nodes, messages } = harness();
  nodes['#messageInput'].value = 'sending now';
  const sending = api.sendText();
  const past = api.loadHistory('date', '2026-01-02T13:45');
  pending[1].resolve({ items: [item('old')] });
  await past;
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.eventId, 'old');
  pending[0].resolve({ ok: true, item: { ...item('confirmed'), echo: true } });
  await sending;
  assert.equal(api.outgoing().length, 0);
  assert.equal(messages.children.length, 1);
  api.switchPeer('other');
  api.switchPeer('peer');
  const latest = api.loadHistory();
  pending[2].resolve({ items: [item('newest')] });
  await latest;
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.eventId, 'newest');
});

test('sending follows bottom, but subsequent manual reading is preserved on confirmation', async () => {
  const { api, pending, nodes, messages, resize } = harness(true);
  const loading = api.loadHistory();
  pending[0].resolve({ items: [item('a'), item('b'), item('c'), item('d')] });
  await loading;
  messages.dispatch('wheel', { deltaY: -100 });
  messages.scrollTop = 20;
  const existingRow = messages.children[0];
  nodes['#messageInput'].value = 'hello';
  const sending = api.sendText();
  assert.equal(messages.children[0], existingRow);
  assert.equal(messages.scrollTop, messages.scrollHeight);
  assert.equal(messages.dataset.followBottom, 'true');
  messages.dispatch('wheel', { deltaY: -100 });
  messages.scrollTop = 20;
  messages.dispatch('scroll');
  pending[1].resolve({ ok: true, item: { ...item('confirmed'), echo: true } });
  await sending;
  resize();
  assert.equal(messages.scrollTop, 20);
  assert.equal(messages.dataset.followBottom, 'false');
});

for (const type of ['text', 'image']) {
  test(`${type} send leaves date history and shows the outgoing message at bottom`, async () => {
    const { api, pending, nodes, messages, resize } = harness(true);
    const past = api.loadHistory('date', '2026-01-02T13:45');
    pending[0].resolve({ items: [item('past')] });
    await past;
    nodes['#messageInput'].value = 'new message';
    const sending = type === 'text' ? api.sendText() : api.sendImage({ img: 'data:image/png;base64,YWJj' });
    assert.equal(api.detached(), false);
    assert.equal(messages.children[0].dataset.sendState, 'sending');
    assert.equal(pending[1].url.pathname, '/api/history');
    pending[1].resolve({ items: [item('latest')] });
    await new Promise(resolve => setImmediate(resolve));
    resize();
    assert.equal(messages.scrollTop, messages.scrollHeight);
    pending[2].resolve({ ok: true, item: { ...item('confirmed'), echo: true } });
    await sending;
    resize();
    assert.equal(messages.scrollTop, messages.scrollHeight);
  });
}

test('a date response started before sending cannot pull the view back into the past', async () => {
  const { api, pending, nodes, messages } = harness();
  const past = api.loadHistory('date', '2026-01-02T13:45');
  nodes['#messageInput'].value = 'new message';
  const sending = api.sendText();
  pending[0].resolve({ items: [item('past')] });
  await past;
  assert.equal(api.detached(), false);
  assert.equal(messages.children[0].dataset.sendState, 'sending');
  pending[1].resolve({ items: [item('latest')] });
  pending[2].resolve({ ok: true, item: { ...item('confirmed'), echo: true } });
  await sending;
  assert.equal(api.items().some(entry => entry.eventId === 'past'), false);
});

test('latest history follows late row growth and a newly visible viewport', async () => {
  const { api, pending, messages, resize } = harness(true);
  messages.clientHeight = 0;
  const loading = api.loadHistory();
  pending[0].resolve({ items: [item('a'), item('b'), item('c')] });
  await loading;
  messages.scrollTop = 0;
  messages.clientHeight = 100;
  resize();
  assert.equal(messages.scrollTop, messages.scrollHeight);
  messages.extraHeight = 600;
  resize();
  assert.equal(messages.scrollTop, messages.scrollHeight);
});

test('automatic scroll adjustments do not cancel bottom following', async () => {
  const { api, pending, messages, resize } = harness(true);
  const loading = api.loadHistory();
  pending[0].resolve({ items: [item('a'), item('b'), item('c'), item('d')] });
  await loading;
  messages.scrollTop -= 150;
  messages.dispatch('scroll');
  messages.extraHeight += 150;
  resize();
  assert.equal(messages.scrollTop, messages.scrollHeight);
});

test('a late automatic scroll is corrected even without another resize', async () => {
  const { api, pending, messages, flushFrames } = harness(true);
  const loading = api.loadHistory();
  pending[0].resolve({ items: [item('a'), item('b'), item('c'), item('d')] });
  await loading;
  flushFrames();
  messages.scrollTop = 20;
  messages.dispatch('scroll');
  api.receiveHistoryMessage(item('late-live'));
  flushFrames();
  assert.equal(messages.scrollTop, messages.scrollHeight);
});

for (const interaction of ['touchmove', 'pointerdown', 'keydown']) {
  test(`${interaction} preserves reading position through resize and live messages`, async () => {
    const { api, pending, messages, resize } = harness(true);
    const loading = api.loadHistory();
    pending[0].resolve({ items: [item('a'), item('b'), item('c'), item('d')] });
    await loading;
    messages.dispatch(interaction, { key: 'PageUp', target: messages });
    messages.scrollTop = 20;
    messages.dispatch('scroll');
    api.receiveHistoryMessage(item('late-live'));
    messages.extraHeight = 600;
    resize();
    assert.equal(messages.scrollTop, 20);
  });
}

test('manual upward scrolling disables late-layout following', async () => {
  const { api, pending, messages, resize } = harness(true);
  const loading = api.loadHistory();
  pending[0].resolve({ items: [item('a'), item('b'), item('c'), item('d')] });
  await loading;
  messages.dispatch('wheel', { deltaY: -100 });
  messages.scrollTop = 20;
  messages.dispatch('scroll');
  messages.extraHeight = 600;
  resize();
  assert.equal(messages.scrollTop, 20);
});

test('date history and older pagination do not jump to bottom on image resize', async () => {
  const { api, pending, messages, resize } = harness(true);
  const loading = api.loadHistory('date', '2026-01-02T13:45');
  pending[0].resolve({ items: [item('a'), item('b')], nextCursor: 'older' });
  await loading;
  messages.extraHeight = 400;
  resize();
  assert.equal(messages.scrollTop, 0);
  const older = api.loadHistory('older');
  pending[1].resolve({ items: [item('past')] });
  await older;
  const top = messages.scrollTop;
  messages.extraHeight += 400;
  resize();
  assert.equal(messages.scrollTop, top);
});

test('a newly sent message immediately adds its friend to recent conversations', () => {
  const { api, nodes } = harness();
  api.state.friends = [{ id: 'peer', name: 'Friend' }];
  api.receiveHistoryMessage({ ...item('sent-message'), echo: true, name: 'My name' });
  assert.deepEqual(Array.from(api.state.conversations, entry => entry.id), ['peer']);
  assert.equal(api.state.conversations[0].name, 'Friend');
  assert.equal(api.state.conversations[0].preview, 'sent-message');
  assert.equal(nodes['#chatListSections'].children.length, 1);
});

for (const kind of ['text', 'image'] as const) {
  test(`${kind} send response adds a recent conversation without WebSocket or page refresh`, async () => {
    const { api, pending, nodes } = harness();
    nodes['#messageInput'].value = 'sent';
    const sending = kind === 'text' ? api.sendText() : api.sendImage({ img: 'YWJj' });
    assert.equal(pending[0].url.pathname, kind === 'text' ? '/message' : '/image');
    pending[0].resolve({ ok: true, item: { ...item('sent'), echo: true, type: kind === 'text' ? 'message' : 'image' } });
    const result = await sending;
    assert.deepEqual(Array.from(api.state.conversations, entry => entry.id), ['peer']);
    assert.equal(api.state.conversations[0].preview, kind === 'text' ? 'sent' : '[图片]');
    assert.equal(pending.length, 1);
    if (kind === 'text') assert.equal(result, true);
    assert.equal(api.state.conversations.length, 1);
  });
}

test('sendText returns false for empty input and uncertain requests without restoring text', async () => {
  const { api, pending, nodes } = harness();
  assert.equal(await api.sendText(), false);
  assert.equal(pending.length, 0);
  nodes['#messageInput'].value = 'retry this';
  const sending = api.sendText();
  pending[0].reject(new Error('send failed'));
  assert.equal(await sending, false);
  assert.equal(nodes['#messageInput'].value, '');
});

test('recent conversations update for other peers, move to the top and ignore older events', () => {
  const { api } = harness();
  api.state.conversations = [{ id: 'peer', updatedAt: '2026-01-01T00:00:00Z' }];
  const message = { ...item('incoming', 'other'), sentAt: '2026-01-02T00:00:00Z', name: 'Other friend' };
  api.receiveHistoryMessage(message);
  api.receiveHistoryMessage(message);
  assert.deepEqual(Array.from(api.state.conversations, entry => entry.id), ['other', 'peer']);
  assert.equal(api.items().length, 0);
  api.receiveHistoryMessage({ ...item('newest'), sentAt: '2026-01-03T00:00:00Z' });
  api.receiveHistoryMessage({ ...item('old'), sentAt: '2025-01-01T00:00:00Z' });
  assert.deepEqual(Array.from(api.state.conversations, entry => entry.id), ['peer', 'other']);
  assert.equal(api.state.conversations[0].preview, 'newest');
});

test('stale list responses cannot remove or overwrite unconfirmed recent messages', async () => {
  const { api, pending } = harness();
  const loading = api.loadConversations();
  const sentAt = '2026-01-03T00:00:00Z';
  api.receiveHistoryMessage({ ...item('newest'), sentAt, echo: true });
  pending[0].resolve({ items: [] });
  await loading;
  assert.equal(api.state.conversations[0].preview, 'newest');
  const stale = api.loadConversations();
  pending[1].resolve({ items: [{ id: 'peer', updatedAt: sentAt, preview: 'old', lastEcho: true }] });
  await stale;
  assert.equal(api.state.conversations[0].preview, 'newest');
  const confirmed = api.loadConversations();
  pending[2].resolve({ items: [{ id: 'peer', updatedAt: sentAt, preview: 'newest', lastEcho: true }] });
  await confirmed;
  const newer = api.loadConversations();
  pending[3].resolve({ items: [{ id: 'peer', updatedAt: '2026-01-04T00:00:00Z', preview: 'from server' }] });
  await newer;
  assert.equal(api.state.conversations[0].preview, 'from server');
});

test('account invalidation clears pending recent updates and foreign-account messages are ignored', async () => {
  const { api, pending } = harness();
  api.state.steam.steamId = 'account-A';
  api.receiveHistoryMessage({ ...item('wrong'), steamAccountId: 'account-B' });
  assert.equal(api.state.conversations.length, 0);
  api.receiveHistoryMessage({ ...item('own'), steamAccountId: 'account-A' });
  api.invalidateChat();
  api.state.conversations = [];
  api.state.steam.steamId = 'account-B';
  const loading = api.loadConversations();
  pending[0].resolve({ items: [] });
  await loading;
  assert.equal(api.state.conversations.length, 0);
});

test('live messages survive a refresh that races database persistence', async () => {
  const { api, pending } = harness();
  api.receiveHistoryMessage(item('not-yet-in-db'));
  const refresh = api.loadHistory();
  pending[0].resolve({ items: [] });
  await refresh;
  assert.deepEqual(Array.from(api.items(), i => i.eventId), ['not-yet-in-db']);
  const confirmed = api.loadHistory();
  pending[1].resolve({ items: [item('not-yet-in-db')] });
  await confirmed;
  assert.equal(api.items().length, 1);
});

test('history pages use opaque cursors, preserve nodes and viewport, and deduplicate live overlap', async () => {
  const { api, pending, messages } = harness();
  const first = api.loadHistory();
  assert.equal(pending[0].url.pathname, '/api/history');
  assert.equal(pending[0].url.searchParams.get('limit'), '100');
  api.receiveHistoryMessage(item('live'));
  pending[0].resolve({ items: [item('a'), item('b'), item('live')], nextCursor: 'opaque+/=' });
  await first;
  assert.deepEqual(Array.from(api.items(), i => i.eventId), ['a', 'b', 'live']);
  const existing = messages.children[0];
  messages.scrollTop = 20;
  const older = api.loadHistory('older');
  assert.equal(pending[1].url.searchParams.get('before'), 'opaque+/=');
  pending[1].resolve({ items: [item('old'), item('old'), item('a')] });
  await older;
  assert.equal(messages.children[1], existing);
  assert.equal(messages.scrollTop, 70);
  api.receiveHistoryMessage(item('live'));
  assert.equal(messages.children.length, 4);
  await api.loadHistory('older');
  assert.equal(pending.length, 2);
});

test('date mode remains isolated from live traffic and can page forward or return latest', async () => {
  const { api, pending, messages } = harness();
  const date = '2026-01-02T13:45';
  const jump = api.loadHistory('date', date);
  assert.equal(pending[0].url.searchParams.get('at'), String(new Date(date).getTime()));
  pending[0].resolve({ items: [item('past')], previousCursor: 'forward' });
  await jump;
  assert.equal(api.detached(), true);
  assert.equal(messages.scrollTop, 0);
  api.receiveHistoryMessage(item('now'));
  assert.equal(messages.children.length, 1);
  const newer = api.loadHistory('newer');
  assert.equal(pending[1].url.searchParams.get('after'), 'forward');
  pending[1].resolve({ items: [item('past'), item('later')] });
  await newer;
  assert.equal(messages.children.length, 2);
  const latest = api.loadHistory();
  api.receiveHistoryMessage(item('live'));
  pending[2].resolve({ items: [item('now')] });
  await latest;
  assert.equal(api.detached(), false);
  assert.deepEqual(Array.from(api.items(), i => i.eventId), ['now', 'live']);
});

test('superseded date, peer ABA, and account responses cannot overwrite current history', async () => {
  const { api, pending } = harness();
  const old = api.loadHistory('date', '2026-01-01T00:00');
  const latest = api.loadHistory();
  pending[1].resolve({ items: [item('latest')] });
  await latest;
  pending[0].resolve({ items: [item('stale')] });
  await old;
  assert.equal(api.items()[0].eventId, 'latest');
  const peer = api.loadHistory();
  api.switchPeer('other');
  api.switchPeer('peer');
  pending[2].resolve({ items: [item('stale')] });
  await peer;
  assert.equal(api.items().length, 0);
  const account = api.loadHistory();
  api.state.steam.steamId = 'new-account';
  api.invalidateChat();
  pending[3].resolve({ items: [item('stale')] });
  await account;
  assert.equal(api.items().length, 0);
  assert.equal(api.busy(), false);
});

test('failed pagination retains messages and cursor for retry without exposing errors', async () => {
  const { api, pending } = harness();
  const first = api.loadHistory();
  pending[0].resolve({ items: [item('a')], nextCursor: 'retry' });
  await first;
  const older = api.loadHistory('older');
  pending[1].reject(new Error('/private/storage/path'));
  await older;
  assert.equal(api.items().length, 1);
  assert.equal(api.busy(), false);
  assert.doesNotMatch(api.state.feedback, /private/);
  const retry = api.loadHistory('older');
  assert.equal(pending[2].url.searchParams.get('before'), 'retry');
  pending[2].resolve({ items: [] });
  await retry;
});

test('conversation load-more merges IDs and ignores stale account results', async () => {
  const { api, pending } = harness();
  const first = api.loadConversations();
  assert.equal(pending[0].url.pathname, '/api/conversations');
  pending[0].resolve({ items: [{ id: 'a' }], nextCursor: 'next' });
  await first;
  const more = api.loadConversations(true);
  assert.equal(pending[1].url.searchParams.get('before'), 'next');
  pending[1].resolve({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'last' });
  await more;
  assert.deepEqual(Array.from(api.state.conversations, i => i.id), ['a', 'b']);
  const stale = api.loadConversations(true);
  api.invalidateChat();
  api.state.conversations = [];
  pending[2].resolve({ items: [{ id: 'secret' }] });
  await stale;
  assert.equal(api.state.conversations.length, 0);
});

test('live messages keep a scrolled-back viewport and follow the bottom only when already there', async () => {
  const { api, pending, messages } = harness();
  const first = api.loadHistory();
  pending[0].resolve({ items: Array.from({ length: 10 }, (_, i) => item(String(i))) });
  await first;
  messages.scrollTop = 20;
  api.receiveHistoryMessage(item('offscreen'));
  assert.equal(messages.scrollTop, 20);
  messages.scrollTop = messages.scrollHeight - messages.clientHeight;
  api.receiveHistoryMessage(item('bottom'));
  assert.equal(messages.scrollTop, messages.scrollHeight);
});

test('storage health uses fixed polite text and rejects stale account results', async () => {
  const { api, pending, nodes } = harness();
  const health = { jsonl: { state: 'failed', queued: 2, writable: false, durable: false, missed: 3, lastError: '/private/log.jsonl' }, rocksdb: { state: 'lagging', queued: 4 } };
  const text = api.storageHealthText(health);
  assert.doesNotMatch(text, /private|lastError/);
  assert.match(text, /2 条待处理/);
  assert.match(text, /3 条未写入/);
  assert.match(text, /正在同步/);
  const request = api.loadStorageHealth();
  api.invalidateChat();
  pending[0].resolve(health);
  await request;
  assert.equal(nodes['#storageHealth'].textContent, api.storageHealthText(null));
});

async function microtasks(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('Expected async recovery to progress');
}

const recovered = (n: number, extra: Partial<Item> = {}): Item => ({ ...item(`recovered-${n}`), steamAccountId: 'account',
  sentAt: new Date(1700000000000 + n * 1000).toISOString(), ...extra });

test('web durable catch-up drains >500 arrivals, keeps identical sends distinct and sorts late history without notifications', async () => {
  const { api, pending, messages } = harness();
  api.state.steam.steamId = 'account'; api.state.view = 'chat';
  api.setSyncCursor('before-sleep');
  api.requestDurableSync();
  for (let page = 0; page < 7; page++) {
    await microtasks(() => pending.length > page);
    assert.equal(pending[page].url.searchParams.get('cursor'), page ? `page-${page}` : 'before-sleep');
    const items = Array.from({ length: page === 6 ? 21 : 100 }, (_, i) => recovered(page * 100 + i, { message: 'identical' }));
    if (page === 6) items[20].sentAt = '2000-01-01T00:00:00.000Z';
    pending[page].resolve({ steamAccountId: 'account', items, nextCursor: `page-${page + 1}`, hasMore: page < 6 });
  }
  await microtasks(() => !api.syncTask());
  assert.equal(api.items().length, 621);
  assert.equal(messages.children.length, 621);
  assert.equal(new Set(api.items().map(i => i.eventId)).size, 621);
  assert.equal(api.items()[0].eventId, 'recovered-620');
  assert.equal(api.syncCursor(), 'page-7');
  // A later WebSocket echo or overlapping replay must leave only one row.
  api.receiveHistoryMessage({ ...recovered(100), echo: true });
  api.requestDurableSync();
  await microtasks(() => pending.length === 8);
  pending[7].resolve({ steamAccountId: 'account', items: [recovered(100), recovered(999, { steamAccountId: 'other-account' })], nextCursor: 'page-8', hasMore: false });
  await microtasks(() => !api.syncTask());
  assert.equal(api.items().length, 621);
});

test('web catch-up retries a failed later page from its last processed cursor', async () => {
  const { api, pending } = harness();
  api.state.steam.steamId = 'account'; api.state.view = 'chat'; api.setSyncCursor('start');
  api.requestDurableSync();
  pending[0].resolve({ steamAccountId: 'account', items: [recovered(1)], nextCursor: 'first', hasMore: true });
  await microtasks(() => pending.length === 2);
  pending[1].reject(new Error('Network lost'));
  await microtasks(() => !api.syncTask());
  assert.equal(api.syncCursor(), 'first');
  api.requestDurableSync();
  assert.equal(pending[2].url.searchParams.get('cursor'), 'first');
  pending[2].resolve({ steamAccountId: 'account', items: [recovered(1), recovered(2)], nextCursor: 'second', hasMore: false });
  await microtasks(() => !api.syncTask());
  assert.deepEqual(Array.from(api.items(), i => i.eventId), ['recovered-1', 'recovered-2']);
});

test('initial sync commits its boundary only after baseline succeeds and preserves existing rows and reading position', async () => {
  const { api, pending, messages } = harness();
  api.state.steam.steamId = 'account'; api.state.view = 'chat';
  const loading = api.loadHistory();
  pending[0].resolve({ items: Array.from({ length: 10 }, (_, n) => recovered(n)), nextCursor: 'older-page' }); await loading;
  const original = messages.children[0]; messages.scrollTop = 17;
  api.requestDurableSync();
  pending[1].resolve({ steamAccountId: 'account', items: [recovered(11)], liveCursor: 'seed', hasMore: true });
  await microtasks(() => pending.length === 4);
  assert.deepEqual(pending.slice(2).map(p => p.url.pathname), ['/api/conversations', '/api/history']);
  pending[2].reject(new Error('Unavailable conversations'));
  pending[3].resolve({ items: [recovered(10), recovered(11)] });
  await microtasks(() => !api.syncTask()); assert.equal(api.syncCursor(), '');
  api.requestDurableSync();
  assert.equal(pending[4].url.pathname, '/api/conversations', 'Retry retains the first snapshot instead of reseeding past new arrivals');
  pending[4].resolve({ items: [{ id: 'peer', name: 'Recovered' }] });
  await microtasks(() => pending.length === 6);
  pending[5].resolve({ items: [recovered(10), recovered(11)] });
  await microtasks(() => pending.length === 7);
  assert.equal(pending[6].url.searchParams.get('cursor'), 'seed');
  pending[6].resolve({ steamAccountId: 'account', items: [recovered(12)], nextCursor: 'end', hasMore: false });
  await microtasks(() => !api.syncTask());
  assert.equal(api.items().length, 13); assert.equal(messages.children[0], original); assert.equal(messages.scrollTop, 17);
});

test('invalidated durable cursor rebases once, while stale account and aborted responses cannot advance it', async () => {
  const { api, pending, timers } = harness(false, true);
  api.state.steam.steamId = 'account'; api.state.view = 'accounts'; api.setSyncCursor('old-generation');
  api.requestDurableSync(); pending[0].reject(Object.assign(new Error('Reset required'), { status: 409 }));
  await microtasks(() => pending.length === 2);
  assert.equal(pending[1].url.searchParams.get('mode'), 'history');
  pending[1].resolve({ steamAccountId: 'account', items: [], liveCursor: 'fresh', hasMore: false });
  await microtasks(() => pending.length === 4);
  assert.equal(pending[2].url.pathname, '/api/conversations');
  assert.equal(pending[3].url.pathname, '/api/history', 'chat history remains mounted underneath the console');
  pending[2].resolve({ items: [] }); pending[3].resolve({ items: [] });
  await microtasks(() => pending.length === 5);
  pending[4].resolve({ steamAccountId: 'account', items: [], nextCursor: 'fresh', hasMore: false });
  await microtasks(() => !api.syncTask()); assert.equal(api.syncCursor(), 'fresh');
  api.requestDurableSync();
  const deadline = [...timers.values()].find(timer => timer.delay === 30000)!; deadline.callback();
  assert.equal(pending[5].signal?.aborted, true);
  pending[5].resolve({ steamAccountId: 'account', items: [recovered(8)], nextCursor: 'unprocessed', hasMore: false });
  await microtasks(() => !api.syncTask()); assert.equal(api.syncCursor(), 'fresh');
  api.requestDurableSync(); api.invalidateChat(); api.state.steam.steamId = 'other-account';
  pending[6].resolve({ steamAccountId: 'account', items: [recovered(9)], nextCursor: 'secret', hasMore: false });
  await microtasks(() => !api.syncTask()); assert.equal(api.items().length, 0); assert.equal(api.syncCursor(), '');
});

test('recovery respects date browsing while updating the recent conversation list', async () => {
  const { api, pending, messages } = harness();
  api.state.view = 'chat'; api.state.steam.steamId = 'account'; api.setSyncCursor('start');
  const loading = api.loadHistory('date', '2023-01-01T00:00'); pending[0].resolve({ items: [recovered(0)] }); await loading;
  const row = messages.children[0]; api.requestDurableSync();
  pending[1].resolve({ steamAccountId: 'account', items: [recovered(1)], nextCursor: 'end', hasMore: false });
  await microtasks(() => !api.syncTask());
  assert.equal(api.detached(), true); assert.equal(api.items().length, 1); assert.equal(messages.children[0], row);
  assert.equal(api.state.conversations[0].preview, 'recovered-1');
  const latest = api.loadHistory(); pending[2].resolve({ items: [recovered(0), recovered(1)] }); await latest;
  assert.equal(api.items().length, 2);
});

test('socket open and durable hints catch up, pong avoids reconnect, and missed pong replaces a half-open socket', async () => {
  const { api, pending, sockets, timers, advance } = harness(false, true);
  api.state.steam.steamId = 'account'; api.setSyncCursor('start'); api.ensureWebSocket();
  const socket = sockets[0]; socket.dispatch('open');
  pending[0].resolve({ steamAccountId: 'account', items: [], nextCursor: 'start', hasMore: false });
  await microtasks(() => !api.syncTask());
  const heartbeat = [...timers.values()].find(timer => timer.delay === 5000)!;
  heartbeat.callback(); assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [{ type: 'ping' }]);
  socket.dispatch('message', { data: JSON.stringify({ type: 'pong' }) });
  advance(11000); heartbeat.callback(); assert.equal(socket.closed, false);
  socket.dispatch('message', { data: JSON.stringify({ type: 'sync_available', steamAccountId: 'wrong-account' }) });
  assert.equal(pending.length, 1);
  socket.dispatch('message', { data: JSON.stringify({ type: 'sync_available', steamAccountId: 'account' }) });
  socket.dispatch('message', { data: JSON.stringify({ type: 'sync_available', steamAccountId: 'account' }) });
  assert.equal(pending.length, 1, 'Hints coalesce before starting another HTTP request');
  [...timers.values()].find(timer => timer.delay === 250)!.callback();
  assert.equal(pending.length, 2);
  pending[1].resolve({ steamAccountId: 'account', items: [recovered(1)], nextCursor: 'hint', hasMore: false });
  await microtasks(() => !api.syncTask());
  advance(11000); heartbeat.callback(); assert.equal(socket.closed, false, 'A slow pong does not discard the connection');
  advance(45000); heartbeat.callback(); assert.equal(socket.closed, true); assert.equal(sockets.length, 2);
  assert.equal(pending[2].url.searchParams.get('cursor'), 'hint');
  api.stopWebSocket(); api.stopStatusPolling();
});

test('wake events and timer gaps reuse open sockets and do not abort in-flight catch-up', async () => {
  const { api, pending, sockets, timers, events, advance } = harness(false, true);
  api.state.view = 'accounts';
  api.state.steam.steamId = 'account'; api.setSyncCursor('start'); api.ensureWebSocket(); api.startStatusPolling(); api.setupRealtimeResume();
  const poll = [...timers.values()].find(timer => timer.delay === 5000)!;
  void poll.callback(); assert.equal(pending[1].url.pathname, '/api/steam/status');
  pending[0].resolve({ steamAccountId: 'account', items: [], nextCursor: 'start', hasMore: false });
  await microtasks(() => !api.syncTask());
  advance(60000); await poll.callback();
  assert.equal(pending[1].signal?.aborted, false); assert.equal(sockets[0].closed, false); assert.equal(sockets.length, 1);
  assert.equal(pending[2].url.pathname, '/api/history/status', 'health remains polled with a console overlay');
  assert.equal(pending[3].url.searchParams.get('cursor'), 'start');
  pending[3].resolve({ steamAccountId: 'account', items: [], nextCursor: 'start', hasMore: false });
  await microtasks(() => !api.syncTask());
  for (const event of ['visibilitychange', 'online', 'pageshow']) {
    const prior: number = sockets.length; events.dispatch(event, { persisted: true });
    assert.equal(sockets.length, prior); assert.equal(sockets[prior - 1].closed, false);
    const request = pending[pending.length - 1];
    request.resolve({ steamAccountId: 'account', items: [], nextCursor: 'start', hasMore: false });
    await microtasks(() => !api.syncTask());
  }
  api.stopWebSocket(); api.stopStatusPolling(); pending[1].reject(new Error('Aborted stale poll')); pending[2].reject(new Error('Aborted stale health poll'));
});

test('periodic message sync continues when Steam status fails, and a timed-out health read releases polling', async () => {
  const { api, pending, timers, advance } = harness(false, true);
  api.state.view = 'chat'; api.state.steam.steamId = 'account'; api.state.steam.status = 'online'; api.setSyncCursor('start');
  api.startStatusPolling(); const poll = [...timers.values()].find(timer => timer.delay === 5000)!;
  const first = poll.callback();
  assert.equal(pending[0].url.pathname, '/api/messages/sync');
  pending[1].reject(new Error('Status unavailable')); await first;
  assert.equal(pending[2].url.pathname, '/api/history/status');
  assert.equal(pending[2].signal?.aborted, true);
  pending[2].reject(new Error('Aborted alongside status'));
  pending[0].resolve({ steamAccountId: 'account', items: [recovered(1)], nextCursor: 'end', hasMore: false });
  await microtasks(() => !api.syncTask()); assert.equal(api.items().length, 1);
  advance(60000);
  const second = poll.callback();
  pending[3].resolve({ steamAccountId: 'account', items: [], nextCursor: 'end', hasMore: false });
  pending[4].resolve({ status: 'online', steamId: 'account', accessAllowed: true });
  await microtasks(() => !api.syncTask());
  assert.equal(pending[5].url.pathname, '/api/history/status');
  [...timers.values()].find(timer => timer.delay === 30000)!.callback();
  assert.equal(pending[5].signal?.aborted, true);
  pending[5].reject(new Error('Health request aborted')); await second;
  advance(10000);
  const third = poll.callback(); assert.equal(pending[6].url.pathname, '/api/steam/status');
  pending[6].reject(new Error('End of test')); await third; api.stopStatusPolling();
});

test('cached conversations render before a delayed request, restore reading position and merge overlapping history', async () => {
  const { api, pending, messages } = harness();
  api.state.view = 'chat'; api.state.steam.steamId = 'account';
  const initial = api.loadHistory();
  pending[0].resolve({ items: Array.from({ length: 10 }, (_, i) => recovered(i)), nextCursor: 'older' }); await initial;
  messages.scrollTop = 27;
  api.openConversation('other');
  api.openConversation('peer');
  assert.equal(api.items().length, 10, 'Switching back does not wait for either request');
  assert.equal(messages.scrollTop, 27);
  pending[1].resolve({ items: [item('wrong-peer', 'other')] });
  pending[2].resolve({ items: [recovered(9), recovered(10)], nextCursor: 'new-older' });
  await microtasks(() => !api.busy());
  assert.equal(api.items().length, 11); assert.equal(messages.scrollTop, 27);
  const older = api.loadHistory('older');
  assert.equal(pending[3].url.searchParams.get('before'), 'older');
  pending[3].resolve({ items: [] }); await older;
});

test('cached date pages survive switching and a disjoint latest refresh keeps the server pagination boundary', async () => {
  const { api, pending } = harness();
  api.state.view = 'chat'; api.state.steam.steamId = 'account';
  const initial = api.loadHistory('date', '2023-01-01T00:00'); pending[0].resolve({ items: [recovered(0)] }); await initial;
  api.openConversation('other'); api.openConversation('peer');
  assert.equal(pending.length, 2, 'Returning to a cached date page does not reset it to latest');
  assert.equal(api.detached(), true); assert.equal(api.items()[0].eventId, 'recovered-0');
  const latest = api.loadHistory('latest', '', { preserve: true, cacheRefresh: true });
  pending[2].resolve({ items: [recovered(99)], nextCursor: 'gap' }); await latest;
  assert.deepEqual(Array.from(api.items(), row => row.eventId), ['recovered-99']);
  const older = api.loadHistory('older'); assert.equal(pending[3].url.searchParams.get('before'), 'gap');
  pending[3].resolve({ items: [recovered(98)] }); await older;
});

test('disk cache restores after authentication, stays isolated by user/account, and invalidation clears it', async () => {
  const disk = new Map<string, unknown>();
  const first = harness(false, true, disk);
  first.api.state.steam.steamId = 'account'; first.api.state.view = 'chat';
  const loading = first.api.loadHistory(); first.pending[0].resolve({ items: [recovered(1)] }); await loading;
  [...first.timers.values()].find(timer => timer.delay === 500)!.callback();
  await microtasks(() => disk.has('recent'));
  const next = harness(false, true, disk); next.api.state.steam.steamId = 'account'; next.api.state.view = 'chat';
  await next.api.restoreChatCache(); assert.equal(next.api.items()[0].eventId, 'recovered-1');
  assert.equal(next.pending.length, 0);
  const differentUser = harness(false, true, disk); differentUser.api.state.steam.steamId = 'account'; differentUser.api.state.me.id = 2;
  await differentUser.api.restoreChatCache(); assert.equal(differentUser.api.restoreThread(), false);
  const differentAccount = harness(false, true, disk); differentAccount.api.state.steam.steamId = 'other-account';
  await differentAccount.api.restoreChatCache(); assert.equal(differentAccount.api.restoreThread(), false);
  next.api.invalidateChat(); await microtasks(() => !disk.size);
  assert.equal(next.api.restoreThread(), false);
});

test('disk hydration cannot cross invalidation and persistent history never hides an offline gap', async () => {
  const disk = new Map<string, unknown>([['recent', { scope: '1:0:account', savedAt: Date.now(), conversations: [],
    threads: [['peer', { items: [recovered(0)], savedAt: Date.now(), before: 'stale-cursor', following: true }]] }]]);
  const stale = harness(false, true, disk); stale.api.state.steam.steamId = 'account'; stale.api.state.view = 'chat';
  const hydration = stale.api.restoreChatCache(); stale.api.invalidateChat(); await hydration;
  assert.equal(stale.api.restoreThread(), false);
  disk.set('recent', { scope: '1:0:account', savedAt: Date.now(), conversations: [],
    threads: [['peer', { items: [recovered(0), recovered(1)], savedAt: Date.now(), before: 'stale-cursor', following: true }]] });
  const next = harness(false, true, disk); next.api.state.steam.steamId = 'account'; next.api.state.view = 'chat';
  await next.api.restoreChatCache();
  next.api.receiveHistoryMessage(recovered(99));
  const refresh = next.api.loadHistory('latest', '', { preserve: true, cacheRefresh: true });
  next.pending[0].resolve({ items: [recovered(98), recovered(99)], nextCursor: 'correct-boundary' }); await refresh;
  assert.deepEqual(Array.from(next.api.items(), row => row.eventId), ['recovered-98', 'recovered-99']);
  const older = next.api.loadHistory('older'); assert.equal(next.pending[1].url.searchParams.get('before'), 'correct-boundary');
  next.pending[1].resolve({ items: [] }); await older;
});

test('disk snapshots stay bound to the complete Steam grant, including equal-size peer replacements', async () => {
  const disk = new Map<string, unknown>([['recent', { scope: '1:0:account:old-peers', savedAt: Date.now(), conversations: [{ id: 'peer', name: 'previously authorized' }],
    threads: [['peer', { items: [recovered(0)], savedAt: Date.now(), following: true }]] }]]);
  const restricted = harness(false, true, disk);
  restricted.api.state.steam.steamId = 'account'; restricted.api.state.view = 'chat';
  restricted.api.state.steam.steamGrant = { level: 'read', scope: 'some', peerCount: 1 };
  restricted.api.state.steam.accessRevision = 'new-peers';
  await restricted.api.restoreChatCache();
  assert.equal(restricted.api.items().length, 0); assert.equal(restricted.api.state.conversations.length, 0);
  const same = harness(false, true, disk); same.api.state.steam.steamId = 'account'; same.api.state.view = 'chat';
  same.api.state.steam.steamGrant = { level: 'read', scope: 'some', peerCount: 1 }; same.api.state.steam.accessRevision = 'old-peers';
  await same.api.restoreChatCache(); assert.equal(same.api.items().length, 1);
  const oldServer = harness(false, true, disk); oldServer.api.state.steam.steamId = 'account'; oldServer.api.state.view = 'chat';
  oldServer.api.state.steam.steamGrant = { level: 'read', scope: 'some', peerCount: 1 };
  await oldServer.api.restoreChatCache(); assert.equal(oldServer.api.items().length, 0);
});

test('authoritative empty network results cannot be resurrected by later disk hydration', async () => {
  const disk = new Map<string, unknown>([['recent', { scope: '1:0:account', savedAt: Date.now(), conversations: [{ id: 'peer', name: 'old' }],
    threads: [['peer', { items: [recovered(0)], savedAt: Date.now(), following: true }]] }]]);
  const { api, pending } = harness(false, true, disk);
  api.state.steam.steamId = 'account'; api.state.view = 'chat';
  const history = api.loadHistory(), conversations = api.loadConversations();
  pending[0].resolve({ items: [] }); pending[1].resolve({ items: [] }); await Promise.all([history, conversations]);
  await api.restoreChatCache();
  assert.equal(api.items().length, 0); assert.equal(api.state.conversations.length, 0);
  assert.equal(api.restoreThread(), false);
});

test('revoked history access clears cached data, but a stale denial cannot revoke a different account', async () => {
  const { api, pending } = harness(); api.state.steam.steamId = 'account';
  const initial = api.loadHistory(); pending[0].resolve({ items: [recovered(0)] }); await initial;
  const denied = api.loadHistory(); pending[1].respond(403, { error: 'Access denied' }); await denied;
  assert.equal(api.items().length, 0); assert.equal(api.restoreThread(), false);
  assert.equal(api.state.steam.accessAllowed, false);
  api.state.steam.accessAllowed = true;
  const oldRequest = api.loadHistory();
  api.invalidateChat(); api.state.steam.steamId = 'other-account';
  pending[2].respond(403, { error: 'Old account denied' }); await oldRequest;
  assert.equal(api.state.steam.accessAllowed, true);
});

test('inventory loads on demand and coalesces simultaneous picker requests', async () => {
  const { api, pending } = harness(); api.state.steam.status = 'online';
  const first = api.loadChatInventory(), second = api.loadChatInventory();
  assert.equal(pending.length, 1); assert.equal(pending[0].url.pathname, '/api/emoticons');
  pending[0].resolve({ emoticons: [], stickers: [], effects: [] }); await Promise.all([first, second]);
  await api.loadChatInventory(); assert.equal(pending.length, 1);
});

const savedInventory = { emoticons: [{ name: ':wave:' }], stickers: [{ name: 'Heart' }], effects: [{ name: 'Snow' }] };

test('inventory survives a page refresh and remains usable while refresh is pending or fails', async () => {
  const storage = new Map<string, string>();
  const first = harness(false, true, undefined, storage);
  first.api.state.steam.steamId = 'account'; first.api.state.steam.status = 'online';
  const loading = first.api.loadChatInventory(); first.pending[0].resolve(savedInventory); await loading;
  assert.ok(storage.get('steam-chat.inventory.v1'));
  const reloaded = harness(false, true, undefined, storage);
  reloaded.api.state.steam.steamId = 'account'; reloaded.api.state.steam.status = 'online';
  const refresh = reloaded.api.loadChatInventory();
  assert.equal(reloaded.api.state.emoticons[0].name, ':wave:');
  assert.equal(reloaded.api.state.stickers[0].name, 'Heart');
  assert.equal(reloaded.api.state.effects[0].name, 'Snow');
  reloaded.pending[0].respond(503, { error: 'Steam temporarily unavailable' }); await refresh;
  assert.equal(reloaded.api.state.stickers[0].name, 'Heart');
  reloaded.api.state.steam.status = 'reconnecting';
  await reloaded.api.refreshChatData(false);
  assert.equal(reloaded.api.state.emoticons[0].name, ':wave:');
  assert.equal(reloaded.api.state.effects[0].name, 'Snow');
});

test('a stale inventory response triggers another fetch and a complete empty refresh replaces old data', async () => {
  const { api, pending, advance } = harness(false, true);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  const loading = api.loadChatInventory();
  pending[0].resolve({ ...savedInventory, cache: { stale: true, refreshing: true } }); await loading;
  assert.equal(api.state.stickers[0].name, 'Heart');
  await api.loadChatInventory(); assert.equal(pending.length, 1);
  advance(2001);
  const refresh = api.loadChatInventory(); assert.equal(pending.length, 2);
  assert.equal(api.state.effects[0].name, 'Snow');
  pending[1].resolve({ emoticons: [], stickers: [], effects: [], cache: { stale: false, refreshing: false } }); await refresh;
  assert.equal(api.state.emoticons.length + api.state.stickers.length + api.state.effects.length, 0);
});

test('same-account reconnect keeps saved inventory when the live Steam ID temporarily disappears', async () => {
  const storage = new Map<string, string>();
  const { api, pending } = harness(false, true, undefined, storage);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  api.state.steam.activeAccount = { id: 1, steamId: 'account', label: 'Main' };
  const loading = api.loadChatInventory(); pending[0].resolve(savedInventory); await loading;
  const snapshot = storage.get('steam-chat.inventory.v1');
  const previous = { ...api.state.steam };
  api.updateSteamStatus({ ...previous, status: 'reconnecting', steamId: null });
  assert.equal(api.state.stickers[0].name, 'Heart');
  assert.equal(storage.get('steam-chat.inventory.v1'), snapshot);
  await api.loadChatInventory(); assert.equal(pending.length, 1);
  api.updateSteamStatus({ ...previous, status: 'online' });
  assert.equal(api.state.effects[0].name, 'Snow');
  assert.equal(storage.get('steam-chat.inventory.v1'), snapshot);
});

test('malformed inventory updates preserve every previous category', async () => {
  const { api, pending, advance } = harness(false, true);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  const loading = api.loadChatInventory(); pending[0].resolve(savedInventory); await loading;
  advance(10 * 60_000 + 1);
  const refresh = api.loadChatInventory(); pending[1].resolve({ emoticons: [], effects: [] }); await refresh;
  assert.equal(api.state.emoticons[0].name, ':wave:');
  assert.equal(api.state.stickers[0].name, 'Heart');
  assert.equal(api.state.effects[0].name, 'Snow');
});

test('partial inventory refresh updates healthy categories and retains failed browser snapshots', async () => {
  const { api, pending, advance } = harness(false, true);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  const loading = api.loadChatInventory(); pending[0].resolve(savedInventory); await loading;
  advance(10 * 60_000 + 1);
  const refresh = api.loadChatInventory();
  pending[1].resolve({ emoticons: [{ name: ':new:' }], stickers: [{ name: 'New Heart' }], effects: [],
    cache: { stale: true, failedCategories: ['stickers'] } });
  await refresh;
  assert.equal(api.state.emoticons[0].name, ':new:');
  assert.equal(api.state.stickers[0].name, 'Heart');
  assert.equal(api.state.stickers[1].name, 'New Heart', 'verified partial additions remain usable alongside cached items');
  assert.equal(api.state.effects.length, 0, 'a successful empty category still removes old ownership');
  advance(2001);
  const recovered = api.loadChatInventory();
  pending[2].resolve({ emoticons: [], stickers: [], effects: [] }); await recovered;
  assert.equal(api.state.emoticons.length + api.state.stickers.length + api.state.effects.length, 0);
});

test('inventory refresh respects server freshness and retry cooldown without hiding cached items', async () => {
  const { api, pending, advance, now: clock } = harness(false, true);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  const now = clock();
  const loading = api.loadChatInventory();
  pending[0].resolve({ ...savedInventory, cache: { updatedAt: now - 9 * 60_000, stale: false, refreshing: false } }); await loading;
  advance(60_001);
  const refreshing = api.loadChatInventory(); assert.equal(pending.length, 2);
  pending[1].resolve({ ...savedInventory, cache: { stale: true, refreshing: false, retryAt: now + 90_001 } }); await refreshing;
  advance(2001); await api.loadChatInventory(); assert.equal(pending.length, 2);
  assert.equal(api.state.stickers[0].name, 'Heart');
  advance(28_000);
  const retry = api.loadChatInventory(); assert.equal(pending.length, 3);
  pending[2].resolve(savedInventory); await retry;
});

test('persisted inventory is isolated by user, session version and Steam account', async () => {
  const storage = new Map<string, string>();
  const original = harness(false, true, undefined, storage);
  original.api.state.steam.steamId = 'account'; original.api.state.steam.status = 'online';
  const loading = original.api.loadChatInventory(); original.pending[0].resolve(savedInventory); await loading;
  const snapshot = storage.get('steam-chat.inventory.v1')!;
  for (const [userId, sessionVersion, account] of [[2, 0, 'account'], [1, 1, 'account'], [1, 0, 'other-account']] as const) {
    storage.set('steam-chat.inventory.v1', snapshot);
    const next = harness(false, true, undefined, storage);
    next.api.state.me = { id: userId, sessionVersion };
    next.api.state.steam.steamId = account; next.api.state.steam.status = 'online';
    const refreshing = next.api.loadChatInventory();
    assert.equal(next.api.state.stickers.length, 0);
    next.pending[0].resolve({ emoticons: [], stickers: [], effects: [] }); await refreshing;
  }
});

test('an account change invalidates pending inventory and clears the persistent snapshot', async () => {
  const storage = new Map<string, string>();
  const { api, pending } = harness(false, true, undefined, storage);
  api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  const old = api.loadChatInventory(); api.invalidateChat(); api.state.steam.steamId = 'other-account';
  const current = api.loadChatInventory(); pending[1].resolve({ emoticons: [{ name: ':new:' }], stickers: [], effects: [] }); await current;
  pending[0].resolve(savedInventory); await old;
  assert.equal(api.state.emoticons[0].name, ':new:');
  assert.doesNotMatch(storage.get('steam-chat.inventory.v1')!, /Heart/);
});

test('one-phase image upload sends its operation identity and bytes together, then only queries on lost response', async () => {
  const { api, pending } = harness();
  api.state.steam.steamId = 'account'; api.state.sendOperations = api.state.imageOperationUpload = true;
  const sending = api.sendImage({ img: 'data:image/png;base64,YWJj' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url.pathname, '/api/send-operations/upload');
  const body = JSON.parse(pending[0].body!);
  assert.match(body.operationId, /^[a-f0-9]{32}$/);
  assert.equal(body.img, 'data:image/png;base64,YWJj');
  pending[0].reject(new Error('Response lost after upload'));
  await sending;
  assert.equal(api.outgoing()[0].state, 'unknown');
  assert.equal(pending[1].url.pathname, `/api/send-operations/${body.operationId}`);
  assert.equal(pending[1].body, undefined, 'Recovery does not upload or create another task');
  pending[1].resolve({ id: body.operationId, peerId: 'peer', steamAccountId: 'account', version: 3, state: 'sent',
    hasImage: true, item: recovered(1, { echo: true, type: 'image', message: 'https://example.test/image.png' }) });
  await microtasks(() => api.outgoing().length === 0);
  assert.equal(api.items().length, 1);
});

test('one-phase successful image upload does not add an immediate redundant query', async () => {
  const { api, pending } = harness();
  api.state.steam.steamId = 'account'; api.state.sendOperations = api.state.imageOperationUpload = true;
  const sending = api.sendImage({ img: 'data:image/png;base64,YWJj' });
  const body = JSON.parse(pending[0].body!);
  pending[0].resolve({ id: body.operationId, peerId: 'peer', steamAccountId: 'account', version: 2, state: 'queued',
    hasImage: true, attempts: 0, maxAttempts: 6, nextRetryAt: 0 });
  await sending;
  assert.equal(pending.length, 1); assert.equal(api.outgoing()[0].state, 'sending');
});

for (const missing of [false, true]) test(`rejected image upload remains failed after querying ${missing ? 'missing' : 'prepared'} operation`, async () => {
  const { api, pending } = harness();
  api.state.steam.steamId = 'account'; api.state.sendOperations = api.state.imageOperationUpload = true;
  const sending = api.sendImage({ img: 'data:image/png;base64,broken' });
  const body = JSON.parse(pending[0].body!);
  pending[0].respond(400, { error: '无法识别图片格式。' }); await sending;
  assert.equal(api.outgoing()[0].state, 'failed');
  if (missing) pending[1].respond(410, { error: 'No operation' });
  else pending[1].resolve({ id: body.operationId, peerId: 'peer', steamAccountId: 'account', version: 1, state: 'prepared',
    hasImage: false, attempts: 0, maxAttempts: 6, nextRetryAt: 0 });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(api.outgoing()[0].state, 'failed');
  assert.equal((api.outgoing()[0] as { error?: string }).error, '无法识别图片格式。');
  assert.equal(pending.length, 2);
});

for (const date of [false, true]) test(`durable cursor reset invalidates cached ${date ? 'date' : 'latest'} pagination even with realtime tail overlap`, async () => {
  const { api, pending } = harness(); api.state.steam.steamId = 'account'; api.state.view = 'chat';
  const initial = api.loadHistory(date ? 'date' : 'latest', date ? '2023-01-01T00:00' : '');
  pending[0].resolve({ items: [recovered(0), recovered(1)], nextCursor: 'obsolete-boundary' }); await initial;
  api.openConversation('other');
  pending[1].resolve({ items: [recovered(0, { id: 'other' })] }); await microtasks(() => !api.busy());
  api.receiveHistoryMessage(recovered(99));
  api.setSyncCursor('expired'); api.requestDurableSync();
  pending[2].reject(Object.assign(new Error('Storage generation changed'), { status: 409 }));
  await microtasks(() => pending.length === 4);
  pending[3].resolve({ steamAccountId: 'account', items: [], liveCursor: 'new-seed', hasMore: false });
  await microtasks(() => pending.length === 6);
  pending[4].resolve({ items: [{ id: 'peer' }, { id: 'other' }] });
  pending[5].resolve({ items: [recovered(0, { id: 'other' })] });
  await microtasks(() => pending.length === 7);
  pending[6].resolve({ steamAccountId: 'account', items: [], nextCursor: 'new-live', hasMore: false });
  await microtasks(() => !api.syncTask());
  api.openConversation('peer');
  assert.equal(pending[7].url.pathname, '/api/history');
  assert.equal(pending[7].url.searchParams.has('at'), date);
  pending[7].resolve({ items: date ? [recovered(0), recovered(1)] : [recovered(98), recovered(99)], nextCursor: 'new-boundary' });
  await microtasks(() => !api.busy());
  assert.deepEqual(Array.from(api.items(), row => row.eventId), date ? ['recovered-0', 'recovered-1'] : ['recovered-98', 'recovered-99']);
  assert.equal(api.detached(), date);
  const older = api.loadHistory('older'); assert.equal(pending[8].url.searchParams.get('before'), 'new-boundary');
  pending[8].resolve({ items: [] }); await older;
});

test('authenticated bootstrap uses the bundled configuration without extra status/config round trips', async () => {
  const { api, pending, nodes } = harness(); delete nodes['#chatLayout'];
  const starting = api.bootstrap();
  assert.equal(pending[0].url.pathname, '/api/auth/me');
  pending[0].resolve({ user: { id: 1 }, permissions: [], steam: { status: 'online', steamId: 'account', accessAllowed: true },
    config: { wsPath: '/chat-ws', sendOperations: true, imageOperationUpload: true } });
  await starting;
  assert.equal(pending.length, 1);
  assert.equal(api.state.sendOperations, true); assert.equal(api.state.imageOperationUpload, true);
});

test('healthy foreground status polling is throttled and hidden tabs defer background requests', async () => {
  const { api, pending, timers, advance, setVisibility } = harness(false, true);
  api.state.view = 'accounts'; api.state.steam.steamId = 'account'; api.state.steam.status = 'online';
  api.setSyncCursor('start'); api.ensureWebSocket(); api.startStatusPolling();
  const poll = [...timers.values()].find(timer => timer.delay === 5000)!;
  const first = poll.callback();
  pending[0].resolve({ steamAccountId: 'account', items: [], nextCursor: 'start', hasMore: false });
  pending[1].resolve({ status: 'online', steamId: 'account', accessAllowed: true });
  assert.equal(pending[2].url.pathname, '/api/history/status');
  pending[2].resolve({ jsonl: { state: 'healthy', queued: 0 }, rocksdb: { state: 'healthy', queued: 0 } });
  await first; await microtasks(() => !api.syncTask());
  for (let i = 0; i < 5; i++) { advance(5000); await poll.callback(); }
  assert.equal(pending.length, 3, 'No three-second status or per-tick health request');
  advance(5000); const second = poll.callback();
  assert.equal(pending[3].url.pathname, '/api/steam/status');
  pending[3].resolve({ status: 'online', steamId: 'account', accessAllowed: true }); await second;
  setVisibility('hidden'); advance(60000); await poll.callback();
  assert.equal(pending.length, 4);
  api.stopStatusPolling(); api.stopWebSocket();
});
