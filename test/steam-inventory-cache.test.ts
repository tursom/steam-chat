import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SteamInventoryCache, type SteamInventory, type SteamInventoryCategory } from '../src/server/steam-inventory-cache';

const { defaultGetEmoticons } = require('../src/server/chat-service');

const A = '76561198000000001';
const B = '76561198000000002';
const items = (name: string): SteamInventory => ({ emoticons: [{ name }], stickers: [{ name: 'sticker' }], effects: [{ name: 'effect' }] });
const empty: SteamInventory = { emoticons: [], stickers: [], effects: [] };
const categories: SteamInventoryCategory[] = ['emoticons', 'stickers', 'effects'];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'steam-inventory-'));
  const caches: SteamInventoryCache[] = [];
  t.after(async () => { await Promise.all(caches.map(cache => cache.close())); await rm(dir, { recursive: true, force: true }); });
  let now = 1_000_000;
  const warnings: unknown[] = [];
  function cache(timeoutMs = 1000) {
    const cache = new SteamInventoryCache({ dir, now: () => now, timeoutMs, logger: { warn: (...args: unknown[]) => { warnings.push(args); } } });
    caches.push(cache);
    return cache;
  }
  return { dir, cache, warnings, advance: (ms: number) => { now += ms; }, now: () => now };
}
async function until(predicate: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('cache did not settle');
}

test('persistent snapshots survive restart, isolate accounts, and whitelist material fields', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  const data = items('wave');
  data.emoticons = [{ name: 'wave', title: 'Wave', imageUrl: 'https://example.test/wave', aliases: ['hello'],
    refreshToken: 'secret', description: { huge: 'payload' }, count: 3 }];
  const result = await cache.get(A, async () => data);
  assert.deepEqual(result.cache, { updatedAt: f.now(), refreshing: false, stale: false, retryAt: 0 });
  const disk = await readFile(join(f.dir, `${A}.json`), 'utf8');
  assert.doesNotMatch(disk, /secret|payload|refreshToken|"count"/);
  assert.deepEqual(result.emoticons, [{ name: 'wave', title: 'Wave', imageUrl: 'https://example.test/wave', aliases: ['hello'] }]);
  await cache.get(B, async () => items('other'));
  await cache.close();
  const restart = f.cache();
  const never = async (): Promise<SteamInventory> => { throw new Error('should not fetch'); };
  assert.deepEqual((await restart.get(A, never)).emoticons, result.emoticons);
  assert.deepEqual((await restart.get(B, never)).emoticons, [{ name: 'other' }]);
  assert.deepEqual((await readdir(f.dir)).sort(), [`${A}.json`, `${B}.json`]);
});

test('expired disk snapshot returns immediately and concurrent reads share one refresh; successful empty replaces it', async t => {
  const f = await fixture(t);
  await f.cache().get(A, async () => items('old'));
  f.advance(600_000);
  const cache = f.cache();
  const upstream = deferred<SteamInventory>();
  let calls = 0;
  const loader = () => { calls++; return upstream.promise; };
  const results = await Promise.all(Array.from({ length: 12 }, () => cache.get(A, loader)));
  assert.equal(calls, 1);
  for (const result of results) {
    assert.deepEqual(result.emoticons, [{ name: 'old' }]);
    assert.equal(result.cache.stale, true);
    assert.equal(result.cache.refreshing, true);
  }
  // The old complete file remains readable throughout the pending refresh.
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8')).emoticons, [{ name: 'old' }]);
  upstream.resolve(empty);
  await until(async () => !(await cache.get(A, loader)).cache.refreshing);
  assert.deepEqual((await cache.get(A, loader)).emoticons, []);
  assert.deepEqual((await f.cache().get(A, loader)).effects, []);
  assert.equal(calls, 1);
});

test('cold concurrent readers await one bounded fetch instead of returning empty inventory', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  const upstream = deferred<SteamInventory>();
  let calls = 0;
  let completed = false;
  const requests = Promise.all(Array.from({ length: 10 }, () => cache.get(A, () => { calls++; return upstream.promise; })));
  void requests.then(() => { completed = true; });
  await until(() => calls === 1);
  assert.equal(completed, false);
  upstream.resolve(items('first'));
  for (const data of await requests) assert.deepEqual(data.emoticons, [{ name: 'first' }]);
  assert.equal(calls, 1);
});

