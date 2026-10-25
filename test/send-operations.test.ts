import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SendOperations, SendOperationOptions } from '../src/server/send-operations';
import type { HistoryItem } from '../src/types';
const owner = { userId: 1, sessionId: 'session-one', account: '76561198000000001' };
const peer = '76561198000000002';
const image = Buffer.from('original image');
const sent: HistoryItem = { eventId: 'confirmed', id: peer, steamAccountId: owner.account, type: 'image', echo: true,
  message: 'https://images.example.test/image.png', date: '2026-01-01', name: 'Sender', ordinal: 0 };
async function until(check: () => boolean) {
  for (let n = 0; n < 600; n++) { if (check()) return; await delay(5); }
  assert.fail('Timed out waiting for operation');
}
const transient = (extra = {}) => Object.assign(new Error('Temporary failure'), { uncertain: false, retryable: true, imageUploadPhase: 'begin', ...extra });
const config = { tickMs: 2, windowMs: 1000, delaysMs: [2, 3, 4, 5, 6], random: () => 0.5 };

test('prepared ID, immutable payload, duplicate starts and retry recovery produce one confirmed result', async t => {
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: async input => {
    input.phase('begin'); assert.equal(input.buffer.toString(), image.toString());
    if (++calls < 3) throw transient(); return sent;
  } }); t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'photo.png', () => true);
  assert.equal(calls, 0); const payload = Buffer.from(image);
  manager.start(op.id, owner, payload); payload.fill(0);
  assert.equal(manager.start(op.id, owner, image).id, op.id);
  assert.throws(() => manager.start(op.id, owner, Buffer.from('different')), (e: any) => e.statusCode === 409);
  await until(() => manager.get(op.id, owner).state === 'sent');
  assert.equal(calls, 3); assert.equal(manager.get(op.id, owner).item?.eventId, sent.eventId);
  assert.equal(manager.start(op.id, owner, image).state, 'sent'); assert.equal(calls, 3);
  assert.throws(() => manager.get(op.id, { ...owner, sessionId: 'another' }), (e: any) => e.statusCode === 403);
});

test('one budget includes login refresh and retries; double-click manual retry starts one new round', async t => {
  let calls = 0, refreshes = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => { refreshes++; }, send: async input => {
    input.phase('begin'); calls++;
    if (calls === 1) throw transient({ eresult: 21, retryable: false });
    if (calls <= 6) throw transient(); return sent;
  } }); t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
  await until(() => manager.get(op.id, owner).state === 'failed');
  let view = manager.get(op.id, owner);
  assert.equal(calls, 6); assert.equal(view.attempts, 6); assert.equal(refreshes, 1); assert.equal(view.retryable, true);
  manager.retry(op.id, owner, view.version); manager.retry(op.id, owner, view.version);
  await until(() => manager.get(op.id, owner).state === 'sent'); view = manager.get(op.id, owner);
  assert.equal(calls, 7); assert.equal(view.attempts, 1); assert.equal(view.totalAttempts, 7);
});

test('commit uncertainty is never retried or converted to unsent by cancel', async t => {
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => assert.fail('Cannot refresh unknown submission'), send: async input => {
    calls++; input.phase('commit'); throw transient({ uncertain: true, eresult: 21 });
  } }); t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
  await until(() => manager.get(op.id, owner).state === 'unknown');
  const view = manager.get(op.id, owner);
  assert.throws(() => manager.retry(op.id, owner, view.version));
  assert.equal(manager.cancel(op.id, owner).state, 'unknown'); await delay(30); assert.equal(calls, 1);
});

test('stopping commit only stops waiting; a later confirmed response still becomes sent', async t => {
  let finish!: (item: HistoryItem) => void;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: input => {
    input.phase('commit'); return new Promise(resolve => { finish = resolve; });
  } }); t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
  await until(() => Boolean(finish)); assert.equal(manager.cancel(op.id, owner).state, 'unknown');
  finish(sent); await until(() => manager.get(op.id, owner).state === 'sent');
});

test('cancel before commit aborts future work and cannot be revived by start', async t => {
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: input => {
    calls++; input.phase('upload'); return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(transient()), { once: true }));
  } }); t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
  await until(() => calls === 1); assert.equal(manager.cancel(op.id, owner).state, 'cancelled');
  assert.equal(manager.start(op.id, owner, image).state, 'cancelled'); await delay(20); assert.equal(calls, 1);
});

