import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { serializeStoredMessage, type StoredMessage } from './history-message';

// This module is loaded only by the forked writer, never by the HTTP process.
let database: any;
let file: fs.FileHandle | undefined;
let logFilename: string | undefined;
let serial = Promise.resolve();

async function openLog(filename: string) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  file = await fs.open(filename, 'a+');
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  const size = (await file.stat()).size;
  if (!size) return;
  const tail = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
  await file.read(tail, 0, tail.length, size - tail.length);
  if (tail[tail.length - 1] === 10) return;
  const newline = tail.lastIndexOf(10);
  if (newline < 0 && size > tail.length) throw new Error('JSONL tail exceeds repair limit; offline repair required');
  const partial = tail.subarray(newline + 1);
  const quarantine = await fs.open(`${filename}.${randomBytes(8).toString('hex')}.partial`, 'wx');
  try { await quarantine.writeFile(partial); await quarantine.sync(); } finally { await quarantine.close(); }
  await file.truncate(size - partial.length);
  await file.sync();
}

async function run(method: string, value: any): Promise<any> {
  if (method === 'init') {
    if (value.kind === 'jsonl') { logFilename = value.path; await openLog(value.path); }
    else {
      const { RocksHistoryStore } = require('./rocks-history');
      database = new RocksHistoryStore(value.path);
      await database.ready();
    }
    return true;
  }
  if (method === 'append') {
    const item: StoredMessage = value;
    if (logFilename) {
      try {
        if (!file) await openLog(logFilename);
        await file.writeFile(`${serializeStoredMessage(item)}\n`, 'utf8');
        await file.sync();
        return true;
      } catch (error) {
        await file?.close().catch((): undefined => undefined);
        file = undefined;
        throw error;
      }
    }
    return database.put(item);
  }
  if (method === 'sync') return database.sync(value);
  if (method === 'history') return database.history(value);
  if (method === 'conversations') return database.conversations(value);
  if (method === 'close') {
    if (file) { await file.sync(); await file.close(); file = undefined; }
    if (database) await database.close();
    return true;
  }
  throw new Error('Unknown storage worker method');
}

process.on('message', (message: { id: number; method: string; value: unknown }) => {
  serial = serial.then(async () => {
    try {
      const result = await run(message.method, message.value);
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error),
        statusCode: (error as { statusCode?: number }).statusCode,
        resetRequired: (error as { resetRequired?: boolean }).resetRequired });
    }
  });
});
// A vanished parent cannot drain or acknowledge requests; do not leave an orphan holding the DB lock.
process.on('disconnect', () => process.exit(1));
