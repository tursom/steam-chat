import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStickerAlias, resolveStickerInventory } from '../src/server/sticker-inventory';

// Relevant fields preserved from public /tmp/sticker-definitions-2.json and -3.json.
const fixtures = [
  { appid: 400910, defid: 264296, community_item_class: 11, community_item_type: 50,
    internal_description: ':rbrb_rumi_sigh:',
    community_item_data: { item_name: 'Rumi : Why...?', item_title: 'Rumi : Why...?' } },
  { appid: 400910, defid: 264297, community_item_class: 11, community_item_type: 51,
    internal_description: ':rbrb_kotri_what:',
    community_item_data: { item_name: 'Kotri : Is...is that true?', item_title: 'Kotri : Is...is that true?' } },
  { appid: 2022180, defid: 198707, community_item_class: 11, community_item_type: 24,
    internal_description: 'catchheart',
    community_item_data: { item_name: 'CatchHeart', item_title: 'CatchHeart' } },
  { appid: 2022180, defid: 198706, community_item_class: 11, community_item_type: 23,
    internal_description: 'unhappy',
    community_item_data: { item_name: 'Unhappy', item_title: 'Unhappy' } },
  { appid: 1203420, defid: 153568, community_item_class: 11, community_item_type: 28,
    internal_description: 'show love',
    community_item_data: { item_name: 'Show Love', item_title: 'Show Love' } },
  { appid: 637310, defid: 103182, community_item_class: 11, community_item_type: 37,
    internal_description: 'Cat talking',
    community_item_data: { item_name: 'Cat Cam talking', item_title: 'Cat Cam talking' } }
];
const talking = fixtures[5]!;
const item = (hash = '637310-Cat Cam talking (Sticker)-37') => ({
  appid: 753, market_hash_name: hash, name: 'Localized inventory title', icon_url: 'inventory/hash',
  tags: [{ category: 'item_class', internal_name: 'item_class_11' }]
});
const response = (definitions: unknown[], next_cursor = '') => Response.json({
  response: { definitions, count: definitions.length, total_count: definitions.length, next_cursor }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controlledCatalog() {
  let time = 1_000;
  let calls = 0;
  const requests: ReturnType<typeof deferred<Response>>[] = [];
  const fetchImpl: typeof fetch = async () => {
    calls++;
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  };
  return {
    options: { fetchImpl, now: () => time }, requests,
    get calls() { return calls; },
    advance(ms: number) { time += ms; }
  };
}

const settleRefresh = () => new Promise<void>(resolve => setImmediate(resolve));

for (const fixture of fixtures) {
  test(`real definition ${fixture.defid} preserves protocol identifier exactly`, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async input => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname,
        'https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/');
      assert.deepEqual(JSON.parse(url.searchParams.get('input_json')!), {
        appids: [fixture.appid], community_item_classes: [11], count: 1000, language: 'english', include_direct_purchase_disabled: true
      });
      return response([fixture]);
    };
    const title = fixture.community_item_data.item_name;
    const decorated = `${title} (Sticker)-${fixture.community_item_type}`;
    // Bare market titles must trigger lookup even without any decorated inventory.
    const bare = await resolveStickerInventory([item(`${fixture.appid}-${title}`)], { fetchImpl });
    const result = await resolveStickerInventory([
      item(`${fixture.appid}-${decorated}`), item(`${fixture.appid}-${title}`),
      item(`${fixture.appid}-${fixture.internal_description}`)
    ], { fetchImpl });
    assert.equal(calls, 1);
    assert.equal(result.length, 1);
    assert.equal(bare[0]!.name, fixture.internal_description);
    assert.equal(result[0]!.name, fixture.internal_description);
    assert.equal(result[0]!.title, title);
    assert.equal(result[0]!.imageUrl, 'https://community.cloudflare.steamstatic.com/economy/image/inventory/hash');
    for (const alias of [title, decorated, `${fixture.appid}-${title}`, `${fixture.appid}-${decorated}`]) {
      assert.ok(result[0]!.aliases.includes(alias));
    }
  });
}

