import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppendOnlyJsonlWriter } from '../src/storage/history-jsonl';
import { jsonlLines } from '../src/storage/history-jsonl-lines';

test('JSONL scanning preserves Unicode separators and UTF-8 across stream chunks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-unicode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'chat.jsonl');
  const messages = ['first\u2028second\u2029third', `${'a'.repeat(65500)}中文\u2028尾部`, 'last'];
  const records = messages.map(message => JSON.stringify({ message }));
  await fs.writeFile(filename, records.join('\n') + '\n');
  const actual: string[] = [];
  for await (const line of jsonlLines(filename)) actual.push(line);
  assert.deepEqual(actual, records);
  assert.deepEqual(actual.map(line => JSON.parse(line).message), messages);
});

test('restart preserves complete JSONL records and quarantines an interrupted append before retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'chat.jsonl');
  const interrupted = '{"eventId":"interrupted';
  await fs.writeFile(filename, `{"eventId":"complete"}\n${interrupted}`);
  const writer = new AppendOnlyJsonlWriter(filename);
  t.after(() => writer.close());
  await writer.append('{"eventId":"retried"}');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"eventId":"complete"}\n{"eventId":"retried"}\n');
  const partials = (await fs.readdir(dir)).filter(name => name.endsWith('.partial'));
  assert.equal(partials.length, 1);
  assert.equal(await fs.readFile(path.join(dir, partials[0]), 'utf8'), interrupted);
  await writer.close();
  await writer.ready();
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.partial')).length, 1);
});

test('tail exceeding recovery limit fails without changing original JSONL', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'chat.jsonl');
  const original = Buffer.alloc(4 * 1024 * 1024 + 1, 65);
  await fs.writeFile(filename, original);
  const writer = new AppendOnlyJsonlWriter(filename);
  await assert.rejects(writer.ready(), /tail exceeds recovery limit/);
  assert.deepEqual(await fs.readFile(filename), original);
  assert.deepEqual(await fs.readdir(dir), ['chat.jsonl']);
});