test('offline wait uses no attempts, permission loss and elapsed window stop future work', async t => {
  let online = false, allowed = true, calls = 0;
  const manager = new SendOperations({ ...config, windowMs: 60, refreshWebSession: async () => {}, send: async () => { calls++; return sent; } });
  t.after(() => manager.close());
  const authorize = () => { if (!allowed) throw new Error('Permission revoked'); return online; };
  const one = manager.prepare(owner, peer, 'One', authorize); manager.start(one.id, owner, image);
  await until(() => manager.get(one.id, owner).state === 'waiting_connection');
  assert.equal(manager.get(one.id, owner).attempts, 0); online = true;
  await until(() => manager.get(one.id, owner).state === 'sent'); assert.equal(calls, 1);
  online = false; const two = manager.prepare(owner, peer, 'Two', authorize); manager.start(two.id, owner, image);
  await until(() => manager.get(two.id, owner).state === 'waiting_connection'); allowed = false;
  await until(() => manager.get(two.id, owner).state === 'failed');
  assert.equal(manager.get(two.id, owner).retryable, false); assert.equal(calls, 1);
  allowed = true; const three = manager.prepare(owner, peer, 'Three', authorize); manager.start(three.id, owner, image);
  await until(() => manager.get(three.id, owner).state === 'failed'); online = true; await delay(20); assert.equal(calls, 1);
});

test('per-account concurrency is two and a pending retry does not occupy a slot', async t => {
  const completions: Array<(item: HistoryItem) => void> = [];
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: input => {
    calls++; input.phase('upload'); return new Promise(resolve => completions.push(resolve));
  } }); t.after(() => manager.close());
  const ids = Array.from({ length: 3 }, () => { const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image); return op.id; });
  await until(() => calls === 2); assert.equal(manager.get(ids[2], owner).state, 'queued');
  completions[0](sent); await until(() => calls === 3); completions[1](sent); completions[2](sent);
  await until(() => ids.every(id => manager.get(id, owner).state === 'sent'));
});

test('account rate-limit cooldown is shared and cannot be bypassed by expedite', async t => {
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: async input => {
    calls++; input.phase('begin'); throw transient({ eresult: 84 });
  } }); t.after(() => manager.close());
  const one = manager.prepare(owner, peer, 'One', () => true); manager.start(one.id, owner, image);
  await until(() => manager.get(one.id, owner).state === 'retry_wait');
  const view = manager.get(one.id, owner); assert.ok(view.cooldownUntil > Date.now() + 29000);
  assert.throws(() => manager.expedite(one.id, owner, view.version), (e: any) => e.statusCode === 429);
  const two = manager.prepare(owner, peer, 'Two', () => true); manager.start(two.id, owner, image);
  await until(() => manager.get(two.id, owner).state === 'retry_wait'); assert.equal(calls, 1);
});

test('payload budgets, expiration and restart never turn a missing ID into a new send', async () => {
  let calls = 0;
  const options: SendOperationOptions = { ...config, maxBytes: 20, userBytes: 20, imageMs: 15, resultMs: 15, preparedMs: 15,
    refreshWebSession: async () => {}, send: async () => { calls++; throw transient({ retryable: false }); } };
  const manager = new SendOperations(options);
  try {
    const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
    const second = manager.prepare(owner, peer, 'Image', () => true);
    assert.throws(() => manager.start(second.id, owner, image), (e: any) => e.statusCode === 429);
    await until(() => manager.get(op.id, owner).state === 'failed'); assert.equal(calls, 1);
    await delay(30); assert.throws(() => manager.get(second.id, owner), (e: any) => e.statusCode === 410);
    await manager.close();
    const fresh = new SendOperations(options);
    try { assert.throws(() => fresh.start(op.id, owner, image), (e: any) => e.statusCode === 410); assert.equal(calls, 1); }
    finally { await fresh.close(); }
  } finally { await manager.close(); }
});

test('cancelling during an unresponsive login refresh releases the worker', async t => {
  let refreshStarted = false;
  const manager = new SendOperations({ ...config, refreshWebSession: () => { refreshStarted = true; return new Promise(() => {}); },
    send: async input => { input.phase('begin'); throw transient({ eresult: 21 }); } });
  t.after(() => manager.close());
  const op = manager.prepare(owner, peer, 'Image', () => true); manager.start(op.id, owner, image);
  await until(() => refreshStarted); manager.cancel(op.id, owner);
  await manager.close(); assert.ok(true);
});