for (let mask = 1; mask < 8; mask++) {
  const failedCategories = categories.filter((_category, index) => mask & (1 << index));
  test(`cold category failures (${failedCategories.join(', ')}) are explicit and never fabricate a complete inventory`, async t => {
    const f = await fixture(t);
    const cache = f.cache();
    let calls = 0;
    const loader = async () => { calls++; return { ...items('available'), failedCategories }; };
    if (failedCategories.length === 3) {
      await assert.rejects(cache.get(A, loader), { statusCode: 503, code: 'ALL_CATEGORIES_FAILED' });
      await assert.rejects(cache.get(A, loader), /all categories failed/);
      assert.deepEqual(await readdir(f.dir), []);
    } else {
      const results = await Promise.all(Array.from({ length: 10 }, () => cache.get(A, loader)));
      for (const result of results) {
        for (const category of categories) {
          assert.deepEqual(result[category], failedCategories.includes(category) ? [] : items('available')[category]);
        }
        assert.deepEqual(result.cache, {
          updatedAt: f.now(), refreshing: false, stale: true, retryAt: f.now() + 30_000, failedCategories
        });
      }
      const disk = JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8'));
      assert.equal(disk.version, 1);
      assert.deepEqual(disk.failedCategories, failedCategories);
      for (const category of categories) assert.deepEqual(disk[category], results[0][category]);
      await cache.get(A, loader);
    }
    assert.equal(calls, 1);
    f.advance(29_999);
    if (failedCategories.length === 3) await assert.rejects(cache.get(A, loader));
    else await cache.get(A, loader);
    assert.equal(calls, 1);
    f.advance(1);
    await cache.get(A, async () => empty);
    await until(async () => !(await cache.get(A, async () => empty)).cache.refreshing);
    const recovered = await cache.get(A, async () => empty);
    for (const category of categories) assert.deepEqual(recovered[category], []);
    assert.equal(recovered.cache.stale, false);
    assert.equal(recovered.cache.retryAt, 0);
    assert.equal(recovered.cache.failedCategories, undefined);
    assert.equal(JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8')).failedCategories, undefined);
  });

  test(`warm category failures (${failedCategories.join(', ')}) retain saved arrays and accept successful empty lists`, async t => {
    const f = await fixture(t);
    const cache = f.cache();
    await cache.get(A, async () => items('saved'));
    f.advance(600_000);
    // Even invalid failed arrays cannot overwrite or invalidate saved category data.
    const partial = { ...empty, failedCategories };
    for (const category of failedCategories) partial[category] = [{ cookie: 'do not persist' }];
    const loader = async () => partial;
    await cache.get(A, loader);
    await until(async () => !(await cache.get(A, loader)).cache.refreshing);
    const result = await cache.get(A, loader);
    assert.deepEqual(result.cache.failedCategories, failedCategories);
    assert.equal(result.cache.stale, true);
    assert.equal(result.cache.retryAt, f.now() + 30_000);
    const disk = JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8'));
    for (const category of categories) {
      const expected = failedCategories.includes(category) ? items('saved')[category] : [];
      assert.deepEqual(result[category], expected);
      assert.deepEqual(disk[category], expected);
    }
    assert.doesNotMatch(JSON.stringify(disk), /cookie|do not persist/);
    const restarted = await f.cache().get(A, async () => { throw new Error('must respect cooldown after restart'); });
    assert.deepEqual(restarted, result);
  });
}

test('partial cold snapshots survive restart, retry at 30s, and merge changing failures from the saved snapshot', async t => {
  const f = await fixture(t);
  const first = f.cache();
  await first.get(A, async () => ({ ...items('first'), failedCategories: ['effects', 'stickers', 'stickers'] }));
  await first.close();
  const cache = f.cache();
  let calls = 0;
  const upstream = deferred<SteamInventory>();
  const loader = (previous: SteamInventory | undefined) => {
    calls++;
    assert.deepEqual(previous, { emoticons: [{ name: 'first' }], stickers: [], effects: [], failedCategories: ['stickers', 'effects'] });
    // Copying failure metadata and arrays must isolate a loader from the live snapshot.
    previous!.failedCategories!.push('emoticons');
    (previous!.emoticons[0] as { name: string }).name = 'mutation';
    return upstream.promise;
  };
  const saved = await cache.get(A, loader);
  assert.equal(calls, 0);
  assert.deepEqual(saved.cache.failedCategories, ['stickers', 'effects']);
  assert.equal(saved.cache.stale, true);
  assert.equal(saved.cache.retryAt, f.now() + 30_000);
  saved.cache.failedCategories!.push('emoticons');
  f.advance(29_999);
  assert.deepEqual((await cache.get(A, loader)).cache.failedCategories, ['stickers', 'effects']);
  assert.equal(calls, 0);
  f.advance(1);
  const readers = await Promise.all(Array.from({ length: 10 }, () => cache.get(A, loader)));
  assert.equal(calls, 1);
  for (const result of readers) {
    assert.deepEqual(result.emoticons, [{ name: 'first' }]);
    assert.equal(result.cache.refreshing, true);
  }
  upstream.resolve({ ...items('ignored'), stickers: [{ name: 'second-sticker' }], effects: [{ name: 'second-effect' }], failedCategories: ['emoticons'] });
  await until(async () => !(await cache.get(A, loader)).cache.refreshing);
  const updated = await cache.get(A, loader);
  assert.deepEqual(updated.emoticons, [{ name: 'first' }]);
  assert.deepEqual(updated.stickers, [{ name: 'second-sticker' }]);
  assert.deepEqual(updated.effects, [{ name: 'second-effect' }]);
  assert.deepEqual(updated.cache.failedCategories, ['emoticons']);
  assert.equal(updated.cache.retryAt, f.now() + 30_000);
  assert.deepEqual(await f.cache().get(A, loader), updated);
});

test('old version 1 complete snapshots load without failure metadata or refresh', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, `${A}.json`), JSON.stringify({ version: 1, account: A, updatedAt: f.now(), ...items('legacy') }));
  const result = await f.cache().get(A, async () => { throw new Error('must not refresh'); });
  assert.deepEqual(result.emoticons, [{ name: 'legacy' }]);
  assert.deepEqual(result.cache, { updatedAt: f.now(), refreshing: false, stale: false, retryAt: 0 });
});