test('historical plain and decorated titles resolve through the global catalog', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async input => {
    calls++;
    assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids, []);
    return response(fixtures, 'nonempty-final-cursor');
  };
  for (const fixture of fixtures) {
    const title = fixture.community_item_data.item_name;
    for (const alias of [title, `${fixture.appid}-${title}`, `${title} (Sticker)-${fixture.community_item_type}`]) {
      assert.equal(await resolveStickerAlias(alias, { fetchImpl }), fixture.internal_description);
    }
  }
  assert.equal(await resolveStickerAlias('rbrb_rumi_sigh', { fetchImpl }), undefined);
  assert.equal(await resolveStickerAlias('unknown', { fetchImpl }), undefined);
  assert.equal(await resolveStickerAlias('[unsafe]', { fetchImpl }), undefined);
  assert.equal(calls, 1);
});

test('unknown, invalid and cross-app metadata cannot establish canonical identifiers', async () => {
  for (const definitions of [[], [{ ...talking, appid: 999 }], [{ ...talking, community_item_class: 1 }],
    [{ ...talking, internal_description: undefined }], [{ ...talking, internal_description: '' }],
    [{ ...talking, internal_description: '[unsafe]' }], [{ ...talking, community_item_type: 0 }]]) {
    await assert.rejects(resolveStickerInventory([item()], { fetchImpl: async () => response(definitions) }),
      /Incomplete sticker catalog/);
  }
});

test('unprefixed inventory uses authoritative global aliases', async () => {
  const result = await resolveStickerInventory([item('Cat Cam talking'), item('Cat talking')], {
    fetchImpl: async input => {
      assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids, []);
      return response([talking]);
    }
  });
  assert.deepEqual(result.map(sticker => sticker.name), ['Cat talking']);
});

test('all owned appids, including bare titles, are queried in sorted order', async () => {
  await resolveStickerInventory([item(), item('1203420-Show Love'), item('2022180-Unhappy')], {
    fetchImpl: async input => {
      assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids,
        [637310, 1203420, 2022180]);
      return response(fixtures);
    }
  });
});

test('large inventories require complete global pagination without dropping later apps', async () => {
  let calls = 0;
  const result = await resolveStickerInventory(Array.from({ length: 40 }, (_, i) => item(`${i + 1}-Cat Cam talking`)), {
    fetchImpl: async input => {
      assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids, []);
      const start = calls++ * 20;
      return Response.json({ response: {
        definitions: Array.from({ length: 20 }, (_, i) => ({ ...talking, appid: start + i + 1 })),
        count: 20, total_count: 40, next_cursor: calls === 1 ? 'second' : '' } });
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.map(sticker => sticker.name), ['Cat talking']);
  assert.ok(result[0]!.aliases.includes('40-Cat Cam talking'));
});

test('catalog follows cursors and coalesces concurrent and cached lookups', async () => {
  const cursors: unknown[] = [];
  const fetchImpl: typeof fetch = async input => {
    const query = JSON.parse(new URL(String(input)).searchParams.get('input_json')!);
    cursors.push(query.cursor);
    return Response.json({ response: { definitions: [query.cursor ? talking : { ...talking, community_item_class: 1 }],
      count: 1, total_count: 2, next_cursor: query.cursor ? '' : 'second' } });
  };
  const [first, second] = await Promise.all([
    resolveStickerInventory([item()], { fetchImpl }), resolveStickerInventory([item()], { fetchImpl })
  ]);
  assert.deepEqual(first, second);
  assert.equal(first[0]!.name, 'Cat talking');
  assert.deepEqual(await resolveStickerInventory([item()], { fetchImpl }), first);
  assert.deepEqual(cursors, [undefined, 'second']);
});

test('repeated cursor rejects incomplete pagination', async () => {
  let calls = 0;
  await assert.rejects(resolveStickerInventory([item()], { fetchImpl: async () => {
    calls++;
    return Response.json({ response: { definitions: [talking], count: 1, total_count: 100, next_cursor: 'same' } });
  } }), /Incomplete sticker catalog pagination/);
  assert.equal(calls, 2);
});

test('HTTP and malformed first loads reject inventory and are briefly cached', async () => {
  for (const reply of [() => new Response('', { status: 503 }), () => Response.json({ response: {} })]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return reply(); };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(resolveStickerInventory([item(), item('570-show love')], { fetchImpl }), /catalog/);
    }
    assert.equal(calls, 1);
  }
});

