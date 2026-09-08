import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { ConversationSummary, HistoryItem, HistoryRecordInput, LoggerLike } from '../types';
import { normalizeStoredMessage, type StoredMessage } from './history-message';

export type SyncQuery = { steamAccountId: string; cursor?: string; limit?: number };
export type SyncPage = { items: Array<HistoryItem & { syncId: string }>; nextCursor: string; hasMore: boolean; steamAccountId: string };
export type HistoryQuery = { steamAccountId: string; id: string; limit?: number; before?: string; after?: string; at?: number };
export type ConversationQuery = { steamAccountId: string; limit?: number; before?: string };
export type HistoryPage = { items: HistoryItem[]; nextCursor?: string; previousCursor?: string };
export type ConversationPage = { items: ConversationSummary[]; nextCursor?: string };
export type LaneStatus = { state: string; queued: number; queuedBytes?: number; writable: boolean; durable: number; missed: number; lastError?: string };
export type StorageStatus = { jsonl: LaneStatus; rocksdb: LaneStatus };
export interface HistoryStorage {
  append(input: HistoryRecordInput, options?: { notify?: boolean }): HistoryItem;
  sync(options: SyncQuery): Promise<SyncPage>;
  onDurable(listener: (item: HistoryItem) => void): () => void;
  history(options: HistoryQuery): Promise<HistoryPage>;
  conversations(options: ConversationQuery): Promise<ConversationPage>;
  status(): StorageStatus;
  canSend(): boolean;
  onMessage(listener: (item: HistoryItem) => void): () => void;
  onStatus(listener: (status: StorageStatus) => void): () => void;
  close(): Promise<void>;
}

type Options = { logPath?: string; dbPath?: string; logger?: LoggerLike; queueLimit?: number; queueBytes?: number;
  timeoutMs?: number; retryMs?: number; shutdownMs?: number; workerPath?: string };
const unavailable = (message: string) => Object.assign(new Error(message), { statusCode: 503 });

class WriterLane {
  private child?: ChildProcess;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private queue: Array<{ item: StoredMessage; attempts: number; bytes: number }> = [];
  private queuedBytes = 0;
  private failures = 0;
  private processing = false;
  private ready = false;
  private stopping = false;
  private restarting?: NodeJS.Timeout;
  private startup?: Promise<void>;
  private durable = 0;
  private missed = 0;
  private lastError?: string;
  private writeFailed = false;
  constructor(private kind: 'jsonl' | 'rocksdb', private filename: string, private options: Options,
    private changed: () => void, private committed: (item: StoredMessage) => void = () => {}) { this.start(); }

  status(): LaneStatus {
    return { state: this.stopping ? 'closed' : !this.ready || this.writeFailed ? 'failed' : this.missed ? 'lagging' : 'healthy',
      writable: !this.stopping && this.ready && !this.writeFailed && this.queue.length < (this.options.queueLimit || 1000) && this.queuedBytes < (this.options.queueBytes || 16 * 1024 * 1024),
      queued: this.queue.length, queuedBytes: this.queuedBytes, durable: this.durable, missed: this.missed, lastError: this.lastError };
  }

  private start() {
    if (this.stopping || this.child) return;
    this.startup = (async () => {
      const child = fork(this.options.workerPath || path.join(__dirname, 'history-worker.js'), [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: []
      });
      this.child = child;
      child.on('message', (message: { id: number; result?: unknown; error?: string; statusCode?: number; resetRequired?: boolean }) => {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id); clearTimeout(call.timer);
        if (message.error) call.reject(Object.assign(new Error(message.error), { statusCode: message.statusCode || 503, resetRequired: message.resetRequired }));
        else call.resolve(message.result);
      });
      const failed = (error: Error) => {
        if (this.child !== child) return;
        this.ready = false; this.child = undefined; this.lastError = error.message;
        if (!this.stopping) this.options.logger?.error?.(`${this.kind} history writer unavailable`, { error: this.lastError });
        for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
        this.pending.clear();
        if (!child.killed) child.kill();
        this.changed();
        if (!this.stopping && !this.restarting) this.restarting = setTimeout(() => {
          this.restarting = undefined; this.start();
        }, Math.min(30000, (this.options.retryMs || 1000) * 2 ** Math.min(this.failures++, 5)));
      };
      child.on('error', failed);
      child.on('exit', (code, signal) => failed(unavailable(`${this.kind} worker exited (${code ?? signal})`)));
      try {
        await this.rpc('init', { kind: this.kind, path: this.filename });
        if (this.child !== child) return;
        this.ready = true; this.failures = 0; this.writeFailed = false; this.lastError = undefined; this.changed(); void this.pump();
      } catch (error) { failed(error as Error); }
    })();
  }

  private rpc(method: string, value: unknown, timeoutMs = this.options.timeoutMs || 15000): Promise<any> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(unavailable(`${this.kind} writer unavailable`));
    // Queries have their own admission ceiling; reserve room for durable writes and shutdown.
    if ((method === 'history' || method === 'conversations' || method === 'sync') && this.pending.size >= 16) {
      return Promise.reject(unavailable('History query limit reached'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(unavailable(`${this.kind} ${method} timed out`));
        child.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, value }, (error) => {
        if (!error) return;
        const call = this.pending.get(id);
        if (call) { this.pending.delete(id); clearTimeout(timer); call.reject(error); }
      });
    });
  }

  enqueue(item: StoredMessage): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (this.stopping || this.queue.length >= (this.options.queueLimit || 1000)
      || this.queuedBytes + bytes > (this.options.queueBytes || 16 * 1024 * 1024)) {
      this.missed++; this.lastError = 'Writer queue full or closed; reconcile from surviving copy';
      if (this.missed === 1 || this.missed % 100 === 0) this.options.logger?.error?.(`${this.kind} history queue overflow`, { missed: this.missed });
      this.changed(); return false;
    }
    this.queue.push({ item, attempts: 0, bytes }); this.queuedBytes += bytes;
    void this.pump(); return true;
  }

  private async pump() {
    if (this.processing || !this.ready) return;
    this.processing = true;
    try {
      while (this.ready && this.queue.length) {
        const job = this.queue[0];
        try {
          await this.rpc('append', job.item);
          this.queue.shift(); this.queuedBytes -= job.bytes; this.durable++; this.writeFailed = false; this.changed();
          this.committed(job.item);
        } catch (error) {
          this.writeFailed = true;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.options.logger?.error?.(`${this.kind} history write failed`, { eventId: job.item.eventId, error: this.lastError });
          if (++job.attempts >= 3) { this.queue.shift(); this.queuedBytes -= job.bytes; this.missed++; }
          this.changed();
          if (!this.ready) break;
          await new Promise((resolve) => setTimeout(resolve, this.options.retryMs || 1000));
        }
      }
    } finally { this.processing = false; }
  }

  async query(method: string, value: unknown): Promise<any> {
    await this.startup;
    if (!this.ready || this.stopping) throw unavailable(`${this.kind} history unavailable`);
    return this.rpc(method, value);
  }

  async close() {
    if (this.restarting) clearTimeout(this.restarting);
    const deadline = Date.now() + (this.options.shutdownMs || 5000);
    // Keep pumping already accepted records while rejecting new enqueues.
    this.stopping = true;
    while ((this.queue.length || this.processing) && (this.ready || this.child) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.queue.length) this.options.logger?.error?.(`${this.kind} shutdown with pending history`, { pending: this.queue.length });
    const child = this.child;
    if (child) {
      try { if (!this.processing) await this.rpc('close', null, Math.max(1, deadline - Date.now())); } catch (_) { /* Terminate only this writer. */ }
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.ready = false;
  }
}

