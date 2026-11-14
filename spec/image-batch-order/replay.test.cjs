// Replay the order counterexamples against the current ordered-batch protocol.
// The legacy ungrouped manager control remains intentionally unordered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

test('reverse file completion activates the pre-reserved input positions without creating new sends', async () => {
  const source = fs.readFileSync(path.join(root, 'web/app.ts'), 'utf8');
  const ast = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['sendFiles', 'sendImageBatch', 'readImageFile']);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(nodes.length, names.size, 'read the real batch dispatch functions');
  const code = ts.transpileModule(nodes.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const readers = [];
  class Reader {
    constructor() { readers.push(this); }
    readAsDataURL(file) { this.file = file; }
    finish() { this.result = `data:image/png;base64,${this.file.name}`; this.onload(); }
  }
  const dispatched = [];
  const outgoing = new Map();
  const epoch = 'e'.repeat(32), batchId = 'b'.repeat(32), account = '76561198000000001';
  let request, reserve;
  let localId = 0;
  const context = {
    FileReader: Reader, canSendImages: () => true, chatContext: () => 'fixed-account',
    state: { activeId: 'fixed-peer', steam: { steamId: account }, sendOperations: true, imageBatchEpoch: epoch },
    pendingImageReaders: new Set(), outgoingMessages: outgoing,
    createImageTransfer: name => ({ name }), updateImageTransfer() {}, setFeedback() {},
    beginOutgoing(id) { const entry = { localId: ++localId, context: 'fixed-account', item: { id } }; outgoing.set(entry.localId, entry); return entry; },
    isRecord: value => value !== null && typeof value === 'object',
    jsonBody: body => ({ body }),
    api(url, options) {
      assert.equal(url, '/api/send-operations/batch');
      request = options.body;
      return new Promise(resolve => { reserve = resolve; });
    },
    applyImageOperation: (entry, operation) => { entry.operation = operation; },
    saveImageOperationMetadata() {}, startImageOperationPolling() {},
    imageOperationKey: () => 'original-account-metadata',
    refreshOutgoing() {}, errorMessage: error => error.message,
    finishOutgoing: (_entry, _state, _response, error) => assert.fail(error),
    activateImageOperation(entry) { dispatched.push(entry.operation.batchIndex); },
    imageOperationAction() {},
    sendImage: () => assert.fail('a batch member must never create a separate send')
  };
  vm.runInNewContext(`${code}\nthis.dispatch = sendFiles;`, context);
  const preparing = context.dispatch([{ name: '1.png', size: 100, type: 'image/png' },
    { name: '2.png', size: 10, type: 'image/png' }]);
  assert.equal(readers.length, 0, 'no image activation before whole-batch registration');
  assert.deepEqual(Array.from(request.names), ['1.png', '2.png']);
  assert.equal(request.instanceId, epoch);
  reserve({ batchId, operations: [0, 1].map(index => ({ id: String(index + 1).repeat(32), peerId: 'fixed-peer',
    steamAccountId: account, batchId, batchIndex: index, batchSize: 2, state: 'prepared', version: 1 })) });
  assert.equal(await preparing, true);
  assert.deepEqual(readers.map(reader => reader.file.name), ['1.png', '2.png']);
  readers[1].finish(); readers[0].finish();
  assert.deepEqual(dispatched, [1, 0], 'completion may be reversed, but each upload keeps its original reserved index');
  assert.deepEqual([...outgoing.values()].map(entry => entry.operation.batchIndex), [0, 1]);
});

function loadManager() {
  const filename = path.join(root, 'src/server/send-operations.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const local = { exports: {} };
  vm.runInNewContext(code, { module: local, exports: local.exports,
    require: name => name === '../types'
      ? { isRecord: value => value !== null && typeof value === 'object', errorMessage: error => error.message }
      : require(name), Buffer, AbortController, setInterval, clearInterval, Date, console }, { filename });
  return local.exports.SendOperations;
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(5); }
  assert.fail('manager did not reach the expected boundary');
}

