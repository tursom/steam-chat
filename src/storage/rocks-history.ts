import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RocksDatabase, Transaction } from '@harperfast/rocksdb-js';
import type { ConversationSummary, HistoryItem } from '../types';
import type { HistoryQuery, HistoryPage, ConversationQuery, ConversationPage, SyncQuery, SyncPage } from './history-storage';
import { canonicalMessage } from './history-message';
import { accountPrefix, conversationKey, messageKey, recentKey, eventKey, prefixSuccessor, encodeCursor, decodeCursor, syncKey, decodeMessageKey } from './history-key';
const { previewForMessage } = require('./chat-log');

const META = Buffer.from([0x01, 0x01]);
const ALLOCATOR = Buffer.from([0x01, 0x02]);
const SYNC_UPGRADE = Buffer.from([0x01, 0x03]);
type Summary = { summary: ConversationSummary; lastKey: string };
const encode = (value: unknown) => Buffer.from(JSON.stringify({ version: 1, value }));
function decode<T>(value: Buffer): T {
  const data = JSON.parse(value.toString('utf8'));
  if (data.version !== 1) throw new Error('Unsupported history value version');
  return data.value;
}
function limitOf(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1) throw Object.assign(new Error('Invalid limit'), { statusCode: 400 });
  return Math.min(limit, 500);
}

export class RocksHistoryStore {
  private db!: RocksDatabase;
  private generation = '';
  private opening?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed?: Promise<void>;
  private exports = new Set<Promise<void>>();
  constructor(private path: string) {}

  async ready(): Promise<void> {
    if (this.closing) throw new Error('History store closed');
    this.opening ??= this.open();
    await this.opening;
  }

  private async open() {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = RocksDatabase.open(this.path, { keyEncoding: 'binary', encoding: 'binary',
      compression: 'zstd', disableWAL: false, maxWriteBufferNumber: 2,
      maxOpenFiles: 256, parallelismThreads: 2, infoLogLevel: 3, maxLogFileSize: 1024 * 1024 });
    try {
      if (this.db.compression.algorithm !== 'zstd') throw new Error('RocksDB Zstd compression is not active');
      await this.db.transaction(async (txn) => {
        const raw = await txn.get(META);
        if (raw) {
          const meta = decode<{ schemaVersion: number; codecVersion: number; generation: string }>(raw);
          if (![1, 2].includes(meta.schemaVersion) || meta.codecVersion !== 1 || !/^[a-f0-9]{32}$/.test(meta.generation)) {
            throw new Error('Unsupported history schema or codec');
          }
          this.generation = meta.generation;
          // Fence old binaries before the first backfill checkpoint can be written.
          if (meta.schemaVersion === 1) await txn.put(META, encode({ schemaVersion: 2, codecVersion: 1, generation: meta.generation }));
          if (!(await txn.get(ALLOCATOR))) throw new Error('Missing history record allocator');
        } else {
          for (const _ of txn.getRange({ limit: 1 })) throw new Error('Unversioned nonempty history database');
          this.generation = randomBytes(16).toString('hex');
          await txn.put(META, encode({ schemaVersion: 2, codecVersion: 1, generation: this.generation }));
          await txn.put(ALLOCATOR, Buffer.alloc(8));
        }
      });
      await this.upgradeSyncIndex();
      await this.db.flush({ allowWriteStall: true });
    } catch (error) { this.db.close(); throw error; }
  }

  private async upgradeSyncIndex() {
    const meta = decode<{ schemaVersion: number; syncIndexVersion?: number }>(await this.db.get(META));
    if (meta.syncIndexVersion === 1) return;
    // Index and checkpoint share a transaction. No reads/writes are admitted until complete.
    let checkpoint: Buffer | undefined = await this.db.get(SYNC_UPGRADE);
    while (true) {
      const done = await this.transaction(async (txn) => {
        let count = 0;
        let last = checkpoint;
        for (const { key } of txn.getRange({ start: checkpoint ?? Buffer.from([0x10]),
          end: Buffer.from([0x11]), exclusiveStart: !!checkpoint, limit: 500 })) {
          const message = Buffer.from(key);
          const { steamAccountId, recordId } = decodeMessageKey(message);
          await txn.put(syncKey(steamAccountId, recordId), message);
          last = message;
          count++;
        }
        if (count < 500) {
          await txn.put(META, encode({ schemaVersion: 2, codecVersion: 1, generation: this.generation, syncIndexVersion: 1 }));
          await txn.remove(SYNC_UPGRADE);
        } else if (last) await txn.put(SYNC_UPGRADE, last);
        checkpoint = last;
        return count < 500;
      });
      await this.db.flush({ allowWriteStall: true });
      if (done) return;
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('History store closed'));
    const opening = this.ready();
    void opening.catch(() => {});
    const result = this.tail.then(async () => { await opening; return operation(); });
    this.tail = result.catch(() => {});
    return result;
  }