test('expired partial snapshots retry immediately after restart rather than waiting for the full TTL', async t => {
  const f = await fixture(t);
  await f.cache().get(A, async () => ({ ...items('partial'), failedCategories: ['effects'] }));
  f.advance(30_000);
  const cache = f.cache();
  let calls = 0;
  const loader = async () => { calls++; return items('recovered'); };
  const previous = await cache.get(A, loader);
  assert.equal(previous.cache.stale, true);
  assert.equal(previous.cache.refreshing, true);
  await until(async () => !(await cache.get(A, loader)).cache.refreshing);
  const result = await cache.get(A, loader);
  assert.equal(calls, 1);
  assert.equal(result.cache.stale, false);
  assert.equal(result.cache.failedCategories, undefined);
});

test('refresh errors and incomplete payloads keep last snapshot with a 30s retry', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  await cache.get(A, async () => items('old'));
  const original = await readFile(join(f.dir, `${A}.json`), 'utf8');
  const failures: Array<Error | Partial<SteamInventory>> = [new Error('credential-bearing upstream error'),
    { ...empty, complete: false }, { ...empty, complete: false, failedCategories: ['stickers'] }, { emoticons: [], stickers: [] },
    { ...empty, failedCategories: ['stickers', 'cookie=secret'] } as unknown as SteamInventory,
    { ...empty, failedCategories: 'stickers' } as unknown as SteamInventory,
    { ...empty, failedCategories: null } as unknown as SteamInventory];
  for (const failure of failures) {
    f.advance(600_000);
    let calls = 0;
    const loader = async () => { calls++; if (failure instanceof Error) throw failure; return failure as SteamInventory; };
    assert.deepEqual((await cache.get(A, loader)).emoticons, [{ name: 'old' }]);
    await until(async () => !(await cache.get(A, loader)).cache.refreshing);
    const data = await cache.get(A, loader);
    assert.equal(data.cache.retryAt, f.now() + 30_000);
    assert.equal(data.cache.stale, true);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(f.dir, `${A}.json`), 'utf8'), original);
    f.advance(29_999);
    await cache.get(A, loader);
    assert.equal(calls, 1);
  }
  assert.doesNotMatch(JSON.stringify(f.warnings), /credential-bearing/);
  f.advance(30_000);
  await cache.get(A, async () => empty);
  await until(async () => !(await cache.get(A, async () => empty)).cache.refreshing);
  assert.deepEqual((await cache.get(A, async () => empty)).emoticons, []);
});

