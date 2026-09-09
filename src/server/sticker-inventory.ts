import { isRecord } from '../types';

export type InventorySticker = {
  name: string;
  title: string;
  imageUrl: string;
  aliases: string[];
};

export type StickerInventoryOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type Definition = { name: string; title: string; aliases: string[] };
type Catalog = Map<string, Definition | null>;
type CacheEntry = { expires: number; promise: Promise<Catalog> };
const caches = new WeakMap<typeof fetch, Map<string, CacheEntry>>();
const MAX_FILTERED_APPS = 32;
const MAX_PAGES = 4;
const MAX_CACHE_ENTRIES = 64;
const TIMEOUT_MS = 4000;
const safeName = (name: string): boolean => Boolean(name.trim()) && name.length <= 512 && !/[\[\]"\\\x00-\x1f\x7f]/.test(name);

function addDefinition(catalog: Catalog, value: unknown, appids: Set<number>): void {
  const appid = isRecord(value) ? Number(value.appid) : NaN;
  if (!isRecord(value) || !Number.isSafeInteger(appid) || appid <= 0 || appid > 0xffffffff ||
      (appids.size > 0 && !appids.has(appid)) || Number(value.community_item_class) !== 11 ||
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
    return [label, `${appid}-${label}`, decorated, `${appid}-${decorated}`];
  }))];
  const definition = { name, title, aliases };
  for (const alias of aliases) {
    const previous = catalog.get(alias);
    // Conflicting authoritative names must not silently pick the last definition.
    catalog.set(alias, previous === null || (previous && previous.name !== name) ? null : definition);
  }
}

async function fetchCatalog(appids: number[], fetchImpl: typeof fetch, timeoutMs: number): Promise<Catalog> {
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
          appids, community_item_classes: [11], count: 1000, language: 'english', ...(cursor ? { cursor } : {})
        }));
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Sticker catalog HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.response)) throw new Error('Invalid sticker catalog');
        if (body.response.count === 0 && !body.response.definitions) break;
        if (!Array.isArray(body.response.definitions)) throw new Error('Invalid sticker catalog');
        const definitions = body.response.definitions.slice(0, 1000);
        for (const definition of definitions) addDefinition(catalog, definition, allowed);
        received += definitions.length;
        const total = body.response.total_count;
        if (!definitions.length || (typeof total === 'number' && total >= 0 && received >= total)) break;
        const next = body.response.next_cursor;
        if (typeof next !== 'string' || !next || next === '0' || cursors.has(next)) break;
        cursors.add(next);
        cursor = next;
      }
      return catalog;
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

function getCatalog(appids: number[], options: StickerInventoryOptions): Promise<Catalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let cache = caches.get(fetchImpl);
  if (!cache) caches.set(fetchImpl, cache = new Map());
  const timeoutMs = Math.max(1, Math.min(TIMEOUT_MS, options.timeoutMs || TIMEOUT_MS));
  const key = `${appids.join(',')}:${timeoutMs}`;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry: CacheEntry = { expires: Infinity, promise: Promise.resolve(new Map()) };
  entry.promise = fetchCatalog(appids, fetchImpl, timeoutMs).then(catalog => {
    entry.expires = Date.now() + 10 * 60_000;
    return catalog;
  }, () => {
    // Fail closed until authoritative protocol names can be loaded again.
    entry.expires = Date.now() + 30_000;
    return new Map();
  });
  cache.set(key, entry);
  return entry.promise;
}

/** Historical messages may lack the app prefix, so their aliases use the public catalog. */
export async function resolveStickerAlias(type: string, options: StickerInventoryOptions = {}): Promise<string | undefined> {
  if (!safeName(type)) return undefined;
  const catalog = await getCatalog([], options);
  return catalog.get(type)?.name;
}

/** Resolve owned community inventory items; never derive decorated types by suffix stripping. */
export async function resolveStickerInventory(inventory: unknown[], options: StickerInventoryOptions = {}): Promise<InventorySticker[]> {
  const items = inventory.filter(isRecord).filter(item => Array.isArray(item.tags) && item.tags.some(tag =>
    isRecord(tag) && tag.category === 'item_class' && tag.internal_name === 'item_class_11'));
  const parsed = items.flatMap(item => {
    if (typeof item.market_hash_name !== 'string') return [];
    const match = /^(\d+)-(.+)$/.exec(item.market_hash_name);
    const name = match ? match[2]! : item.market_hash_name;
    const appid = match ? Number(match[1]) : 0;
    if (!safeName(name) || (match && (!Number.isSafeInteger(appid) || appid <= 0 || appid > 0xffffffff))) return [];
    return [{ item, name, appid, hash: item.market_hash_name }];
  });
  if (!parsed.length) return [];
  const appids = [...new Set(parsed.filter(item => item.appid).map(item => item.appid))]
    .sort((a, b) => a - b);
  // Large inventories and unprefixed aliases use the bounded public catalog, not a truncated app list.
  const catalog = await getCatalog(appids.length > MAX_FILTERED_APPS || parsed.some(item => !item.appid)
    ? [] : appids, options);
  const owned = new Map<string, InventorySticker>();
  for (const { item, name: bareName, hash } of parsed) {
    const definition = catalog.get(hash);
    if (!definition) continue;
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
  return [...owned.values()];
}
