import { isRecord } from '../types';

export type InventorySticker = {
  name: string;
  title: string;
  imageUrl: string;
  aliases: string[];
};

export type StickerInventoryOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  itemClass?: 11 | 12;
  /** Verified materials from the same account and item class's last complete snapshot. */
  previousInventory?: unknown[];
  /** Receive a verified subset while retaining unresolved owned items in the caller's cache. */
  onIncomplete?: (unresolved: number) => void;
};

type Definition = { name: string; title: string; aliases: string[] };
type Catalog = Map<string, Definition | null>;
type CacheEntry = { expires: number; catalog?: Catalog; refresh?: Promise<void>; error?: unknown };
const caches = new WeakMap<typeof fetch, Map<string, CacheEntry>>();
const MAX_FILTERED_APPS = 32;
const MAX_PAGES = 4;
const MAX_CACHE_ENTRIES = 64;
const TIMEOUT_MS = 4000;
const safeName = (name: string): boolean => Boolean(name.trim()) && name.length <= 512 && !/[\[\]"\\\x00-\x1f\x7f]/.test(name);

function mergeAlias(catalog: Catalog, alias: string, definition: Definition | null): void {
  const prior = catalog.get(alias);
  // Conflicting authoritative names must never silently pick the last definition.
  catalog.set(alias, prior === null || (prior && definition && prior.name !== definition.name) ? null : definition);
}

function mergeCatalogs(previous: Catalog, current: Catalog): Catalog {
  const merged = new Map(previous);
  for (const [alias, definition] of current) mergeAlias(merged, alias, definition);
  return merged;
}

function snapshotCatalog(inventory: unknown[] = []): Catalog {
  const catalog: Catalog = new Map();
  for (const item of inventory) {
    if (!isRecord(item) || typeof item.name !== 'string' || !safeName(item.name) || !Array.isArray(item.aliases)) continue;
    // Only persisted, explicitly verified aliases establish a mapping. Display titles
    // and suffixes cannot establish one, including for retired rewards after restart.
    const aliases = [item.name, ...item.aliases.filter((alias): alias is string => typeof alias === 'string' && safeName(alias))];
    const definition = { name: item.name, title: typeof item.title === 'string' ? item.title : item.name, aliases };
    for (const alias of aliases) mergeAlias(catalog, alias, definition);
  }
  return catalog;
}

function addDefinition(catalog: Catalog, value: unknown, appids: Set<number>, itemClass = 11): void {
  const appid = isRecord(value) ? Number(value.appid) : NaN;
  if (!isRecord(value) || !Number.isSafeInteger(appid) || appid <= 0 || appid > 0xffffffff ||
      (appids.size > 0 && !appids.has(appid)) || Number(value.community_item_class) !== itemClass ||
      !Number.isSafeInteger(value.community_item_type) || Number(value.community_item_type) <= 0 ||
      !isRecord(value.community_item_data)) return;
  const data = value.community_item_data;
  if (typeof value.internal_description !== 'string' || !safeName(value.internal_description)) return;
  const name = value.internal_description;
  const title = typeof data.item_title === 'string' && data.item_title ? data.item_title
    : typeof data.item_name === 'string' && data.item_name ? data.item_name : name;
  const labels = [...new Set([name, data.item_name, data.item_title])]
    .filter((label): label is string => typeof label === 'string' && safeName(label));
  const aliases = [...new Set(labels.flatMap(label => {
    const decorated = `${label} (Sticker)-${value.community_item_type}`;
    return [label, `${appid}-${label}`, `${label} (Sticker)`, `${appid}-${label} (Sticker)`, decorated, `${appid}-${decorated}`];
  }))];
  const definition = { name, title, aliases };
  for (const alias of aliases) mergeAlias(catalog, alias, definition);
}

async function fetchCatalog(appids: number[], fetchImpl: typeof fetch, timeoutMs: number, itemClass: number): Promise<Catalog> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Sticker catalog timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const catalog: Catalog = new Map();
      const allowed = new Set(appids);
      const cursors = new Set<string>();
      let cursor = '';
      let received = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (controller.signal.aborted) throw new Error('Sticker catalog timed out');
        const url = new URL('https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/');
        url.searchParams.set('input_json', JSON.stringify({
          appids, community_item_classes: [itemClass], count: 1000, language: 'english', include_direct_purchase_disabled: true, ...(cursor ? { cursor } : {})
        }));
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Sticker catalog HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.response)) throw new Error('Invalid sticker catalog');
        const total = body.response.total_count;
        if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)) {
          throw new Error('Invalid sticker catalog total');
        }
        const definitions = body.response.definitions ?? (body.response.count === 0 ? [] : undefined);
        if (!Array.isArray(definitions) || definitions.length > 1000) throw new Error('Invalid sticker catalog');
        for (const definition of definitions) addDefinition(catalog, definition, allowed, itemClass);
        received += definitions.length;
        if (typeof total === 'number' && received >= total) return catalog;
        const next = body.response.next_cursor;
        if (next === undefined || next === '' || next === '0') {
          if (total !== undefined) throw new Error('Incomplete sticker catalog');
          return catalog;
        }
        if (!definitions.length || typeof next !== 'string' || cursors.has(next)) {
          throw new Error('Incomplete sticker catalog pagination');
        }
        cursors.add(next);
        cursor = next;
      }
      throw new Error('Incomplete sticker catalog: page limit reached');
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