test('safe diagnostics identify stages and only accept exact allowlisted upstream codes', async t => {
  const f = await fixture(t);
  const cache = f.cache(5);
  const secret = 'sessionid=private-cookie';
  for (const code of ['CATALOG', 'COMMUNITY_INVENTORY', `CATALOG ${secret}`]) {
    await assert.rejects(cache.get(A, async () => { throw Object.assign(new Error(secret), { code, cookies: [secret] }); }));
    assert.match(String(f.warnings.at(-1)), new RegExp(`stage=fetch code=${code.includes(secret) ? 'UNKNOWN' : code}`));
    f.advance(30_000);
  }
  await assert.rejects(cache.get(A, async () => ({ ...empty, complete: false, failedCategories: ['effects'] })));
  assert.match(String(f.warnings.at(-1)), /stage=validate code=INCOMPLETE/);
  f.advance(30_000);
  await assert.rejects(cache.get(A, () => new Promise(() => {})), /timed out/);
  assert.match(String(f.warnings.at(-1)), /stage=fetch code=TIMEOUT/);
  f.advance(30_000);
  await cache.get(A, async () => ({ ...items('ok'), failedCategories: ['effects'] }));
  assert.match(String(f.warnings.at(-1)), /stage=partial failedCategories=effects/);
  assert.doesNotMatch(JSON.stringify(f.warnings), /sessionid|private-cookie|cookies|stack/);
});

test('cold failures are real errors, timeouts discard late results, and stop settles a hung refresh', async t => {
  const f = await fixture(t);
  const cache = f.cache(15);
  const slow = deferred<SteamInventory>();
  await assert.rejects(cache.get(A, () => slow.promise), /timed out/);
  slow.resolve(items('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await readdir(f.dir), []);
  await assert.rejects(cache.get(A, async () => empty), /timed out/);
  f.advance(30_000);
  assert.deepEqual((await cache.get(A, async () => empty)).emoticons, []);
  const hung = deferred<SteamInventory>();
  const started = deferred<void>();
  const cold = cache.get(B, () => { started.resolve(); return hung.promise; });
  const rejection = assert.rejects(cold, /stopped/);
  await started.promise;
  await cache.close();
  await rejection;
  hung.reject(new Error('late rejection is consumed'));
  await assert.rejects(cache.get(A, async () => empty), /stopped/);
});

test('damaged, wrong-scope, and invalid disk snapshots diagnose then refetch', async t => {
  const f = await fixture(t);
  for (const content of ['{', JSON.stringify({ version: 1, account: B, updatedAt: f.now(), ...empty }),
    JSON.stringify({ version: 1, account: A, updatedAt: f.now(), emoticons: [], stickers: [] }),
    JSON.stringify({ version: 1, account: A, updatedAt: f.now(), ...empty, failedCategories: ['unknown-cookie'] })]) {
    await writeFile(join(f.dir, `${A}.json`), content);
    const cache = f.cache();
    let calls = 0;
    assert.deepEqual((await cache.get(A, async () => { calls++; return items('recovered'); })).emoticons, [{ name: 'recovered' }]);
    assert.equal(calls, 1);
    await cache.close();
  }
  assert.equal(f.warnings.length, 4);
  assert.match(String(f.warnings[0]), /stage=load code=UNKNOWN/);
  assert.match(String(f.warnings[1]), /stage=load code=INVALID_SNAPSHOT/);
  assert.doesNotMatch(JSON.stringify(f.warnings), /unknown-cookie/);
});

test('disk write failure preserves previous complete snapshot and identity-free helpers never write files', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  await cache.get(A, async () => items('old'));
  const original = await readFile(join(f.dir, `${A}.json`), 'utf8');
  const blocker = join(f.dir, 'not-a-directory');
  await writeFile(blocker, 'blocked');
  const broken = new SteamInventoryCache({ dir: blocker, now: f.now,
    logger: { warn: (...args: unknown[]) => { f.warnings.push(args); } } });
  await assert.rejects(broken.get(A, async () => empty));
  assert.match(String(f.warnings.at(-1)), /stage=persist code=(ENOTDIR|UNKNOWN)/);
  await broken.close();
  assert.equal(await readFile(join(f.dir, `${A}.json`), 'utf8'), original);
  const before = await readdir(f.dir);
  assert.deepEqual((await cache.get(undefined, async () => empty)).emoticons, []);
  assert.deepEqual(await readdir(f.dir), before);
});

test('default loader cold community failure still serves and persists successful emoticons', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  const loader = () => defaultGetEmoticons({
    steamUser: { steamID: A, getEmoticonList: async () => ({ emoticons: [{ name: 'wave' }] }) },
    steamCommunity: { getUserInventoryContents: (_id: unknown, _app: unknown, _context: unknown, _tradable: unknown,
      callback: (error: Error) => void) => callback(new Error('sessionid=secret')) }
  });
  const result = await cache.get(A, loader);
  assert.deepEqual(result.emoticons, [{ name: 'wave' }]);
  assert.deepEqual(result.stickers, []);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.cache.failedCategories, ['stickers', 'effects']);
  assert.equal(result.cache.stale, true);
  assert.equal(result.cache.retryAt, f.now() + 30_000);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8')).failedCategories, ['stickers', 'effects']);
  assert.doesNotMatch(JSON.stringify(f.warnings), /sessionid|secret/);
});