test('timeout bounds fetch and JSON body reads even when injected fetch ignores abort', async () => {
  for (const bodyHang of [false, true]) {
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      if (!bodyHang) return new Promise<Response>(() => {});
      const result = response([]);
      result.json = () => new Promise(() => {});
      return result;
    };
    await assert.rejects(resolveStickerInventory([item(), item('570-show love')], { fetchImpl, timeoutMs: 10 }), /timed out/);
    assert.equal(signal?.aborted, true);
  }
});

test('authoritative internal_description may itself contain a decorated suffix', async () => {
  const name = 'Cat Cam talking (Sticker)-37';
  const result = await resolveStickerInventory([item(`637310-${name} (Sticker)-42`)], {
    fetchImpl: async () => response([{ ...talking, internal_description: name, community_item_type: 42,
      community_item_data: { item_name: name, item_title: 'Different display title' } }])
  });
  assert.equal(result[0]!.name, name);
  assert.equal(result[0]!.title, 'Different display title');
  assert.equal(await resolveStickerAlias('Different display title', {
    fetchImpl: async () => response([{ ...talking, community_item_data: {
      item_name: 'Cat Cam talking', item_title: 'Different display title'
    } }])
  }), 'Cat talking');
});

test('conflicting aliases are omitted from resolution and returned inventory aliases in either order', async () => {
  const conflict = { ...talking, community_item_type: 99, internal_description: 'Other protocol name' };
  for (const definitions of [[talking, conflict], [conflict, talking]]) {
    const fetchImpl: typeof fetch = async () => response(definitions);
    await assert.rejects(resolveStickerInventory([item('637310-Cat Cam talking')], { fetchImpl }), /Incomplete sticker catalog/);
    assert.equal(await resolveStickerAlias('Cat Cam talking', { fetchImpl }), undefined);
    const result = await resolveStickerInventory([item()], { fetchImpl });
    assert.equal(result[0]!.name, 'Cat talking');
    assert.ok(!result[0]!.aliases.includes('Cat Cam talking'));
    assert.ok(!result[0]!.aliases.includes('637310-Cat Cam talking'));
  }
});

test('owned event rewards include purchase-disabled definitions and plain Sticker suffixes', async () => {
  const event = { appid: 2640290, community_item_class: 11, community_item_type: 1,
    internal_description: 'Stick Back and Relax 2023',
    community_item_data: { item_name: 'Sit Back and Relax 2023' } };
  const retro = { appid: 1239690, community_item_class: 11, community_item_type: 1,
    internal_description: 'Retrowave', community_item_data: { item_name: 'Retrowave' } };
  const fetchImpl: typeof fetch = async input => {
    const query = JSON.parse(new URL(String(input)).searchParams.get('input_json')!);
    return response(query.include_direct_purchase_disabled ? [event, retro] : [retro]);
  };
  const result = await resolveStickerInventory([
    item('2640290-Sit Back and Relax 2023'), item('1239690-Retrowave (Sticker)')
  ], { fetchImpl });
  assert.deepEqual(result.map(x => x.name), ['Stick Back and Relax 2023', 'Retrowave']);
  assert.equal(await resolveStickerAlias('1239690-Retrowave (Sticker)', { fetchImpl }), 'Retrowave');
});