  private async transaction<T>(callback: (txn: Transaction) => Promise<T>): Promise<T> {
    const result = await this.db.transaction(callback);
    if (result === undefined) throw new Error('History transaction returned no result');
    return result as T;
  }

  put(input: HistoryItem & { eventId: string; sentAt: string }): Promise<HistoryItem> {
    // Copy the canonical fields before queueing so callers cannot mutate a pending write.
    const item: HistoryItem = JSON.parse(canonicalMessage(input));
    return this.run(async () => {
      if (!item.steamAccountId) throw new Error('Missing steamAccountId');
      const account = item.steamAccountId;
      const at = Date.parse(item.sentAt!);
      const ordinal = item.ordinal === null ? 0 : Number(item.ordinal);
      messageKey(account, item.id, at, ordinal, 0n);
      const mapping = eventKey(item.eventId!);
      const result = await this.transaction(async (txn) => {
        const existingKey: Buffer | undefined = await txn.get(mapping);
        if (existingKey) {
          const existing = decode<HistoryItem>(await txn.get(existingKey));
          if (canonicalMessage(existing) !== canonicalMessage(item)) {
            throw Object.assign(new Error(`eventId conflict: ${item.eventId}`), { statusCode: 409 });
          }
          return existing;
        }
        const allocator: Buffer = await txn.get(ALLOCATOR);
        const id = allocator.readBigUInt64BE() + 1n;
        const key = messageKey(account, item.id, at, ordinal, id);
        const next = Buffer.alloc(8); next.writeBigUInt64BE(id);
        const summaryKey = conversationKey(account, item.id);
        const previousRaw = await txn.get(summaryKey);
        const previous = previousRaw ? decode<Summary>(previousRaw) : undefined;
        const isLatest = !previous || Buffer.compare(key, Buffer.from(previous.lastKey, 'hex')) > 0;
        let state: Summary;
        if (isLatest) {
          if (previous) await txn.remove(recentKey(account, Number(Buffer.from(previous.lastKey, 'hex').readBigUInt64BE(17)), item.id));
          state = { lastKey: key.toString('hex'), summary: {
            id: item.id, name: (!item.echo && item.name && item.name !== 'Unknown' ? item.name : previous?.summary.name) || item.id,
            updatedAt: item.sentAt!, preview: previewForMessage(item), lastType: item.type,
            lastEcho: item.echo, messageCount: (previous?.summary.messageCount || 0) + 1
          } };
          await txn.put(recentKey(account, at, item.id), summaryKey);
        } else {
          state = { ...previous!, summary: { ...previous!.summary, messageCount: previous!.summary.messageCount + 1 } };
        }
        await txn.put(key, encode(item));
        await txn.put(mapping, key);
        await txn.put(syncKey(account, id), key);
        await txn.put(ALLOCATOR, next);
        await txn.put(summaryKey, encode(state));
        return item;
      });
      // 2.8.0 has no sync-WAL write option. A waiting SST flush is the durability gate,
      // including retries of transactions whose earlier flush failed after commit.
      await this.db.flush({ allowWriteStall: true });
      return result;
    });
  }

  sync(query: SyncQuery): Promise<SyncPage> {
    return this.run(async () => {
      const prefix = accountPrefix(0x22, query.steamAccountId);
      const limit = limitOf(query.limit);
      let boundary = syncKey(query.steamAccountId, 0n);
      if (query.cursor !== undefined) {
        try {
          boundary = decodeCursor(query.cursor, this.generation, prefix, 17);
          if (boundary.readBigUInt64BE(9) !== 0n && !(await this.db.get(boundary))) throw new Error('Missing sync boundary');
        } catch (_) {
          throw Object.assign(new Error('Invalid or stale sync cursor'), { statusCode: 409, resetRequired: true });
        }
      }
      // A prior put can have committed but failed its flush. Never advance a durable
      // client cursor over those rows until the durability gate succeeds.
      await this.db.flush({ allowWriteStall: true });
      return this.transaction(async (txn) => {
        const items: SyncPage['items'] = [];
        let last = boundary;
        let hasMore = false;
        for (const { key, value } of txn.getRange({ start: boundary, end: prefixSuccessor(prefix),
          exclusiveStart: true, limit: limit + 1 })) {
          if (items.length === limit) { hasMore = true; break; }
          const item = decode<HistoryItem>(await txn.get(value));
          if (!item.eventId) throw new Error('Missing sync eventId');
          items.push({ ...item, syncId: item.eventId });
          last = Buffer.from(key);
        }
        return { items, nextCursor: encodeCursor(this.generation, last), hasMore, steamAccountId: query.steamAccountId };
      });
    });
  }

