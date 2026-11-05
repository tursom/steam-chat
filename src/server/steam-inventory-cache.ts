import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord, type LoggerLike } from '../types';

export type SteamInventory = { emoticons: unknown[]; stickers: unknown[]; effects: unknown[]; complete?: boolean };
type FetchInventory = (previousInventory: SteamInventory | undefined) => Promise<SteamInventory>;
type Snapshot = SteamInventory & { updatedAt: number };
export type CachedSteamInventory = SteamInventory & {
  cache: { updatedAt: number; refreshing: boolean; stale: boolean; retryAt: number };
};
type Entry = {
  snapshot?: Snapshot;
  loaded?: Promise<void>;
  refresh?: Promise<void>;
  controller?: AbortController;
  retryAt: number;
  error?: unknown;
};
type Options = {
  dir: string;
  logger?: LoggerLike;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
};

const unavailable = (message: string) => Object.assign(new Error(message), { statusCode: 503 });

// Persist only display/protocol fields. SDK objects may carry credentials or huge descriptions.
function materials(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unavailable('Incomplete Steam inventory');
  return value.map(item => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name || item.name.length > 2048) {
      throw unavailable('Invalid Steam inventory material');
    }
    const result: Record<string, unknown> = { name: item.name };
    for (const key of ['title', 'imageUrl']) {
      if (typeof item[key] === 'string' && item[key].length <= 8192) result[key] = item[key];
    }
    if (Array.isArray(item.aliases)) {
      result.aliases = item.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length <= 2048).slice(0, 256);
    }
    return result;
  });
}

function inventory(value: unknown): SteamInventory {
  if (!isRecord(value) || value.complete === false) throw unavailable('Incomplete Steam inventory');
  return { emoticons: materials(value.emoticons), stickers: materials(value.stickers), effects: materials(value.effects) };
}

/** One instance is shared by HTTP and WS. Refresh work never owns request authorization. */
export class SteamInventoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private closed = false;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  private file(account: string) {
    if (!/^\d{17}$/.test(account)) throw unavailable('Steam inventory account is unavailable');
    return join(this.options.dir, `${account}.json`);
  }

  private async load(account: string | undefined, entry: Entry) {
    if (!account) return;
    try {
      const value: unknown = JSON.parse(await readFile(this.file(account), 'utf8'));
      if (!isRecord(value) || value.version !== 1 || value.account !== account ||
          typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt <= 0 || value.updatedAt > this.now()) {
        throw new Error('Invalid snapshot');
      }
      entry.snapshot = { ...inventory(value), updatedAt: value.updatedAt };
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        this.options.logger?.warn?.('Steam inventory cache unreadable; fetching a fresh snapshot', { account });
      }
    }
  }

  private refresh(account: string | undefined, entry: Entry, fetchInventory: FetchInventory) {
    if (entry.refresh || this.closed || this.now() < entry.retryAt) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.refresh = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(unavailable('Steam inventory refresh stopped')), { once: true });
        });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable('Steam inventory refresh timed out')), this.options.timeoutMs ?? 15_000);
        });
        // Promise.race consumes late upstream rejections; late results cannot mutate this entry.
        // Copy only this account's last complete materials; helpers cannot mutate the live snapshot.
        const previousInventory = entry.snapshot ? inventory(entry.snapshot) : undefined;
        const data = inventory(await Promise.race([Promise.resolve().then(() => fetchInventory(previousInventory)), timeout, cancelled]));
        if (this.closed) throw unavailable('Steam inventory cache stopped');
        const snapshot = { ...data, updatedAt: this.now() };
        if (account) {
          const file = this.file(account);
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await mkdir(this.options.dir, { recursive: true });
            await writeFile(temporary, JSON.stringify({ version: 1, account, ...snapshot }), { flag: 'wx', mode: 0o600 });
            await rename(temporary, file);
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        entry.snapshot = snapshot;
        entry.error = undefined;
        entry.retryAt = 0;
      } catch (error) {
        entry.error = error;
        entry.retryAt = this.now() + (this.options.retryMs ?? 30_000);
        // Do not log upstream errors: they can include web cookies or whole SDK responses.
        this.options.logger?.warn?.('Steam inventory refresh failed; keeping the last complete snapshot', { account });
      } finally {
        clearTimeout(timer);
        entry.controller = undefined;
        entry.refresh = undefined;
      }
    })();
  }

  async get(account: string | undefined, fetchInventory: FetchInventory): Promise<CachedSteamInventory> {
    if (this.closed) throw unavailable('Steam inventory cache stopped');
    if (account) this.file(account);
    const key = account ?? 'unscoped-helper';
    let entry = this.entries.get(key);
    if (!entry) { entry = { retryAt: 0 }; this.entries.set(key, entry); }
    entry.loaded ??= this.load(account, entry);
    await entry.loaded;
    const stale = !entry.snapshot || this.now() - entry.snapshot.updatedAt >= (this.options.ttlMs ?? 600_000) || Boolean(entry.error);
    if (stale) this.refresh(account, entry, fetchInventory);
    if (!entry.snapshot) await entry.refresh;
    if (!entry.snapshot) throw entry.error ?? unavailable('Steam inventory unavailable');
    return { emoticons: entry.snapshot.emoticons, stickers: entry.snapshot.stickers, effects: entry.snapshot.effects,
      cache: { updatedAt: entry.snapshot.updatedAt, refreshing: Boolean(entry.refresh),
        stale: this.now() - entry.snapshot.updatedAt >= (this.options.ttlMs ?? 600_000) || Boolean(entry.error), retryAt: entry.retryAt } };
  }

  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
    await Promise.allSettled([...this.entries.values()].map(entry => entry.refresh));
  }
}
