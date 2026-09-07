import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { maintainHistory, MAX_LINE_BYTES, parseArguments } from '../src/storage/history-maintenance';
import type { MaintenanceOptions } from '../src/storage/history-maintenance';

const legacy = { date: '2024-01-02 08:30:00.123', id: '76561198000000002', name: 'Peer', echo: false, message: 'hello 世界' };
const sourceId = '0123456789abcdef0123456789abcdef';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'history-maintenance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options: MaintenanceOptions = { command: 'import', db: join(root, 'db'), file: join(root, 'source.jsonl'),
    account: '76561198000000001', timezone: '+08:00', sourceId };
  await writeFile(options.file, `${JSON.stringify(legacy)}\n`);
  return { root, options };
}
async function records(db: string, output: string) {
  await maintainHistory({ command: 'export', db, output });
  return (await readFile(output, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('repeat legacy import is idempotent and export restores exact events', async t => {
  const { root, options } = await fixture(t);
  assert.equal((await maintainHistory(options)).inserted, 1);
  assert.equal((await maintainHistory(options)).inserted, 0);
  const output = join(root, 'export.jsonl');
  const messages = await records(options.db, output);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sentAt, '2024-01-02T00:30:00.123Z');
  assert.equal(messages[0].ordinal, 0);
  assert.match(messages[0].eventId, /^[a-f0-9]{32}$/);
  const restore: MaintenanceOptions = { ...options, db: join(root, 'restored'), file: output, sourceId: undefined, timezone: 'UTC' };
  await maintainHistory(restore);
  assert.deepEqual(await records(restore.db, join(root, 'restored.jsonl')), messages);
});

test('conflicting source IDs and target content fail before any repair', async t => {
  const { root, options } = await fixture(t);
  await maintainHistory(options);
  const [original] = await records(options.db, join(root, 'original.jsonl'));
  const extra = { ...original, eventId: 'f'.repeat(32), message: 'new' };
  const conflict = { ...original, message: 'changed' };
  await writeFile(options.file, [extra, conflict].map(x => JSON.stringify(x)).join('\n') + '\n');
  await assert.rejects(maintainHistory({ ...options, command: 'reconcile', output: join(root, 'recovery.jsonl') }), /conflict/i);
  assert.deepEqual(await records(options.db, join(root, 'after.jsonl')), [original]);
  await writeFile(options.file, [extra, { ...extra, message: 'different' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  await assert.rejects(maintainHistory(options), /conflict/i);
  assert.deepEqual(await records(options.db, join(root, 'after-duplicate.jsonl')), [original]);
});

test('malformed, partial, invalid dates and oversized lines report positions without losing source', async t => {
  const { root, options } = await fixture(t);
  const valid = JSON.stringify(legacy) + '\n';
  const cases = ['{broken}\n', JSON.stringify(legacy), JSON.stringify({ ...legacy, date: '2024-02-30 00:00:00' }) + '\n', 'x'.repeat(MAX_LINE_BYTES + 1)];
  for (const [i, bad] of cases.entries()) {
    const input = valid + bad;
    await writeFile(options.file, input);
    await assert.rejects(maintainHistory(options), new RegExp(`Line 2, byte ${Buffer.byteLength(valid)}`));
    assert.equal(await readFile(options.file, 'utf8'), input);
    assert.deepEqual(await records(options.db, join(root, `empty-${i}.jsonl`)), []);
  }
});

test('reconcile repairs source-only events and emits only database-only events', async t => {
  const { root, options } = await fixture(t);
  await maintainHistory(options);
  const [original] = await records(options.db, join(root, 'original.jsonl'));
  const extra = { ...original, eventId: 'e'.repeat(32), message: 'source only' };
  await writeFile(options.file, JSON.stringify(extra) + '\n');
  const output = join(root, 'recovery.jsonl');
  const result = await maintainHistory({ ...options, command: 'reconcile', output });
  assert.equal(result.inserted, 1);
  assert.equal(result.exported, 1);
  assert.deepEqual(JSON.parse((await readFile(output, 'utf8')).trim()), original);
  assert.equal((await records(options.db, join(root, 'all.jsonl'))).length, 2);
  const again = await maintainHistory({ ...options, command: 'reconcile', output: join(root, 'again.jsonl') });
  assert.equal(again.inserted, 0);
  assert.equal(again.exported, 1);
});

test('export and reconcile never overwrite outputs or repair when output already exists', async t => {
  const { root, options } = await fixture(t);
  const output = join(root, 'existing.jsonl');
  await writeFile(output, 'keep me');
  for (const command of ['export', 'reconcile'] as const) {
    await assert.rejects(maintainHistory({ ...options, command, output }), /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'keep me');
  }
  assert.deepEqual(await records(options.db, join(root, 'empty.jsonl')), []);
});

test('CLI fails on an offline database lock without publishing output', async t => {
  const { root, options } = await fixture(t);
  const { RocksHistoryStore } = require('../src/storage/rocks-history');
  const owned = new RocksHistoryStore(options.db);
  await owned.ready();
  try {
    const output = join(root, 'locked.jsonl');
    const child = spawnSync(process.execPath, [join(__dirname, '../src/storage/history-maintenance.js'),
      'export', '--db', options.db, '--output', output], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /lock/i);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('legacy identity and explicit timezone are mandatory; arguments reject duplicates', async t => {
  const { options } = await fixture(t);
  await assert.rejects(maintainHistory({ ...options, sourceId: undefined }), /source-id/);
  await assert.rejects(maintainHistory({ ...options, timezone: 'Asia/Shanghai' }), /Timezone/);
  await assert.rejects(maintainHistory({ ...options, timezone: undefined }), /timezone/);
  assert.throws(() => parseArguments(['export', '--db', 'a', '--db', 'b']), /duplicate/);
});
