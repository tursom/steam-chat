// Regression replays of the counterexamples against the repaired protocol.
// No Steam connection, DOM implementation, production source edits, or build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../web/app.ts'), 'utf8');
const ast = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['textSendCheckReason', 'reconcileOutgoingText', 'beginOutgoing',
  'finishOutgoing', 'outgoingFailure', 'canActOnOutgoingText', 'retryOutgoingText',
  'resendOutgoingText', 'checkOutgoingText', 'sendOutgoingText', 'receiveHistoryMessage', 'jsonBody']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size, 'production function names must still exist');
const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const apiNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'api');
assert.ok(apiNode);
const apiCode = ts.transpileModule(apiNode.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

const account = '76561198000000002';
const peer = '76561198000000001';
const epoch = Date.parse('2026-11-03T00:00:00Z');

function fixture() {
  let clock = epoch;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const requests = [];
  const origins = new Map(); // independent oracle, never passed to production
  let checkedItems = [];
  let checks = 0;
  const noop = () => {};
  const context = {
    Date: Clock, Map, Set, AbortController, console,
    // Timers are not under test: explicit failures replay timeout observations.
    setTimeout: () => 1, clearTimeout: noop,
    document: { visibilityState: 'hidden', querySelector: () => null },
    state: { me: { id: 1 }, steam: { steamId: account, activeAccount: { steamId: account } },
      activeId: peer, view: 'chat', unreadCounts: {} },
    chatContext: () => 'original-account-context', steamAccessAllowed: () => true,
    steamOnline: () => true, grantAtLeast: () => true,
    isCommunityGroup: () => false, requiresFullText: () => false,
    textCooldownBlocked: () => false, isRecord: value => value !== null && typeof value === 'object',
    errorMessage: error => error.message,
    asMessages: items => items, uniqueMessages: items => items,
    refreshOutgoing: noop, updateRecentConversation: noop, updateCachedMessage: noop,
    scheduleChatCache: noop, notifyIncomingMessage: noop, updateHistoryControls: noop,
    loadHistory: noop,
    api: async (url, options) => {
      if (url === '/api/messages/check') { checks++; return { items: checkedItems }; }
      assert.equal(url, '/message');
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ ...JSON.parse(options.body), resolve, reject });
      return promise;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    const outgoingMessages = new Map(), unreadEvents = new Set();
    let historyItems = [], historyLive = [], outgoingId = 0;
    let historyDetached = false, historyBrowsingRequest = false, historyBusy = false;
    let historyRequest = 0, historyBefore = '', historyAfter = '', historyAt = '';
    const networkDeadlineMs = 30000;
    ${code}
    this.harness = {
      begin: () => beginOutgoing('${peer}', 'same text', 'message', 'same text'),
      submit: sendOutgoingText, retry: retryOutgoingText, replace: resendOutgoingText, check: checkOutgoingText,
      receive: receiveHistoryMessage, has: id => outgoingMessages.has(id),
      history: () => historyItems,
      loadDatePage: item => { historyItems = [item]; }
    };
  `, context);
  const h = context.harness;
  return {
    ...h, requests, origins,
    useServer(base, responses) {
      context.Headers = Headers;
      context.steamRateLimitMetadata = () => null;
      context.fetch = async (url, options) => {
        const response = await fetch(base + url, options);
        responses.push({ status: response.status, payload: await response.clone().json() });
        return response;
      };
      vm.runInContext(apiCode, context);
    },
    advance(seconds) { clock = epoch + seconds * 1000; },
    event(id, origin, seconds) {
      origins.set(id, origin);
      return { id: peer, steamAccountId: account, type: 'message', echo: true,
        eventId: id, message: 'same text', sentAt: new Date(epoch + seconds * 1000).toISOString() };
    },
    checkItems(items) { checkedItems = items; },
    counts() { return { sends: requests.length, checks }; },
    async unknown(task, index) {
      requests[index].reject(Object.assign(new Error('HTTP 502'), { uncertain: true, status: 502 }));
      assert.equal(await task, false);
    }
  };
}

test('TLC external-attribution: official-client echo is only candidate evidence', async () => {
  const f = fixture();
  const original = f.begin();
  const task = f.submit(original);
  await f.unknown(task, 0);
  const external = f.event('official-client-event', 'external', 1);
  f.receive(external);
  assert.notEqual(f.origins.get(external.eventId), original.localId);
  assert.equal(original.textCandidateFound, true);
  assert.match(original.textCheckReason, /找到相同内容.*无法确认/);
  assert.equal(original.state, 'unknown');
  assert.equal(f.has(original.localId), true, 'a different sender cannot silently dismiss this unknown request');
  assert.equal(f.counts().sends, 1);
});

test('TLC replacement-attribution: neither attempt owns the original echo', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.advance(1);
  const replacementTask = f.replace(original);
  const replacementId = original.replacementLocalId;
  const actual = f.event('original-steam-event', original.localId, 1);
  f.receive(actual);
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  await f.unknown(replacementTask, 1);
  assert.equal(f.has(replacementId), true, 'the old event cannot hide the new copy\'s uncertainty');
  assert.equal(original.state, 'unknown');
  assert.equal(f.counts().sends, 2, 'the second send requires explicit replacement');
});

test('TLC late-known-check: +31s evidence is reported without inventing confirmation', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.advance(31);
  const own = f.event('late-own-event', original.localId, 31);
  f.receive(own);
  assert.equal(f.history()[0].eventId, own.eventId);
  assert.equal(f.has(original.localId), true);
  f.checkItems([own]);
  await f.check(original);
  await f.check(original);
  assert.equal(original.state, 'unknown');
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  assert.match(original.textCheckReason, /找到相同内容.*无法确认/);
  assert.deepEqual(f.counts(), { sends: 1, checks: 2 });
});

test('TLC existing-known-check: date-page history is revisited by a manual read', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  const own = f.event('already-in-date-page', original.localId, 1);
  // loadHistory(date/older/newer) inserts these records without reconciliation.
  // Seed that boundary; the matching and manual check below are REAL functions.
  f.loadDatePage(own);
  f.checkItems([own]);
  await f.check(original);
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  assert.match(original.textCheckReason, /找到相同内容.*无法确认/);
  assert.deepEqual(f.counts(), { sends: 1, checks: 1 });
});

test('local history evidence survives an empty recent Steam query', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.loadDatePage(f.event('outside-remote-recent-tail', original.localId, 31));
  f.checkItems([]);
  await f.check(original);
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  assert.match(original.textCheckReason, /找到相同内容.*无法确认/);
  assert.deepEqual(f.counts(), { sends: 1, checks: 1 });
});

test('control: a delayed observation with an on-time timestamp is also candidate evidence', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.advance(60);
  f.receive(f.event('delayed-observation', original.localId, 1));
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  assert.equal(f.counts().sends, 1);
});

test('control: echo before uncertain response does not erase uncertainty or retransmit', async () => {
  const f = fixture();
  const original = f.begin();
  const task = f.submit(original);
  const own = f.event('own-before-http', original.localId, 0);
  f.receive(own);
  assert.equal(original.textCandidateFound, true);
  assert.equal(f.has(original.localId), true, 'keep the in-flight attempt until its own response');
  await f.unknown(task, 0);
  assert.equal(f.has(original.localId), true);
  assert.equal(original.state, 'unknown');
  assert.equal(f.counts().sends, 1);
});

test('control: empty history neither proves failure nor initiates a resend', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.checkItems([]);
  await f.check(original);
  assert.equal(original.state, 'unknown');
  assert.equal(f.has(original.localId), true);
  assert.deepEqual(f.counts(), { sends: 1, checks: 1 });
});

test('control: manual check reports a previously unseen candidate within the window', async () => {
  const f = fixture();
  const original = f.begin();
  await f.unknown(f.submit(original), 0);
  f.checkItems([f.event('new-manual-result', original.localId, 1)]);
  await f.check(original);
  assert.equal(f.has(original.localId), true);
  assert.equal(original.textCandidateFound, true);
  assert.match(original.textCheckReason, /找到相同内容.*无法确认/);
  assert.deepEqual(f.counts(), { sends: 1, checks: 1 });
});

test('control: a repeated event can inform two identical attempts without consuming either', async () => {
  const f = fixture();
  const first = f.begin();
  await f.unknown(f.submit(first), 0);
  const second = f.begin();
  await f.unknown(f.submit(second), 1);
  const own = f.event('first-of-two', first.localId, 0);
  f.receive(own);
  f.receive(own);
  assert.equal(f.has(first.localId), true);
  assert.equal(f.has(second.localId), true);
  assert.equal(first.textCandidateFound, true);
  assert.equal(second.textCandidateFound, true);
  assert.equal(f.counts().sends, 2);
});

test('control: direct HTTP success resolves its own request even beyond the heuristic window', async () => {
  const f = fixture();
  const original = f.begin();
  const task = f.submit(original);
  f.advance(31);
  const own = f.event('request-correlated', original.localId, 31);
  f.requests[0].resolve({ ok: true, item: own });
  assert.equal(await task, true);
  assert.equal(f.has(original.localId), false);
  assert.equal(original.state, 'sent');
  assert.equal(f.counts().sends, 1);
});

test('TLC guard-manual-retry-duplicate: post-submit 409 preserves unknown and blocks ordinary retry', async t => {
  // Load the real service and its TS dependencies, without a stale dist build.
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        esModuleInterop: true }
    }).outputText;
    module._compile(output, filename);
  };
  let createChatService;
  try { ({ createChatService } = require('../../src/server/chat-service.ts')); }
  finally {
    if (previous) require.extensions['.ts'] = previous;
    else delete require.extensions['.ts'];
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'text-send-guard-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let accepted = 0;
  const user = Object.assign(new EventEmitter(), { steamID: account, chat: {
    sendFriendMessage(id, message, callback) {
      assert.equal(id, peer);
      assert.equal(message, 'same text');
      accepted++; // independent fake Steam acceptance count
      if (accepted === 1) {
        // SDK identity changes, while selected account and browser stay fixed.
        user.steamID = '76561198000000003';
        callback(new Error('Request timed out'));
      } else callback(null, { modified_message: message, ordinal: accepted, server_timestamp: new Date() });
    },
    getFriendMessageHistory(_id, _options, callback) { callback(null, { messages: [] }); }
  } });
  const service = createChatService({ steamUser: user,
    logger: { info() {}, warn() {}, error() {} },
    config: { host: '127.0.0.1', port: 0, wsHeartbeatMs: 0 },
    imageEmoteDir: path.join(directory, 'images'), inventoryCacheDir: path.join(directory, 'inventory'),
    getSelfName: async () => 'Self',
    steamLoginService: { getStatus: () => ({ status: 'online', steamId: account }), ensureOnline() {} },
    historyStorage: { canSend: () => true,
      append(record) { return { ...record, eventId: `accepted-${accepted}` }; },
      onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {} }
  });
  t.after(() => service.stop());
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const f = fixture();
  const responses = [];
  f.useServer(`http://127.0.0.1:${service.server.address().port}`, responses);
  const original = f.begin();
  assert.equal(await f.submit(original), false);
  assert.equal(accepted, 1);
  assert.equal(responses[0].status, 409);
  assert.equal(responses[0].payload.uncertain, true);
  assert.equal(original.state, 'unknown', 'real HTTP + real api + real classifier preserve submission uncertainty');
  assert.equal(f.has(original.localId), true);
  user.steamID = account; // transient mismatch recovers without browser reset
  assert.equal(await f.retry(original), false, 'ordinary retry stays blocked after identity recovery');
  assert.equal(accepted, 1, 'the accepted message must never enter ordinary retry');
  assert.equal(original.previousLocalId, undefined);
  assert.equal(original.replacementLocalId, undefined);
  assert.deepEqual(responses.map(response => response.status), [409]);
});

for (const status of [400, 403, 409, 429, 503]) {
  test(`control: unmarked HTTP ${status} is not proof of non-delivery`, async () => {
    const f = fixture();
    const original = f.begin();
    const task = f.submit(original);
    f.requests[0].reject(Object.assign(new Error(`HTTP ${status}`), { status }));
    assert.equal(await task, false);
    assert.equal(original.state, 'unknown');
    assert.equal(await f.retry(original), false);
    assert.equal(f.counts().sends, 1);
  });
}

test('control: explicit non-delivery still allows a single manual retry', async () => {
  const f = fixture();
  const original = f.begin();
  const task = f.submit(original);
  f.requests[0].reject(Object.assign(new Error('Explicit rejection'), { status: 429, uncertain: false }));
  assert.equal(await task, false);
  assert.equal(original.state, 'failed');
  const retry = f.retry(original);
  assert.equal(f.counts().sends, 2);
  assert.equal(await f.retry(original), false, 'double click cannot send another attempt');
  await f.unknown(retry, 1);
  assert.equal(original.state, 'unknown');
});