test('explicit replacements link the unknown parent and duplicate creation returns the same new task', async t => {
  let calls = 0;
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: async input => {
    calls++; input.phase('commit'); throw transient({ uncertain: true });
  } }); t.after(() => manager.close());
  const parent = manager.prepare(owner, peer, 'Image', () => true); manager.start(parent.id, owner, image);
  await until(() => manager.get(parent.id, owner).state === 'unknown');
  const one = manager.prepare(owner, peer, 'Copy', () => true, parent.id);
  const two = manager.prepare(owner, peer, 'Copy', () => true, parent.id);
  assert.equal(one.id, two.id); assert.equal(one.previousOperationId, parent.id);
  assert.equal(manager.get(parent.id, owner).replacementId, one.id);
  manager.start(one.id, owner, image); manager.start(two.id, owner, image);
  await until(() => manager.get(one.id, owner).state === 'unknown'); assert.equal(calls, 2);
});

test('cancelled transport retains its byte reservation until the real callback drains', async t => {
  let drain: () => void = () => {};
  let calls = 0;
  const manager = new SendOperations({ ...config, maxBytes: 20, refreshWebSession: async () => {}, send: input => {
    if (++calls > 1) return Promise.resolve(sent);
    input.phase('upload');
    input.transport(new Promise<void>(resolve => { drain = resolve; }));
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(transient()), { once: true }));
  } }); t.after(async () => { drain(); await manager.close(); });
  const one = manager.prepare(owner, peer, 'One', () => true); manager.start(one.id, owner, image);
  await until(() => calls === 1); manager.cancel(one.id, owner);
  const two = manager.prepare(owner, peer, 'Two', () => true);
  assert.throws(() => manager.start(two.id, owner, image), (e: any) => e.statusCode === 429);
  assert.throws(() => manager.image(one.id, owner), (e: any) => e.statusCode === 410);
  drain(); await delay(10); manager.start(two.id, owner, image);
  await until(() => manager.get(two.id, owner).state === 'sent'); assert.equal(calls, 2);
});

test('client IDs are validated and bound to owner, peer, name and previous operation without replacing authorization', async t => {
  let online = false, calls = 0;
  const manager = new SendOperations({ ...config, maxTasks: 1, refreshWebSession: async () => {},
    send: async () => { calls++; return sent; } });
  t.after(() => manager.close());
  const id = 'a'.repeat(32);
  for (const invalid of ['', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), null, 12]) {
    assert.throws(() => manager.prepare(owner, peer, 'Image', () => true, undefined, invalid as string), (e: any) => e.statusCode === 400);
  }
  assert.throws(() => manager.prepare(owner, peer, 'Image', () => true, '', id), (e: any) => e.statusCode === 400);
  const first = manager.prepare(owner, peer, 'Image', () => online, undefined, id);
  assert.equal(first.id, id);
  assert.deepEqual(manager.prepare(owner, peer, 'Image', () => true, undefined, id), first, 'replay does not consume another task slot');
  for (const other of [{ ...owner, userId: 2 }, { ...owner, sessionId: 'other' }, { ...owner, account: '76561198000000003' }]) {
    assert.throws(() => manager.prepare(other, peer, 'Image', () => true, undefined, id), (e: any) => e.statusCode === 403);
  }
  assert.throws(() => manager.prepare(owner, owner.account, 'Image', () => true, undefined, id), (e: any) => e.statusCode === 409);
  assert.throws(() => manager.prepare(owner, peer, 'Changed', () => true, undefined, id), (e: any) => e.statusCode === 409);
  assert.throws(() => manager.prepare(owner, peer, 'Image', () => true, 'b'.repeat(32), id), (e: any) => e.statusCode === 409);
  assert.throws(() => manager.prepare(owner, peer, 'Image', () => true, undefined, 'b'.repeat(32)), (e: any) => e.statusCode === 429);
  manager.start(id, owner, image);
  await until(() => manager.get(id, owner).state === 'waiting_connection');
  assert.equal(calls, 0, 'duplicate prepare cannot substitute its authorize callback');
  online = true;
  await until(() => manager.get(id, owner).state === 'sent');
  assert.equal(manager.prepare(owner, peer, 'Image', () => true, undefined, id).state, 'sent');
  assert.equal(manager.start(id, owner, image).state, 'sent');
  assert.equal(calls, 1);
});