for (const paginated of [false, true]) {
  test(`missing SDK descriptions preserve sticker/effect snapshots and accept emoticons (${paginated ? 'paginated' : 'single page'})`, async t => {
    const f = await fixture(t);
    const cache = f.cache();
    await cache.get(A, async () => items('old'));
    f.advance(600_000);
    let catalogCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => { catalogCalls++; throw new Error('must not fetch catalog'); });
    const community = new (require('steamcommunity'))();
    const pages: unknown[] = [];
    community.httpRequest = (options: { qs: { start_assetid?: string } }, callback: (error: unknown, response: unknown, body: unknown) => void) => {
      pages.push(options.qs.start_assetid);
      const described = paginated && !options.qs.start_assetid;
      queueMicrotask(() => callback(null, {}, {
        success: 1, total_inventory_count: paginated ? 2 : 1, more_items: described, last_assetid: '10',
        assets: [{ assetid: described ? '10' : '20', appid: 753,
          classid: described ? '1' : '2', instanceid: '0', amount: '1' }],
        descriptions: described ? [{ classid: '1', instanceid: '0', name: 'Cat Cam talking',
          market_hash_name: '637310-Cat Cam talking',
          tags: [{ category: 'item_class', internal_name: 'item_class_11' }] }] : []
      }));
    };
    const loader = () => defaultGetEmoticons({ steamUser: {
      steamID: A, getEmoticonList: async () => ({ emoticons: [{ name: 'fresh' }] })
    }, steamCommunity: community });
    assert.deepEqual((await cache.get(A, loader)).emoticons, [{ name: 'old' }]);
    await until(async () => !(await cache.get(A, loader)).cache.refreshing);
    const retained = await cache.get(A, loader);
    assert.deepEqual({ emoticons: retained.emoticons, stickers: retained.stickers, effects: retained.effects }, items('fresh'));
    assert.deepEqual(retained.cache.failedCategories, ['stickers', 'effects']);
    assert.equal(retained.cache.stale, true);
    assert.equal(retained.cache.retryAt, f.now() + 30_000);
    assert.deepEqual(pages, paginated ? [undefined, '10'] : [undefined]);
    assert.equal(catalogCalls, 0);
    const persisted = JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8'));
    assert.deepEqual(persisted.emoticons, [{ name: 'fresh' }]);
    assert.deepEqual(persisted.stickers, items('old').stickers);
    assert.deepEqual(persisted.effects, items('old').effects);
    assert.deepEqual(persisted.failedCategories, ['stickers', 'effects']);
    // An SDK-confirmed empty ownership response is still allowed to replace it.
    f.advance(30_000);
    community.httpRequest = (_options: unknown, callback: (error: unknown, response: unknown, body: unknown) => void) => {
      queueMicrotask(() => callback(null, {}, { success: 1, total_inventory_count: 0 }));
    };
    await cache.get(A, loader);
    await until(async () => !(await cache.get(A, loader)).cache.refreshing);
    assert.deepEqual((await cache.get(A, loader)).stickers, []);
    assert.deepEqual((await cache.get(A, loader)).effects, []);
    assert.equal((await cache.get(A, loader)).cache.failedCategories, undefined);
  });
}

