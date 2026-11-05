import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord, type LoggerLike } from '../types';

const categories = ['emoticons', 'stickers', 'effects'] as const;
export type SteamInventoryCategory = typeof categories[number];
export type SteamInventory = {
  emoticons: unknown[]; stickers: unknown[]; effects: unknown[]; complete?: boolean;
  /** Failed loader arrays are ignored; the cache retains saved materials for these categories. */
  failedCategories?: SteamInventoryCategory[];
};
type FetchInventory = (previousInventory: SteamInventory | undefined) => Promise<SteamInventory>;
type Snapshot = SteamInventory & { updatedAt: number };
export type CachedSteamInventory = SteamInventory & {
  cache: { updatedAt: number; refreshing: boolean; stale: boolean; retryAt: number; failedCategories?: SteamInventoryCategory[] };
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

const unavailable = (message: string, code = 'UNAVAILABLE') => Object.assign(new Error(message), { statusCode: 503, code });
// Only exact codes are logged, never upstream messages, stacks, cookies or arbitrary code strings.
const diagnosticCodes = new Set(['UNAVAILABLE', 'TIMEOUT', 'STOPPED', 'INCOMPLETE', 'INVALID_MATERIAL',
  'INVALID_SNAPSHOT', 'ALL_CATEGORIES_FAILED', 'EMOTICONS', 'COMMUNITY_INVENTORY', 'STICKERS', 'EFFECTS', 'CATALOG',
  'EACCES', 'ENOTDIR', 'ENOSPC', 'EROFS']);
function diagnosticCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' && diagnosticCodes.has(error.code) ? error.code : 'UNKNOWN';
}

// Persist only display/protocol fields. SDK objects may carry credentials or huge descriptions.
function materials(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unavailable('Incomplete Steam inventory', 'INCOMPLETE');
  return value.map(item => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name || item.name.length > 2048) {
      throw unavailable('Invalid Steam inventory material', 'INVALID_MATERIAL');
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

function inventory(value: unknown, refresh?: { previous?: SteamInventory }): SteamInventory {
  if (!isRecord(value) || value.complete === false) throw unavailable('Incomplete Steam inventory', 'INCOMPLETE');
  const reportedFailures = value.failedCategories === undefined ? [] : value.failedCategories;
  if (!Array.isArray(reportedFailures) || reportedFailures.some(category => !categories.includes(category))) {
    throw unavailable('Invalid Steam inventory failure metadata', 'INCOMPLETE');
  }
  const failedCategories = categories.filter(category => reportedFailures.includes(category));
  const result = {} as SteamInventory;
  for (const category of categories) {
    // Failed loader arrays are untrusted. Disk snapshots already contain the retained materials.
    result[category] = materials(refresh && failedCategories.includes(category)
      ? refresh.previous?.[category] ?? [] : value[category]);
  }
  if (failedCategories.length) result.failedCategories = failedCategories;
  return result;
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
        throw unavailable('Invalid snapshot', 'INVALID_SNAPSHOT');
      }
      entry.snapshot = { ...inventory(value), updatedAt: value.updatedAt };
      if (entry.snapshot.failedCategories?.length) {
        entry.retryAt = value.updatedAt + (this.options.retryMs ?? 30_000);
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        this.options.logger?.warn?.(`Steam inventory cache unreadable [stage=load code=${diagnosticCode(error)}]; fetching a fresh snapshot`, { account });
      }
    }
  }

  private refresh(account: string | undefined, entry: Entry, fetchInventory: FetchInventory) {
    if (entry.refresh || this.closed || this.now() < entry.retryAt) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.refresh = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stage = 'fetch';
      try {
        const cancelled = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(unavailable('Steam inventory refresh stopped', 'STOPPED')), { once: true });
        });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable('Steam inventory refresh timed out', 'TIMEOUT')), this.options.timeoutMs ?? 15_000);
        });
        // Promise.race consumes late upstream rejections; late results cannot mutate this entry.
        // Copy only this account's saved materials and failure metadata; helpers cannot mutate the live snapshot.
        const previousInventory = entry.snapshot ? inventory(entry.snapshot) : undefined;
        const result = await Promise.race([Promise.resolve().then(() => fetchInventory(previousInventory)), timeout, cancelled]);
        stage = 'validate';
        const data = inventory(result, { previous: entry.snapshot });
        if (data.failedCategories?.length === categories.length && !entry.snapshot) {
          throw unavailable('Steam inventory unavailable: all categories failed', 'ALL_CATEGORIES_FAILED');
        }
        if (this.closed) throw unavailable('Steam inventory cache stopped', 'STOPPED');
        const snapshot = { ...data, updatedAt: this.now() };
        stage = 'persist';
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
        entry.retryAt = data.failedCategories?.length ? snapshot.updatedAt + (this.options.retryMs ?? 30_000) : 0;
        if (data.failedCategories?.length) {
          this.options.logger?.warn?.(`Steam inventory refresh incomplete [stage=partial failedCategories=${data.failedCategories.join(',')}]; keeping saved materials for failed categories`, { account });
        }
      } catch (error) {
        entry.error = error;
        entry.retryAt = this.now() + (this.options.retryMs ?? 30_000);
        // Do not log upstream errors: they can include web cookies or whole SDK responses.
        this.options.logger?.warn?.(`Steam inventory refresh failed [stage=${stage} code=${diagnosticCode(error)}]; keeping the saved snapshot`, { account });
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
    const stale = !entry.snapshot || this.now() - entry.snapshot.updatedAt >= (this.options.ttlMs ?? 600_000) ||
      Boolean(entry.snapshot.failedCategories?.length) || Boolean(entry.error);
    if (stale) this.refresh(account, entry, fetchInventory);
    if (!entry.snapshot) await entry.refresh;
    if (!entry.snapshot) throw entry.error ?? unavailable('Steam inventory unavailable');
    return { emoticons: entry.snapshot.emoticons, stickers: entry.snapshot.stickers, effects: entry.snapshot.effects,
      cache: { updatedAt: entry.snapshot.updatedAt, refreshing: Boolean(entry.refresh),
        stale: this.now() - entry.snapshot.updatedAt >= (this.options.ttlMs ?? 600_000) ||
          Boolean(entry.snapshot.failedCategories?.length) || Boolean(entry.error), retryAt: entry.retryAt,
        ...(entry.snapshot.failedCategories?.length ? { failedCategories: [...entry.snapshot.failedCategories] } : {}) } };
  }

  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
    await Promise.allSettled([...this.entries.values()].map(entry => entry.refresh));
  }
}