test('client replacement IDs cannot alias another task or silently reuse a different replacement', async t => {
  const manager = new SendOperations({ ...config, refreshWebSession: async () => {}, send: async input => {
    input.phase('commit'); throw transient({ uncertain: true });
  } });
  t.after(() => manager.close());
  const parent = manager.prepare(owner, peer, 'Parent', () => true);
  const unrelated = manager.prepare(owner, peer, 'Copy', () => true, undefined, 'a'.repeat(32));
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'b'.repeat(32)), (e: any) => e.statusCode === 409);
  manager.start(parent.id, owner, image);
  await until(() => manager.get(parent.id, owner).state === 'unknown');
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id, unrelated.id), (e: any) => e.statusCode === 409);
  assert.equal(manager.get(parent.id, owner).replacementId, undefined);
  assert.throws(() => manager.prepare(owner, owner.account, 'Copy', () => true, parent.id, 'b'.repeat(32)), (e: any) => e.statusCode === 409);
  assert.throws(() => manager.prepare({ ...owner, sessionId: 'other' }, peer, 'Copy', () => true, parent.id, 'b'.repeat(32)), (e: any) => e.statusCode === 403);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, 'f'.repeat(32), 'b'.repeat(32)), (e: any) => e.statusCode === 410);
  const replacement = manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'b'.repeat(32));
  assert.equal(manager.prepare(owner, peer, 'Copy', () => true, parent.id, replacement.id).id, replacement.id);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'c'.repeat(32)), (e: any) => e.statusCode === 409);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, undefined, replacement.id), (e: any) => e.statusCode === 409);
  assert.equal(manager.get(parent.id, owner).replacementId, replacement.id);
  assert.equal(manager.prepare(owner, peer, 'Copy', () => true, parent.id).id, replacement.id, 'legacy two-stage replacement remains compatible');
});

test('replacement replay survives a late parent acknowledgement and parent result expiration', async t => {
  let finish!: (item: HistoryItem) => void;
  const manager = new SendOperations({ ...config, resultMs: 15, refreshWebSession: async () => {}, send: input => {
    input.phase('commit'); return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => manager.close());
  const parent = manager.prepare(owner, peer, 'Parent', () => true);
  manager.start(parent.id, owner, image);
  await until(() => Boolean(finish));
  assert.equal(manager.cancel(parent.id, owner).state, 'unknown');
  const replacement = manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'a'.repeat(32));
  finish(sent);
  await until(() => manager.get(parent.id, owner).state === 'sent');
  assert.equal(manager.prepare(owner, peer, 'Copy', () => true, parent.id, replacement.id).id, replacement.id);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'b'.repeat(32)), (e: any) => e.statusCode === 409);
  await delay(30);
  assert.throws(() => manager.get(parent.id, owner), (e: any) => e.statusCode === 410);
  assert.equal(manager.prepare(owner, peer, 'Copy', () => true, parent.id, replacement.id).id, replacement.id);
});

test('a late image loader cannot start a reused client ID after its original operation expires', async t => {
  let finish!: (buffer: Buffer) => void, calls = 0;
  const manager = new SendOperations({ ...config, preparedMs: 20, refreshWebSession: async () => {},
    send: async () => { calls++; return sent; } });
  t.after(() => manager.close());
  const id = 'a'.repeat(32);
  manager.prepare(owner, peer, 'Original', () => true, undefined, id);
  const pending = manager.loadAndStart(id, owner, () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(pending, (e: any) => e.statusCode === 410);
  await delay(30);
  assert.throws(() => manager.get(id, owner), (e: any) => e.statusCode === 410);
  manager.prepare(owner, owner.account, 'New', () => true, undefined, id);
  finish(image); await rejected;
  const view = manager.get(id, owner);
  assert.equal(view.state, 'prepared');
  assert.equal(view.peerId, owner.account);
  assert.equal(view.hasImage, false);
  assert.equal(calls, 0);
});

test('legacy replacement lookup cannot follow an expired child ID into an unrelated task', async t => {
  const manager = new SendOperations({ ...config, preparedMs: 20, refreshWebSession: async () => {}, send: async input => {
    input.phase('commit'); throw transient({ uncertain: true });
  } });
  t.after(() => manager.close());
  const parent = manager.prepare(owner, peer, 'Parent', () => true);
  manager.start(parent.id, owner, image);
  await until(() => manager.get(parent.id, owner).state === 'unknown');
  const child = manager.prepare(owner, peer, 'Copy', () => true, parent.id, 'a'.repeat(32));
  await delay(30);
  assert.throws(() => manager.get(child.id, owner), (e: any) => e.statusCode === 410);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id, child.id), (e: any) => e.statusCode === 410,
    'expired replacement is not automatically recreated');
  manager.prepare(owner, owner.account, 'Unrelated', () => true, undefined, child.id);
  assert.throws(() => manager.prepare(owner, peer, 'Copy', () => true, parent.id), (e: any) => e.statusCode === 409);
  assert.equal(manager.get(child.id, owner).state, 'prepared');
});
