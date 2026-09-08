import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = [];
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
  append(...nodes: Element[]) { this.children.push(...nodes); }
  prepend(...nodes: Element[]) { this.children.unshift(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  querySelector(): null { return null; }
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
type Pending = { url: URL; resolve: (value: unknown) => void; reject: (error: Error) => void };
function harness(withLayout = false) {
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
  const nodes: Record<string, Element> = { '#app': new Element(), '#chatListSections': new Element(), '#messageInput': new Element(), '#messages': new Element(), '#historyOlder': new Element(), '#storageHealth': new Element() };
  const pending: Pending[] = [];
  const sandbox = {
    document: { querySelector: (id: string) => nodes[id] || null, querySelectorAll: (): Element[] => [], addEventListener() {}, createElement: () => new Element() },
    localStorage: { getItem: (): null => null, setItem() {} },
    ...(withLayout ? { ResizeObserver: LayoutObserver,
      requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id: number) => frames.delete(id) } : {}),
    URL, URLSearchParams, Headers, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: (url: string) => new Promise((resolve, reject) => pending.push({ url: new URL(url, 'http://test'), resolve: (payload) => resolve({ ok: true, json: async () => payload }), reject })),
    __test: undefined as unknown
  };
  runInNewContext(`${source.slice(0, source.lastIndexOf('bootstrap().catch'))}
    uploadRequest = (path, options) => fetch(path, options);
    renderMessage = (item) => { const row = document.createElement('article'); row.dataset.eventId = item.eventId; return row; };
    state.me = {id: 1}; state.activeId = 'peer'; state.steam.accessAllowed = true;
    resizeComposerInput = () => {};
    globalThis.__test = {sendText, sendImage, loadHistory, loadConversations, receiveHistoryMessage, loadStorageHealth, storageHealthText,
      resetHistory, invalidateChat, state, items: () => historyItems,
      switchPeer: (id) => { state.activeId = id; resetHistory(); },
      detached: () => historyDetached, busy: () => historyBusy};`, sandbox);
  const api = sandbox.__test as {
    sendText: () => Promise<boolean>;
    sendImage: (payload: Record<string, string>) => Promise<void>;
    loadHistory: (mode?: string, date?: string) => Promise<void>;
    loadConversations: (more?: boolean) => Promise<void>;
    receiveHistoryMessage: (item: Item) => void;
    loadStorageHealth: () => Promise<void>;
    storageHealthText: (payload: unknown) => string;
    resetHistory: () => void;
    invalidateChat: () => void;
    switchPeer: (id: string) => void;
    state: { steam: { steamId: string }; friends: Array<{id: string; name: string}>; activeName: string;
      conversations: Array<{id: string; name?: string; preview?: string; updatedAt?: string}>; feedback: string };
    items: () => Item[];
    detached: () => boolean;
    busy: () => boolean;
  };
  return { api, pending, messages: nodes['#messages'], nodes,
    flushFrames,
    resize: () => { for (const observer of [...observers]) if (observer.active) observer.callback(); flushFrames(); } };
}
const item = (eventId: string, id = 'peer'): Item => ({ id, eventId, message: eventId });

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
    for (let i = 0; i < 30 && pending.length < 2; i++) await Promise.resolve();
    assert.deepEqual(Array.from(api.state.conversations, entry => entry.id), ['peer']);
    assert.equal(api.state.conversations[0].preview, kind === 'text' ? 'sent' : '[图片]');
    pending[1].resolve({ items: [] });
    const result = await sending;
    if (kind === 'text') assert.equal(result, true);
    assert.equal(api.state.conversations.length, 1);
  });
}

test('sendText returns false for empty input and failed requests, retaining failed text', async () => {
  const { api, pending, nodes } = harness();
  assert.equal(await api.sendText(), false);
  assert.equal(pending.length, 0);
  nodes['#messageInput'].value = 'retry this';
  const sending = api.sendText();
  pending[0].reject(new Error('send failed'));
  assert.equal(await sending, false);
  assert.equal(nodes['#messageInput'].value, 'retry this');
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