test('retired aliases restore from disk after restart and changed appids without reviving lost ownership', async t => {
  const f = await fixture(t);
  const definitions = [
    { appid: 637310, community_item_class: 11, community_item_type: 37, internal_description: 'Cat talking',
      community_item_data: { item_name: 'Cat Cam talking', item_title: 'Cat Cam talking' } },
    { appid: 2022180, community_item_class: 11, community_item_type: 24, internal_description: 'catchheart',
      community_item_data: { item_name: 'CatchHeart', item_title: 'CatchHeart' } }
  ];
  let owned = ['637310-Cat Cam talking (Sticker)-37'];
  const community = new (require('steamcommunity'))();
  community.httpRequest = (_options: unknown, callback: (error: unknown, response: unknown, body: unknown) => void) => {
    queueMicrotask(() => callback(null, {}, {
      success: 1, total_inventory_count: owned.length,
      assets: owned.map((_hash, i) => ({ assetid: String(i + 1), appid: 753, classid: String(i + 1), instanceid: '0', amount: '1' })),
      descriptions: owned.map((hash, i) => ({ classid: String(i + 1), instanceid: '0', name: 'Localized title',
        market_hash_name: hash, tags: [{ category: 'item_class', internal_name: 'item_class_11' }] }))
    }));
  };
  const loader = (previousInventory: SteamInventory | undefined) => defaultGetEmoticons({
    steamUser: { steamID: A }, steamCommunity: community, previousInventory
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ response: { definitions: [definitions[0]], total_count: 1 } }));
  const first = f.cache();
  assert.deepEqual((await first.get(A, loader)).stickers.map(value => (value as { name: string }).name), ['Cat talking']);
  await first.close();
  f.advance(600_000);
  owned.push('2022180-CatchHeart');
  const filters: unknown[] = [];
  // New fetch identity also discards the old in-process catalog, as at process restart.
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    filters.push(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids);
    return Response.json({ response: { definitions: [definitions[1]], total_count: 1 } });
  });
  const restarted = f.cache();
  await restarted.get(A, loader);
  await until(async () => !(await restarted.get(A, loader)).cache.refreshing);
  const updated = await restarted.get(A, loader);
  assert.equal(updated.cache.stale, false);
  assert.deepEqual(updated.stickers.map(value => (value as { name: string }).name), ['Cat talking', 'catchheart']);
  assert.deepEqual(filters, [[637310, 2022180]]);
  const persisted = JSON.parse(await readFile(join(f.dir, `${A}.json`), 'utf8'));
  assert.deepEqual(persisted.stickers, updated.stickers);
  assert.ok(persisted.stickers[0].aliases.includes('637310-Cat Cam talking (Sticker)-37'));
  f.advance(600_000);
  owned = ['2022180-CatchHeart'];
  await restarted.get(A, loader);
  await until(async () => !(await restarted.get(A, loader)).cache.refreshing);
  assert.deepEqual((await restarted.get(A, loader)).stickers.map(value => (value as { name: string }).name), ['catchheart']);
});

test('previous inventory callbacks receive copied complete snapshots scoped to their account', async t => {
  const f = await fixture(t);
  const cache = f.cache();
  await cache.get(A, async previous => { assert.equal(previous, undefined); return items('A'); });
  await cache.get(B, async previous => { assert.equal(previous, undefined); return items('B'); });
  f.advance(600_000);
  const original = await readFile(join(f.dir, `${A}.json`), 'utf8');
  let receivedA: SteamInventory | undefined;
  await cache.get(A, async previous => {
    receivedA = structuredClone(previous);
    (previous!.emoticons[0] as { name: string }).name = 'mutation';
    previous!.stickers.push({ name: 'unverified' });
    throw new Error('failed refresh');
  });
  await until(async () => !(await cache.get(A, async () => empty)).cache.refreshing);
  assert.deepEqual(receivedA, items('A'));
  assert.deepEqual((await cache.get(A, async () => empty)).emoticons, [{ name: 'A' }]);
  assert.equal(await readFile(join(f.dir, `${A}.json`), 'utf8'), original);
  let receivedB: SteamInventory | undefined;
  await cache.get(B, async previous => { receivedB = previous; return empty; });
  await until(async () => !(await cache.get(B, async () => empty)).cache.refreshing);
  assert.deepEqual(receivedB, items('B'));
  assert.deepEqual((await cache.get(B, async () => empty)).emoticons, []);
});