test('chat effects use their own inventory class and catalog cache', async () => {
  const effect = { appid: 1195690, community_item_class: 12, community_item_type: 1,
    internal_description: 'snow', community_item_data: { item_name: 'Snow', item_title: 'Snow' } };
  const classes: number[] = [];
  const fetchImpl: typeof fetch = async input => {
    const query = JSON.parse(new URL(String(input)).searchParams.get('input_json')!);
    classes.push(query.community_item_classes[0]);
    return response([effect]);
  };
  const inventory = [{ ...item('1195690-Snow'), tags: [{ category: 'item_class', internal_name: 'item_class_12' }] }];
  const effects = await resolveStickerInventory(inventory, { fetchImpl, itemClass: 12 });
  assert.deepEqual(effects.map(x => x.name), ['snow']);
  assert.deepEqual(await resolveStickerInventory(inventory, { fetchImpl }), []);
  assert.equal(await resolveStickerAlias('1195690-Snow', { fetchImpl }), undefined);
  assert.deepEqual(classes, [12, 11]);
});

test('expired catalogs serve old inventory during a shared refresh and merge retired definitions', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  const old = await initial;
  clock.advance(10 * 60_000);

  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  assert.equal(clock.calls, 2);

  const added = { ...talking, community_item_type: 38, internal_description: 'new protocol',
    community_item_data: { item_name: 'New reward' } };
  let completed = false;
  const newer = resolveStickerInventory([item(), item('637310-New reward')], clock.options)
    .then(result => { completed = true; return result; });
  await settleRefresh();
  assert.equal(completed, false);
  assert.equal(clock.calls, 2);
  clock.requests[1]!.resolve(response([added]));
  assert.deepEqual((await newer).map(x => x.name), ['Cat talking', 'new protocol']);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
});

test('failed refresh retains old data across cooldown and retries with concurrent callers', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  const old = await initial;
  clock.advance(10 * 60_000);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  clock.requests[1]!.reject(new Error('offline'));
  await settleRefresh();
  clock.advance(29_999);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  assert.equal(clock.calls, 2);
  clock.advance(1);
  const results = await Promise.all(Array.from({ length: 5 }, () => resolveStickerInventory([item()], clock.options)));
  for (const result of results) assert.deepEqual(result, old);
  assert.equal(clock.calls, 3);
  clock.requests[2]!.resolve(response([]));
  await settleRefresh();
  // Even a successful empty directory does not erase known retired rewards.
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
});

test('first-load failures coalesce, reject through cooldown and recover after retry', async () => {
  const clock = controlledCatalog();
  const first = assert.rejects(resolveStickerInventory([item()], clock.options), /offline/);
  const second = assert.rejects(resolveStickerInventory([item()], clock.options), /offline/);
  assert.equal(clock.calls, 1);
  clock.requests[0]!.reject(new Error('offline'));
  await Promise.all([first, second]);
  await assert.rejects(resolveStickerInventory([item()], clock.options), /offline/);
  assert.equal(clock.calls, 1);
  clock.advance(30_000);
  const retry = resolveStickerInventory([item()], clock.options);
  clock.requests[1]!.resolve(response([talking]));
  assert.deepEqual((await retry).map(x => x.name), ['Cat talking']);
});

test('unknown owned items never produce a partial inventory during or after failed refresh', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  const old = await initial;
  const inventory = [item(), item('637310-New reward')];
  await assert.rejects(resolveStickerInventory(inventory, clock.options), /Incomplete sticker catalog/);
  assert.equal(clock.calls, 1);
  clock.advance(10 * 60_000);
  const refreshing = assert.rejects(resolveStickerInventory(inventory, clock.options), /Incomplete sticker catalog/);
  await settleRefresh();
  clock.requests[1]!.reject(new Error('offline'));
  await refreshing;
  await assert.rejects(resolveStickerInventory(inventory, clock.options), /Incomplete sticker catalog/);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  assert.equal(clock.calls, 2);
});

test('a complete refresh still missing owned items rejects rather than returning a partial list', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  await initial;
  clock.advance(10 * 60_000);
  const missing = assert.rejects(resolveStickerInventory([item(), item('637310-New reward')], clock.options),
    /Incomplete sticker catalog/);
  clock.requests[1]!.resolve(response([talking]));
  await missing;
});