async function getCatalog(appids: number[], options: StickerInventoryOptions, waitForRefresh = false): Promise<Catalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cache = caches.get(fetchImpl);
  if (!cache) caches.set(fetchImpl, cache = new Map());
  const timeoutMs = Math.max(1, Math.min(TIMEOUT_MS, options.timeoutMs || TIMEOUT_MS));
  const itemClass = options.itemClass ?? 11;
  const key = `${itemClass}:${appids.join(',')}:${timeoutMs}`;
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    entry = { expires: 0 };
    cache.set(key, entry);
  }
  const current = entry;
  if (!current.refresh && current.expires <= now()) {
    current.refresh = fetchCatalog(appids, fetchImpl, timeoutMs, itemClass).then(catalog => {
      // A complete refresh may omit retired rewards. Keep their authoritative aliases,
      // but never resolve aliases that have acquired a conflicting protocol name.
      current.catalog = mergeCatalogs(current.catalog ?? new Map(), catalog);
      current.error = undefined;
      current.expires = now() + 10 * 60_000;
    }, error => {
      current.error = error;
      current.expires = now() + 30_000;
    }).finally(() => { current.refresh = undefined; });
  }
  if (!current.catalog || waitForRefresh) await current.refresh;
  if (!current.catalog) throw current.error ?? new Error('Sticker catalog unavailable');
  return current.catalog;
}

/** Historical messages may lack the app prefix, so their aliases use the public catalog. */
export async function resolveStickerAlias(type: string, options: StickerInventoryOptions = {}): Promise<string | undefined> {
  if (!safeName(type)) return undefined;
  try {
    const catalog = await getCatalog([], options);
    return catalog.get(type)?.name;
  } catch {
    return undefined;
  }
}

/** Resolve owned community inventory items; never derive decorated types by suffix stripping. */
export async function resolveStickerInventory(inventory: unknown[], options: StickerInventoryOptions = {}): Promise<InventorySticker[]> {
  // steamcommunity can successfully return CEconItems without joined descriptions.
  // Every asset must be classifiable before any can be excluded as a non-chat item.
  if (inventory.some(item => !isRecord(item) || typeof item.name !== 'string' ||
      !Array.isArray(item.tags) || !item.tags.some(tag => isRecord(tag) && tag.category === 'item_class' &&
        typeof tag.internal_name === 'string' && /^item_class_\d+$/.test(tag.internal_name)))) {
    throw new Error('Incomplete Steam community inventory');
  }
  const items = inventory.filter(isRecord).filter(item => Array.isArray(item.tags) && item.tags.some(tag =>
    isRecord(tag) && tag.category === 'item_class' && tag.internal_name === `item_class_${options.itemClass ?? 11}`));
  const parsed = items.flatMap(item => {
    if (typeof item.market_hash_name !== 'string') return [];
    const match = /^(\d+)-(.+)$/.exec(item.market_hash_name);
    const name = match ? match[2]! : item.market_hash_name;
    const appid = match ? Number(match[1]) : 0;
    if (!safeName(name) || (match && (!Number.isSafeInteger(appid) || appid <= 0 || appid > 0xffffffff))) return [];
    return [{ item, name, appid, hash: item.market_hash_name }];
  });
  if (!items.length) return [];
  let unresolved = items.length - parsed.length;
  if (unresolved && !options.onIncomplete) throw new Error('Unresolvable owned sticker inventory');
  if (!parsed.length) { options.onIncomplete?.(unresolved); return []; }
  const appids = [...new Set(parsed.filter(item => item.appid).map(item => item.appid))]
    .sort((a, b) => a - b);
  // Large inventories and unprefixed aliases use the bounded public catalog, not a truncated app list.
  const catalogAppids = appids.length > MAX_FILTERED_APPS || parsed.some(item => !item.appid) ? [] : appids;
  const previous = snapshotCatalog(options.previousInventory);
  let catalog = mergeCatalogs(previous, await getCatalog(catalogAppids, options));
  if (parsed.some(({ hash }) => !catalog.get(hash))) {
    // A stale directory may predate a newly owned reward. Never publish a partial
    // inventory while its refresh is in flight (or after an unsuccessful refresh).
    catalog = mergeCatalogs(previous, await getCatalog(catalogAppids, options, true));
    if (parsed.some(({ hash }) => !catalog.get(hash)) && !options.onIncomplete) throw new Error('Incomplete sticker catalog for owned inventory');
  }
  const owned = new Map<string, InventorySticker>();
  for (const { item, name: bareName, hash } of parsed) {
    const definition = catalog.get(hash);
    if (!definition) { unresolved++; continue; }
    const name = definition.name;
    const aliases = [...new Set([hash, bareName, ...definition.aliases])]
      .filter(alias => alias !== name && catalog.get(alias)?.name === name);
    const previous = owned.get(name);
    owned.set(name, {
      name,
      title: definition.title,
      imageUrl: typeof item.icon_url === 'string' && item.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}` : '',
      aliases: [...new Set([...(previous?.aliases ?? []), ...aliases])]
    });
  }
  if (unresolved) options.onIncomplete?.(unresolved);
  return [...owned.values()];
}