export function createHistoryStorage(options: Options = {}): HistoryStorage {
  const { DATA_DIR } = require('../paths');
  const data: string = DATA_DIR;
  const durableListeners = new Set<(item: HistoryItem) => void>();
  const messages = new Set<(item: HistoryItem) => void>();
  const listeners = new Set<(status: StorageStatus) => void>();
  const recent = new Map<string, { item: StoredMessage; expires: number; bytes: number; notified: boolean }>();
  let recentBytes = 0;
  let closed = false;
  let jsonl: WriterLane;
  let rocksdb: WriterLane;
  const changed = () => {
    if (!jsonl || !rocksdb) return;
    const status = storage.status();
    for (const listener of listeners) { try { listener(status); } catch (error) { options.logger?.warn?.('History status listener failed'); } }
  };
  const storage: HistoryStorage = {
    append(input, dispatch = {}) {
      if (closed) throw unavailable('History storage closed');
      const key = typeof input.steamEventKey === 'string' && /^[a-f0-9]{64}$/.test(input.steamEventKey) ? input.steamEventKey : undefined;
      for (const [id, value] of recent) {
        if (value.expires > Date.now()) break;
        recent.delete(id); recentBytes -= value.bytes;
      }
      const previous = key ? recent.get(key) : undefined;
      const item = previous?.item || normalizeStoredMessage(input);
      if (key && !previous) {
        const bytes = Buffer.byteLength(JSON.stringify(item));
        while (recent.size >= 1024 || recentBytes + bytes > 4 * 1024 * 1024) {
          const oldest = recent.entries().next().value;
          if (!oldest) break;
          recent.delete(oldest[0]); recentBytes -= oldest[1].bytes;
        }
        recent.set(key, { item, expires: Date.now() + 30000, bytes, notified: false }); recentBytes += bytes;
      }
      // No await and no shared queue: a failing lane never cancels the other enqueue.
      const persistence = { jsonl: 'pending', rocksdb: 'pending' };
      for (const [name, lane] of [['jsonl', jsonl], ['rocksdb', rocksdb]] as const) {
        try { if (!lane.enqueue(item)) persistence[name] = 'failed'; }
        catch (error) { persistence[name] = 'failed'; options.logger?.error?.('History enqueue failed', { error: String(error) }); }
      }
      const result: HistoryItem = { ...item, persistence };
      if (dispatch.notify !== false && !previous?.notified) {
        const cached = key ? recent.get(key) : undefined;
        if (cached) cached.notified = true;
        for (const listener of messages) { try { listener(result); } catch (_) { options.logger?.warn?.('History message listener failed'); } }
      }
      return result;
    },
    sync: (query) => rocksdb.query('sync', query),
    onDurable(listener) { durableListeners.add(listener); return () => durableListeners.delete(listener); },
    history: (query) => rocksdb.query('history', query),
    conversations: (query) => rocksdb.query('conversations', query),
    status: () => ({ jsonl: jsonl.status(), rocksdb: rocksdb.status() }),
    canSend: () => !closed && (jsonl.status().writable || rocksdb.status().writable),
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { closed = true; await Promise.all([jsonl.close(), rocksdb.close()]); listeners.clear(); messages.clear(); durableListeners.clear(); recent.clear(); recentBytes = 0; }
  };
  jsonl = new WriterLane('jsonl', options.logPath || process.env.STEAM_CHAT_LOG_PATH || path.join(data, 'logs', 'chat.jsonl'), options, changed);
  rocksdb = new WriterLane('rocksdb', options.dbPath || process.env.STEAM_CHAT_DB_PATH || path.join(data, 'chat.rocksdb'), options, changed, (item) => {
    for (const listener of durableListeners) {
      try { listener(item); } catch (_) { options.logger?.warn?.('History durable listener failed'); }
    }
  });
  return storage;
}
