import { createHash } from 'node:crypto';
import { open, mkdtemp, rm, link, unlink, lstat, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalMessage, normalizeStoredMessage, serializeStoredMessage } from './history-message';
import type { StoredMessage } from './history-message';

interface Store {
  ready(): Promise<unknown>;
  put(message: StoredMessage): Promise<unknown>;
  getByEventId(id: string): Promise<StoredMessage | null | undefined>;
  all(): AsyncIterable<StoredMessage>;
  close(): Promise<unknown>;
}
function store(path: string): Store {
  const { RocksHistoryStore } = require('./rocks-history');
  return new RocksHistoryStore(path);
}
export interface MaintenanceOptions {
  command: 'import' | 'export' | 'reconcile';
  db: string;
  file?: string;
  account?: string;
  timezone?: string;
  sourceId?: string;
  output?: string;
}
export const MAX_LINE_BYTES = 1024 * 1024;

function timezoneOffset(value: string): number {
  if (value === 'UTC') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value || '');
  if (!match || +match[2] > 14 || +match[3] > 59 || (+match[2] === 14 && +match[3] !== 0)) {
    throw new Error('Timezone must be UTC or a fixed offset between -14:00 and +14:00');
  }
  return (match[1] === '+' ? 1 : -1) * (+match[2] * 60 + +match[3]);
}

function timestamp(value: unknown, offset: number, explicit: boolean): string {
  if (typeof value !== 'string') throw new Error('Missing timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || (explicit && !match[8])) throw new Error('Invalid timestamp or missing sentAt timezone');
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction || '').padEnd(3, '0')}`;
  const ms = Date.parse(`${local}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${local}Z`) throw new Error('Invalid calendar timestamp');
  const adjusted = ms - (zone ? timezoneOffset(zone === 'Z' ? 'UTC' : zone) : offset) * 60_000;
  if (!Number.isSafeInteger(adjusted) || adjusted < 0) throw new Error('Timestamp outside supported range');
  return new Date(adjusted).toISOString();
}

function parseMessage(bytes: Buffer, byteOffset: number, options: MaintenanceOptions): StoredMessage {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const input = JSON.parse(text);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a message object');
  if (typeof input.message !== 'string' && typeof input.imageUrl !== 'string') throw new Error('Missing message');
  if (input.echo !== undefined && typeof input.echo !== 'boolean') throw new Error('Invalid echo');
  if (input.ordinal !== undefined && input.ordinal !== null &&
      !((typeof input.ordinal === 'number' && Number.isInteger(input.ordinal)) ||
        (typeof input.ordinal === 'string' && /^\d+$/.test(input.ordinal)))) throw new Error('Invalid ordinal');
  const offset = timezoneOffset(options.timezone);
  const sentAt = timestamp(input.sentAt ?? input.date, offset, input.sentAt !== undefined);
  if (input.eventId === undefined && !options.sourceId) throw new Error('Legacy records require --source-id (stable 32 hex digits)');
  const eventId = input.eventId ?? createHash('sha256')
    .update(`steam-chat-history-import:v1\0${options.sourceId.toLowerCase()}\0${byteOffset}`).digest('hex').slice(0, 32);
  return normalizeStoredMessage({ ...input, eventId, sentAt,
    date: input.date ?? sentAt,
    steamAccountId: input.steamAccountId ?? input.steam_account_id ?? options.account,
    ordinal: input.ordinal ?? 0 });
}

// Fixed-size reads and a hard line limit bound memory even for corrupt files without newlines.
async function scanSource(handle: FileHandle, options: MaintenanceOptions, index: Store): Promise<number> {
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let offset = 0;
  let line = 1;
  let count = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    let start = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (chunk[i] !== 10) continue;
      const length = pending.length + i - start;
      if (length > MAX_LINE_BYTES) throw new Error(`Line ${line}, byte ${offset}: exceeds ${MAX_LINE_BYTES} bytes; source retained`);
      const bytes = Buffer.concat([pending, chunk.subarray(start, i)]);
      try {
        await index.put(parseMessage(bytes, offset, options));
      } catch (error) {
        throw new Error(`Line ${line}, byte ${offset}: ${String(error)}; source retained, target unchanged`);
      }
      count++;
      offset += bytes.length + 1;
      line++;
      pending = Buffer.alloc(0);
      start = i + 1;
    }
    pending = Buffer.concat([pending, chunk.subarray(start, bytesRead)]);
    if (pending.length > MAX_LINE_BYTES) throw new Error(`Line ${line}, byte ${offset}: exceeds ${MAX_LINE_BYTES} bytes; source retained`);
  }
  if (pending.length) throw new Error(`Line ${line}, byte ${offset}: partial final line (missing newline); source retained, target unchanged`);
  return count;
}

async function assertNewOutput(output: string): Promise<void> {
  try { await lstat(output); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${output}`);
}

