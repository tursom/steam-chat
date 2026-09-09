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

for (const fixture of fixtures) {
  test(`real definition ${fixture.defid} preserves protocol identifier exactly`, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async input => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname,
        'https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/');
      assert.deepEqual(JSON.parse(url.searchParams.get('input_json')!), {
        appids: [fixture.appid], community_item_classes: [11], count: 1000, language: 'english'
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
    assert.deepEqual(await resolveStickerInventory([
      item(), item('637310-Cat Cam talking'), item('637310-Cat talking'), item('570-show love'),
      item('570-[sticker type="bad"]'), item('570-bad\nname'), { ...item(), tags: [] }
    ], { fetchImpl: async () => response(definitions) }), []);
  }
});

test('unprefixed inventory uses authoritative global aliases', async () => {
  const result = await resolveStickerInventory([item('Cat Cam talking'), item('Cat talking'), item('unknown')], {
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
      return response([]);
    }
  });
});

test('large inventories use bounded global pagination without dropping later apps', async () => {
  let calls = 0;
  const result = await resolveStickerInventory(Array.from({ length: 40 }, (_, i) => item(`${i + 1}-Cat Cam talking`)), {
    fetchImpl: async input => {
      assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids, []);
      return Response.json({ response: { definitions: [{ ...talking, appid: 40 }],
        count: 1, total_count: 100, next_cursor: `page-${++calls}` } });
    }
  });
  assert.equal(calls, 4);
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

test('repeated cursor terminates pagination', async () => {
  let calls = 0;
  await resolveStickerInventory([item()], { fetchImpl: async () => {
    calls++;
    return Response.json({ response: { definitions: [talking], count: 1, total_count: 100, next_cursor: 'same' } });
  } });
  assert.equal(calls, 2);
});

test('HTTP and malformed catalog failures fail closed and are briefly cached', async () => {
  for (const reply of [() => new Response('', { status: 503 }), () => Response.json({ response: {} })]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return reply(); };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await resolveStickerInventory([item(), item('570-show love')], { fetchImpl }), []);
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
    assert.deepEqual(await resolveStickerInventory([item(), item('570-show love')], { fetchImpl, timeoutMs: 10 }), []);
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
    assert.deepEqual(await resolveStickerInventory([item('637310-Cat Cam talking')], { fetchImpl }), []);
    assert.equal(await resolveStickerAlias('Cat Cam talking', { fetchImpl }), undefined);
    const result = await resolveStickerInventory([item()], { fetchImpl });
    assert.equal(result[0]!.name, 'Cat talking');
    assert.ok(!result[0]!.aliases.includes('Cat Cam talking'));
    assert.ok(!result[0]!.aliases.includes('637310-Cat Cam talking'));
  }
});