  history(query: HistoryQuery): Promise<HistoryPage> {
    return this.run(async () => {
      const prefix = conversationKey(query.steamAccountId, query.id, 0x10);
      const limit = limitOf(query.limit);
      if ([query.before, query.after, query.at].filter((v) => v !== undefined).length > 1) throw Object.assign(new Error('before, after and at are mutually exclusive'), { statusCode: 400 });
      const cursor = query.before ?? query.after;
      let boundary = cursor === undefined ? undefined : decodeCursor(cursor, this.generation, prefix, 37);
      if (query.at !== undefined) {
        boundary = prefixSuccessor(messageKey(query.steamAccountId, query.id, query.at, 0xffffffff, 0xffffffffffffffffn));
      }
      const reverse = query.after === undefined;
      return this.transaction(async (txn) => {
        const rows: Array<{ key: Buffer; item: HistoryItem }> = [];
        for (const { key, value } of txn.getRange({
          start: boundary ?? (reverse ? prefixSuccessor(prefix) : prefix),
          end: reverse ? prefix : prefixSuccessor(prefix), reverse,
          // The binding swaps reverse bounds before applying end inclusivity.
          exclusiveStart: reverse || !!cursor, inclusiveEnd: false, limit: limit + 1
        })) {
          if (!Buffer.from(key).subarray(0, prefix.length).equals(prefix)) throw new Error('History range escaped conversation');
          rows.push({ key: Buffer.from(key), item: decode<HistoryItem>(value) });
        }
        const more = rows.length > limit;
        if (more) rows.pop();
        if (reverse) rows.reverse();
        const first = rows[0]?.key;
        const last = rows[rows.length - 1]?.key;
        const exists = (key: Buffer, backwards: boolean) => {
          for (const _ of txn.getRange({ start: key, end: backwards ? prefix : prefixSuccessor(prefix),
            reverse: backwards, exclusiveStart: true, inclusiveEnd: false, limit: 1 })) return true;
          return false;
        };
        return { items: rows.map((row) => row.item),
          nextCursor: first && (reverse ? more : exists(first, true)) ? encodeCursor(this.generation, first) : undefined,
          previousCursor: last && (reverse ? exists(last, false) : more) ? encodeCursor(this.generation, last) : undefined };
      });
    });
  }

  conversations(query: ConversationQuery): Promise<ConversationPage> {
    return this.run(async () => {
      const prefix = accountPrefix(0x21, query.steamAccountId);
      const limit = limitOf(query.limit);
      const boundary = query.before === undefined ? prefixSuccessor(prefix) : decodeCursor(query.before, this.generation, prefix, 25);
      return this.transaction(async (txn) => {
        const items: ConversationSummary[] = [];
        let last: Buffer | undefined;
        let more = false;
        for (const { key, value } of txn.getRange({ start: boundary, end: prefix, reverse: true, exclusiveStart: true, inclusiveEnd: false, limit: limit + 1 })) {
          if (items.length === limit) { more = true; break; }
          const state = decode<Summary>(await txn.get(value));
          items.push(state.summary); last = Buffer.from(key);
        }
        return { items, nextCursor: more && last ? encodeCursor(this.generation, last) : undefined };
      });
    });
  }

  getByEventId(id: string): Promise<HistoryItem | undefined> {
    return this.run(async () => {
      const key = await this.db.get(eventKey(id));
      return key ? decode<HistoryItem>(await this.db.get(key)) : undefined;
    });
  }

  async *all(): AsyncIterable<HistoryItem> {
    await this.ready();
    if (this.closing) throw new Error('History store closed');
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.exports.add(active);
    const txn = new Transaction(this.db.store);
    try {
      for await (const { value } of txn.getRange({ start: Buffer.from([0x10]), end: Buffer.from([0x11]) })) {
        yield decode<HistoryItem>(value);
      }
    } finally { txn.abort(); this.exports.delete(active); release(); }
  }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    // Reject new work, but drain calls accepted before close.
    const pending = this.tail;
    this.closed = (async () => {
      await pending;
      await this.opening?.catch(() => {});
      await Promise.all(this.exports);
      if (this.db?.isOpen()) this.db.close();
    })();
    this.closing = true;
    return this.closed;
  }
}