test('legacy ungrouped SendOperations still allows unrelated image tasks to run concurrently', async t => {
  const SendOperations = loadManager();
  const owner = { userId: 1, sessionId: 'original-session', account: '76561198000000001' };
  const peer = '76561198000000002';
  const callbacks = new Map();
  const started = [];
  const accepted = []; // independent fake-Steam observation, not manager state
  const manager = new SendOperations({ tickMs: 2, windowMs: 10000,
    refreshWebSession: async () => {}, send: input => {
      const image = Number(input.buffer.toString());
      started.push(image); input.phase('commit');
      return new Promise(resolve => callbacks.set(image, () => {
        accepted.push(image);
        resolve({ id: peer, eventId: `steam-${image}`, steamAccountId: owner.account,
          echo: true, type: 'image', message: `https://images.test/${image}.png`, date: '2026-11-13' });
      }));
    } });
  t.after(async () => { for (const done of callbacks.values()) done(); await manager.close(); });
  const first = manager.prepare(owner, peer, '1.png', () => true);
  manager.start(first.id, owner, Buffer.from('1'));
  const second = manager.prepare(owner, peer, '2.png', () => true);
  manager.start(second.id, owner, Buffer.from('2'));
  await until(() => started.length === 2);
  assert.deepEqual(started, [1, 2], 'start order alone is correct');
  callbacks.get(2)(); callbacks.delete(2);
  await until(() => manager.get(second.id, owner).state === 'sent');
  assert.equal(manager.get(first.id, owner).state, 'sending');
  callbacks.get(1)(); callbacks.delete(1);
  await until(() => manager.get(first.id, owner).state === 'sent');
  assert.deepEqual(accepted, [2, 1], 'two concurrent commits can be accepted out of input order');
});

test('ordered batch prevents the old concurrent-commit counterexample even with reverse activation', async t => {
  const SendOperations = loadManager();
  const owner = { userId: 1, sessionId: 'session', account: '76561198000000001' };
  const peer = '76561198000000002';
  const started = [], accepted = [], callbacks = new Map();
  const manager = new SendOperations({ tickMs: 2, windowMs: 10000,
    refreshWebSession: async () => {}, send: input => {
      const image = Number(input.buffer.toString());
      started.push(image); input.phase('commit');
      return new Promise(resolve => callbacks.set(image, () => {
        accepted.push(image);
        resolve({ id: peer, eventId: `ordered-${image}`, steamAccountId: owner.account,
          echo: true, type: 'image', message: `https://images.test/${image}.png`, date: '2026-11-13' });
      }));
    } });
  t.after(async () => { for (const done of callbacks.values()) done(); await manager.close(); });
  const batch = manager.prepareBatch(owner, peer, ['1.png', '2.png'], () => true, manager.instanceId);
  const [one, two] = batch.operations;
  manager.start(two.id, owner, Buffer.from('2'));
  await delay(15);
  assert.deepEqual(started, [], 'the later ready member cannot start before its unuploaded predecessor');
  manager.start(one.id, owner, Buffer.from('1'));
  await until(() => started.length === 1);
  assert.deepEqual(started, [1]);
  assert.equal(callbacks.has(2), false, 'there is no second commit to accept first');
  callbacks.get(1)(); callbacks.delete(1);
  await until(() => started.length === 2);
  assert.deepEqual(started, [1, 2]);
  callbacks.get(2)(); callbacks.delete(2);
  await until(() => manager.get(two.id, owner).state === 'sent');
  assert.deepEqual(accepted, [1, 2]);
});

test('unknown predecessor cannot be released by stop-waiting, retry, or an old instance registration', async t => {
  const SendOperations = loadManager();
  const owner = { userId: 1, sessionId: 'session', account: '76561198000000001' };
  const peer = '76561198000000002', calls = [];
  const manager = new SendOperations({ tickMs: 2, windowMs: 10000,
    refreshWebSession: async () => {}, send: async input => {
      calls.push(input.buffer.toString()); input.phase('commit');
      throw Object.assign(new Error('Lost acknowledgement'), { uncertain: true });
    } });
  t.after(() => manager.close());
  const batch = manager.prepareBatch(owner, peer, ['1.png', '2.png'], () => true, manager.instanceId);
  const [one, two] = batch.operations;
  manager.start(two.id, owner, Buffer.from('2')); manager.start(one.id, owner, Buffer.from('1'));
  await until(() => manager.get(one.id, owner).state === 'unknown');
  assert.equal(manager.cancel(one.id, owner).state, 'unknown');
  assert.throws(() => manager.retry(one.id, owner, manager.get(one.id, owner).version));
  await delay(20);
  assert.deepEqual(calls, ['1']);
  assert.equal(manager.get(two.id, owner).waitingForOperationId, one.id);
  const fresh = new SendOperations({ tickMs: 2, refreshWebSession: async () => {}, send: async () => assert.fail('cannot replay old batch') });
  t.after(() => fresh.close());
  assert.throws(() => fresh.prepareBatch(owner, peer, ['1.png', '2.png'], () => true, manager.instanceId), error => error.statusCode === 409);
  assert.throws(() => fresh.start(one.id, owner, Buffer.from('1')), error => error.statusCode === 410);
});