async function prepareOutput(output: string) {
  await assertNewOutput(output);
  const directory = await mkdtemp(join(dirname(resolve(output)), '.history-output-'));
  const temporary = join(directory, 'recovery.jsonl');
  const handle = await open(temporary, 'wx', 0o600);
  return {
    async append(message: StoredMessage) { await handle.writeFile(`${serializeStoredMessage(message)}\n`); },
    async publish() {
      await handle.sync();
      await handle.close();
      // Same-filesystem hard linking is atomic and fails on an existing destination, unlike rename.
      await link(temporary, output);
      const parent = await open(dirname(resolve(output)), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      await unlink(temporary);
    },
    async close() { await handle.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

export async function maintainHistory(options: MaintenanceOptions): Promise<{ sourceLines: number; inserted: number; exported: number }> {
  if (!options.db) throw new Error('--db is required');
  if (!['import', 'export', 'reconcile'].includes(options.command)) throw new Error('Expected import, export, or reconcile');
  if (options.command !== 'import' && !options.output) throw new Error('--output is required');
  if (options.command !== 'export') {
    if (!options.file || !options.account || !options.timezone) throw new Error('--file, --account and --timezone are required');
    if (!/^[0-9]+$/.test(options.account) || BigInt(options.account) <= 0n || BigInt(options.account) > 0xffffffffffffffffn) throw new Error('Invalid --account');
    timezoneOffset(options.timezone);
    if (options.sourceId !== undefined && !/^[a-f0-9]{32}$/i.test(options.sourceId)) throw new Error('Invalid --source-id');
  }
  if (options.output) await assertNewOutput(options.output);
  const db = store(options.db);
  let directory: string;
  let index: Store;
  let source: FileHandle;
  let output: Awaited<ReturnType<typeof prepareOutput>>;
  const result = { sourceLines: 0, inserted: 0, exported: 0 };
  try {
    await db.ready(); // A runtime-owned RocksDB lock must fail, never be removed or bypassed.
    if (options.command !== 'export') {
      source = await open(options.file, 'r');
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error('Source must be a regular file');
      directory = await mkdtemp(join(tmpdir(), 'history-source-'));
      index = store(join(directory, 'index'));
      await index.ready();
      result.sourceLines = await scanSource(source, options, index);
      const after = await stat(options.file, { bigint: true });
      const held = await source.stat({ bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
        if (before[key] !== after[key] || before[key] !== held[key]) throw new Error('Source changed during validation; target unchanged');
      }
      for await (const message of index.all()) {
        const existing = await db.getByEventId(message.eventId);
        if (existing && canonicalMessage(existing) !== canonicalMessage(message)) {
          throw new Error(`Content conflict for eventId ${message.eventId}; target unchanged`);
        }
      }
    }
    if (options.command !== 'import') {
      output = await prepareOutput(options.output);
      for await (const message of db.all()) {
        if (index && await index.getByEventId(message.eventId)) continue;
        await output.append(message);
        result.exported++;
      }
    }
    if (index) {
      for await (const message of index.all()) {
        if (await db.getByEventId(message.eventId)) continue;
        await db.put(message);
        result.inserted++;
      }
    }
    if (output) await output.publish();
    return result;
  } finally {
    // Attempt every cleanup even when a native close fails.
    try { if (output) await output.close(); }
    finally { try { if (source) await source.close(); }
      finally { try { if (index) await index.close(); }
        finally { try { await db.close(); }
          finally { if (directory) await rm(directory, { recursive: true, force: true }); } } } }
  }
}

export function parseArguments(args: string[]): MaintenanceOptions {
  const [command, ...rest] = args;
  const values: Record<string, string> = {};
  const allowed = new Set(['db', 'file', 'account', 'timezone', 'source-id', 'output']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed.has(key) || values[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) {
      throw new Error(`Invalid or duplicate option: ${rest[i]}`);
    }
    values[key] = rest[i + 1];
  }
  return { command: command as MaintenanceOptions['command'], db: values.db, file: values.file,
    account: values.account, timezone: values.timezone, sourceId: values['source-id'], output: values.output };
}

if (require.main === module) {
  console.error('OFFLINE ONLY: stop steam-chat and all writers before maintenance. Lock errors are fatal.');
  Promise.resolve().then(() => maintainHistory(parseArguments(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(String(error)); process.exitCode = 1; });
}
