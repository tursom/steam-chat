import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DailyJsonlWriter } from '../src/storage/daily-jsonl';

// Use local dates so this suite also exercises the configured service timezone.
function date(day: number, hour = 12) { return new Date(2026, 0, day, hour); }
async function logNames(dir: string) { return (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort(); }
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-jsonl-'));
  const filename = path.join(dir, 'chat.jsonl');
  let now = date(2);
  const writer = new DailyJsonlWriter(filename, () => now);
  t.after(async () => { await writer.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, filename, writer, setDate(value: Date) { now = value; } };
}

test('crossing local midnight seals the writing day, independent of message timestamps', async (t) => {
  const { dir, filename, writer, setDate } = await fixture(t);
  const old = JSON.stringify({ message: 'live', sentAt: '2026-01-02T12:00:00Z' });
  const historical = JSON.stringify({ message: 'backfill', sentAt: '2020-01-01T00:00:00Z' });
  await writer.append(old);
  setDate(date(3, 0));
  await writer.append(historical);
  await writer.append('{"message":"next"}');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260102.jsonl'), 'utf8'), `${old}\n`);
  assert.equal(await fs.readFile(filename, 'utf8'), `${historical}\n{"message":"next"}\n`);
  assert.deepEqual(await logNames(dir), ['chat-20260102.jsonl', 'chat.jsonl']);
});

test('startup uses existing file mtime to rotate a previous day, and a same-day restart appends', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  await fs.writeFile(filename, '{"message":"yesterday"}\n');
  await fs.utimes(filename, date(1), date(1));
  await writer.ready();
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260101.jsonl'), 'utf8'), '{"message":"yesterday"}\n');
  await writer.append('{"message":"today"}');
  await writer.close();
  await fs.utimes(filename, date(2), date(2));
  await writer.append('{"message":"after restart"}');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"today"}\n{"message":"after restart"}\n');
  assert.equal((await logNames(dir)).length, 2);
});

test('empty and skipped days do not produce empty archives', async (t) => {
  const { dir, writer, setDate } = await fixture(t);
  await writer.ready();
  setDate(date(5));
  await writer.append('{}');
  assert.deepEqual(await logNames(dir), ['chat.jsonl']);
  setDate(date(8));
  await writer.append('{}');
  assert.deepEqual(await logNames(dir), ['chat-20260105.jsonl', 'chat.jsonl']);
});

test('an existing archive is retained and the collision gets a distinct segment', async (t) => {
  const { dir, writer, setDate } = await fixture(t);
  await fs.writeFile(path.join(dir, 'chat-20260102.jsonl'), 'existing\n');
  await writer.append('{"message":"new segment"}');
  setDate(date(3));
  await writer.append('{}');
  const archive = (await fs.readdir(dir)).find(name => /^chat-20260102-[a-f0-9]{16}\.jsonl$/.test(name));
  assert.ok(archive);
  assert.equal(await fs.readFile(path.join(dir, archive), 'utf8'), '{"message":"new segment"}\n');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260102.jsonl'), 'utf8'), 'existing\n');
});

test('restart finishes a published hardlink without appending to or repairing the archive', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  const sealed = '{"message":"sealed"}\n';
  await fs.writeFile(filename, sealed);
  const archive = path.join(dir, 'chat-20260101.jsonl');
  await fs.link(filename, archive);
  // Even with a current-day mtime, the inode has already been published as sealed.
  await fs.utimes(filename, date(2), date(2));
  await writer.append('{"message":"fresh"}');
  assert.equal(await fs.readFile(archive, 'utf8'), sealed);
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"fresh"}\n');
  assert.notEqual((await fs.stat(filename)).ino, (await fs.stat(archive)).ino);
});

test('restart after active unlink creates a new activity file alongside the sealed segment', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  await fs.writeFile(path.join(dir, 'chat-20260101.jsonl'), '{}\n');
  await writer.append('{"message":"fresh"}');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"fresh"}\n');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260101.jsonl'), 'utf8'), '{}\n');
});

test('repairs an incomplete tail before sealing a stale activity file', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  await fs.writeFile(filename, '{}\n{"partial":');
  await fs.utimes(filename, date(1), date(1));
  await writer.append('{"message":"fresh"}');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260101.jsonl'), 'utf8'), '{}\n');
  const partial = (await fs.readdir(dir)).find(name => name.endsWith('.partial'));
  assert.ok(partial);
  assert.equal(await fs.readFile(path.join(dir, partial), 'utf8'), '{"partial":');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"fresh"}\n');
});

test('a crash after tail truncation retains the original writing day despite changed mtime', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  await fs.writeFile(filename, '{}\n{"partial":');
  const stat = await fs.stat(filename);
  // This is the durable state published before the first repair. Simulate a
  // process dying after truncate updated mtime, but before rotation could finish.
  await fs.writeFile(`${filename}.rotation.json`, JSON.stringify({
    version: 1, dev: String(stat.dev), ino: String(stat.ino), day: '20260101'
  }));
  await fs.truncate(filename, 3);
  await fs.utimes(filename, date(2), date(2));
  await writer.append('{"message":"fresh"}');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260101.jsonl'), 'utf8'), '{}\n');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"fresh"}\n');
});

test('retry after a post-truncate fsync failure still seals the original writing day', async (t) => {
  const { dir, filename, writer } = await fixture(t);
  await fs.writeFile(filename, '{}\n{"partial":');
  await fs.utimes(filename, date(1), date(1));
  const handle = await fs.open(filename, 'r');
  const inode = (await handle.stat()).ino;
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  let failed = false;
  const patched = t.mock.method(prototype, 'sync', async function (this: fs.FileHandle) {
    const stat = await this.stat();
    if (!failed && stat.ino === inode && stat.size === 3) {
      failed = true;
      throw Object.assign(new Error('injected post-truncate sync failure'), { code: 'EIO' });
    }
    return sync.call(this);
  });
  await assert.rejects(writer.append('{"message":"fresh"}'), { code: 'EIO' });
  patched.mock.restore();
  assert.equal(failed, true);
  await writer.append('{"message":"fresh"}');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260101.jsonl'), 'utf8'), '{}\n');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"fresh"}\n');
});

test('a failed archive publication preserves the activity file and can be retried', async (t) => {
  const { dir, filename, writer, setDate } = await fixture(t);
  await writer.append('{"message":"retained"}');
  setDate(date(3));
  // Make the source path disappear while the handle remains open, as an unsupported
  // external rotator would. Publishing must fail rather than ACK a new append.
  const moved = path.join(dir, 'moved.jsonl');
  await fs.rename(filename, moved);
  await assert.rejects(writer.append('{"message":"retry"}'), { code: 'ENOENT' });
  assert.equal(await fs.readFile(moved, 'utf8'), '{"message":"retained"}\n');
  await fs.rename(moved, filename);
  await fs.utimes(filename, date(2), date(2));
  await writer.append('{"message":"retry"}');
  assert.equal(await fs.readFile(path.join(dir, 'chat-20260102.jsonl'), 'utf8'), '{"message":"retained"}\n');
  assert.equal(await fs.readFile(filename, 'utf8'), '{"message":"retry"}\n');
});