test('genuinely empty owned inventory succeeds without fetching, even during catalog failure', async () => {
  let calls = 0;
  const options = { fetchImpl: (async () => { calls++; throw new Error('offline'); }) as typeof fetch };
  for (const inventory of [[], [{ ...item(), tags: [{ category: 'item_class', internal_name: 'item_class_2' }] }], [{ ...item(),
    tags: [{ category: 'item_class', internal_name: 'item_class_12' }] }]]) {
    assert.deepEqual(await resolveStickerInventory(inventory, options), []);
  }
  assert.equal(calls, 0);
  await assert.rejects(resolveStickerInventory([item()], options), /offline/);
  assert.deepEqual(await resolveStickerInventory([], options), []);
  assert.equal(calls, 1);
});

test('malformed owned names cannot silently disappear from an inventory', async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error('must not fetch'); };
  for (const bad of [{ ...item(), market_hash_name: undefined }, item('570-[unsafe]'), item('570-bad\nname'),
    item('0-Invalid app'), item('4294967296-Invalid app')]) {
    await assert.rejects(resolveStickerInventory([item(), bad], { fetchImpl }), /Unresolvable owned/);
  }
});

test('alias lookup catches initial failures, keeps stale data and never guesses suffixes', async () => {
  const clock = controlledCatalog();
  const unavailable = resolveStickerAlias('Cat Cam talking (Sticker)-37', clock.options);
  clock.requests[0]!.reject(new Error('offline'));
  assert.equal(await unavailable, undefined);
  assert.equal(await resolveStickerAlias('Cat Cam talking', clock.options), undefined);
  clock.advance(30_000);
  const retry = resolveStickerAlias('Cat Cam talking', clock.options);
  clock.requests[1]!.resolve(response([talking]));
  assert.equal(await retry, 'Cat talking');
  clock.advance(10 * 60_000);
  assert.equal(await resolveStickerAlias('Cat Cam talking', clock.options), 'Cat talking');
  clock.requests[2]!.reject(new Error('offline'));
  await settleRefresh();
  assert.equal(await resolveStickerAlias('Cat Cam talking', clock.options), 'Cat talking');
  assert.equal(await resolveStickerAlias('Unknown (Sticker)-37', clock.options), undefined);
});

test('incomplete or oversized catalog pages never establish a successful directory', async () => {
  const pages: Record<string, unknown>[] = [
    { definitions: [talking], total_count: 2 },
    { definitions: [], count: 0, total_count: 2 },
    { count: 0, total_count: 2 },
    { definitions: [], next_cursor: 'more' },
    { definitions: [talking], total_count: 1.5 },
    { definitions: Array.from({ length: 1001 }, () => talking), total_count: 1001 }
  ];
  for (const page of pages) {
    await assert.rejects(resolveStickerInventory([item()], {
      fetchImpl: async () => Response.json({ response: page })
    }), /sticker catalog/i);
  }
});

test('page limit in a global catalog rejects rather than exposing later-app partial inventory', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async input => {
    assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids, []);
    return Response.json({ response: { definitions: [{ ...talking, appid: 40 }],
      total_count: 100, next_cursor: `page-${++calls}` } });
  };
  await assert.rejects(resolveStickerInventory(Array.from({ length: 40 }, (_, i) => item(`${i + 1}-Cat Cam talking`)),
    { fetchImpl }), /page limit/);
  assert.equal(calls, 4);
});

test('a complete global catalog must resolve every app when the filtered-app bound is exceeded', async () => {
  await assert.rejects(resolveStickerInventory(Array.from({ length: 40 }, (_, i) => item(`${i + 1}-Cat Cam talking`)), {
    fetchImpl: async () => response([{ ...talking, appid: 40 }])
  }), /Incomplete sticker catalog/);
});

test('incomplete refresh pages are discarded while old definitions remain available', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  const old = await initial;
  clock.advance(10 * 60_000);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  const changed = { ...talking, internal_description: 'Changed protocol' };
  clock.requests[1]!.resolve(Response.json({ response: { definitions: [changed], total_count: 2 } }));
  await settleRefresh();
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), old);
  assert.equal(clock.calls, 2);
});

test('merging refreshes preserves ambiguous aliases instead of guessing a new protocol name', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerAlias('Cat Cam talking', clock.options);
  clock.requests[0]!.resolve(response([talking]));
  assert.equal(await initial, 'Cat talking');
  clock.advance(10 * 60_000);
  assert.equal(await resolveStickerAlias('Cat Cam talking', clock.options), 'Cat talking');
  clock.requests[1]!.resolve(response([{ ...talking, internal_description: 'Other protocol' }]));
  await settleRefresh();
  assert.equal(await resolveStickerAlias('Cat Cam talking', clock.options), undefined);
  assert.equal(await resolveStickerAlias('Cat talking', clock.options), 'Cat talking');
});

test('verified snapshot aliases survive retired catalog definitions across changed appid filters', async () => {
  const clock = controlledCatalog();
  const initial = resolveStickerInventory([item()], clock.options);
  clock.requests[0]!.resolve(response([talking]));
  const previousInventory = await initial;
  clock.advance(10 * 60_000);
  assert.deepEqual(await resolveStickerInventory([item()], clock.options), previousInventory);
  clock.requests[1]!.resolve(response([]));
  await settleRefresh();
  const changed = resolveStickerInventory([item(), item('2022180-CatchHeart')], { ...clock.options, previousInventory });
  clock.requests[2]!.resolve(response([fixtures[2]]));
  assert.deepEqual((await changed).map(x => x.name), ['Cat talking', 'catchheart']);
  // Snapshot aliases stay local to the caller. Another account cannot borrow them
  // through the shared catalog, even with the identical filter and fetch instance.
  await assert.rejects(resolveStickerInventory([item(), item('2022180-CatchHeart')], clock.options),
    /Incomplete sticker catalog/);
  assert.deepEqual((await resolveStickerInventory([item('2022180-CatchHeart')], {
    fetchImpl: async () => response([fixtures[2]]), previousInventory
  })).map(x => x.name), ['catchheart']);
});

test('fresh catalogs can use explicit persisted aliases but never infer a title or suffix', async () => {
  const fetchImpl: typeof fetch = async () => response([]);
  const hash = '637310-Cat Cam talking (Sticker)-37';
  const previousInventory = [{ name: 'Cat talking', title: hash, aliases: [hash] }];
  assert.equal((await resolveStickerInventory([item(hash)], { fetchImpl, previousInventory }))[0]!.name, 'Cat talking');
  for (const aliases of [[], ['637310-Cat Cam talking'], ['Cat Cam talking (Sticker)-37']]) {
    await assert.rejects(resolveStickerInventory([item(hash)], {
      fetchImpl, previousInventory: [{ ...previousInventory[0], aliases }]
    }), /Incomplete sticker catalog/);
  }
  assert.deepEqual(await resolveStickerInventory([], { fetchImpl, previousInventory }), []);
});

test('snapshot conflicts with current definitions or other snapshot aliases fail closed in either order', async () => {
  const alias = '637310-Cat Cam talking';
  const previousInventory = [{ name: 'Cat talking', title: 'Cat Cam talking', aliases: [alias] }];
  const conflict = { name: 'Other protocol', aliases: [alias] };
  for (const entries of [[...previousInventory, conflict], [conflict, ...previousInventory]]) {
    await assert.rejects(resolveStickerInventory([item(alias)], {
      fetchImpl: async () => response([]), previousInventory: entries
    }), /Incomplete sticker catalog/);
  }
  for (const definitions of [[{ ...talking, internal_description: 'Other protocol' }],
    [talking, { ...talking, internal_description: 'Other protocol' }]]) {
    await assert.rejects(resolveStickerInventory([item(alias)], {
      fetchImpl: async () => response(definitions), previousInventory
    }), /Incomplete sticker catalog/);
  }
});

test('unclassifiable assets fail before catalog lookup, including mixed complete and incomplete ownership', async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error('must not fetch'); };
  for (const bad of [null, { ...item(), name: undefined }, { ...item(), name: '' }, { ...item(), tags: undefined },
    { ...item(), tags: [] }, { ...item(), tags: [{ category: 'item_class' }] }]) {
    for (const inventory of [[bad], [item(), bad]]) {
      await assert.rejects(resolveStickerInventory(inventory, { fetchImpl }), /Incomplete Steam community inventory/);
    }
  }
});
