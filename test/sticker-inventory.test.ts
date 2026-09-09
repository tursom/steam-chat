import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStickerAlias, resolveStickerInventory } from '../src/server/sticker-inventory';

// Steam QueryRewardItems definition 103182: app 637310, community item type 37.
const talking = {
  appid: 637310, defid: 103182, type: 1, community_item_class: 11, community_item_type: 37,
  community_item_data: {
    item_name: 'Cat Cam talking', item_title: 'Cat Cam talking',
    item_description: 'A sticker of Cat Cam talking',
    item_image_small: '979bb2133de5a89a3f7a0524f8a1d27163301f6d.png',
    item_image_large: '67dafc3f8ed4cc1527a14cfb5fb622525778be1e.png', animated: true, tiled: false
  }
};
const item = (hash = '637310-Cat Cam talking (Sticker)-37') => ({
  appid: 753, market_hash_name: hash, name: 'Localized inventory title', icon_url: 'inventory/hash',
  tags: [{ category: 'item_class', internal_name: 'item_class_11' }]
});
const response = (definitions: unknown[], next_cursor = '') => Response.json({
  response: { definitions, count: definitions.length, total_count: definitions.length, next_cursor }
});

test('real Cat Cam definition resolves decorated market alias to actual item_name', async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async input => {
    urls.push(new URL(String(input)));
    return response([talking]);
  };
  const result = await resolveStickerInventory([item(), item('637310-Cat Cam talking'), item()], { fetchImpl });
  assert.equal(urls.length, 1);
  assert.equal(urls[0]!.origin + urls[0]!.pathname,
    'https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/');
  assert.deepEqual(JSON.parse(urls[0]!.searchParams.get('input_json')!), {
    appids: [637310], community_item_classes: [11], count: 1000, language: 'english'
  });
  assert.deepEqual(result, [{
    name: 'Cat Cam talking', title: 'Cat Cam talking',
    imageUrl: 'https://community.cloudflare.steamstatic.com/economy/image/inventory/hash',
    aliases: ['637310-Cat Cam talking (Sticker)-37', 'Cat Cam talking (Sticker)-37', '637310-Cat Cam talking']
  }]);
});

test('bare canonical inventory remains network-independent and unsafe types are omitted', async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error('Must not fetch'); };
  const result = await resolveStickerInventory([
    item('570-show love'), item('show love'), item('570-[sticker type="bad"]'), item('570-bad\nname'),
    { ...item(), tags: [] }
  ], { fetchImpl });
  assert.deepEqual(result, [{ name: 'show love', title: 'Localized inventory title',
    imageUrl: 'https://community.cloudflare.steamstatic.com/economy/image/inventory/hash', aliases: ['570-show love'] }]);
});

test('missing definitions never cause decorated suffix stripping or cross-app matches', async () => {
  const result = await resolveStickerInventory([
    item(), item('637310-Cat Cam talking (Sticker)-99'), item('Cat Cam talking (Sticker)-37'), item('570-show love')
  ], { fetchImpl: async () => response([{ ...talking, appid: 999 }, { ...talking, community_item_class: 1 }]) });
  assert.deepEqual(result.map(sticker => sticker.name), ['show love']);
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
  assert.equal(first[0]!.name, 'Cat Cam talking');
  assert.deepEqual(await resolveStickerInventory([item()], { fetchImpl }), first);
  assert.deepEqual(cursors, [undefined, 'second']);
});

test('external lookup appids and pagination are bounded to owned stickers', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async input => {
    const query = JSON.parse(new URL(String(input)).searchParams.get('input_json')!);
    assert.deepEqual(query.appids, Array.from({ length: 32 }, (_, index) => index + 1));
    return Response.json({ response: { definitions: [{ ...talking, community_item_class: 1 }],
      count: 1, total_count: 100, next_cursor: `page-${++calls}` } });
  };
  const result = await resolveStickerInventory(Array.from({ length: 40 }, (_, index) =>
    item(`${index + 1}-name (Sticker)-37`)), { fetchImpl });
  assert.deepEqual(result, []);
  assert.equal(calls, 4);
});

test('repeated cursor terminates pagination', async () => {
  let calls = 0;
  await resolveStickerInventory([item()], { fetchImpl: async () => {
    calls++;
    return Response.json({ response: { definitions: [{ ...talking, community_item_class: 1 }],
      count: 1, total_count: 100, next_cursor: 'same' } });
  } });
  assert.equal(calls, 2);
});

test('historical aliases resolve without an account or app prefix and stop at total_count', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async input => {
    calls++;
    const query = JSON.parse(new URL(String(input)).searchParams.get('input_json')!);
    assert.deepEqual(query.appids, []);
    return response([talking], 'nonempty-final-cursor');
  };
  assert.equal(await resolveStickerAlias('Cat Cam talking (Sticker)-37', { fetchImpl }), 'Cat Cam talking');
  assert.equal(await resolveStickerAlias('637310-Cat Cam talking (Sticker)-37', { fetchImpl }), 'Cat Cam talking');
  assert.equal(await resolveStickerAlias('Missing (Sticker)-999', { fetchImpl }), undefined);
  assert.equal(await resolveStickerAlias('ordinary name', { fetchImpl }), undefined);
  assert.equal(calls, 1);
});

test('HTTP and malformed catalog failures preserve bare inventory and are briefly cached', async () => {
  for (const reply of [() => new Response('', { status: 503 }), () => Response.json({ response: {} })]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return reply(); };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await resolveStickerInventory([item(), item('570-show love')], { fetchImpl });
      assert.deepEqual(result.map(sticker => sticker.name), ['show love']);
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
    const result = await resolveStickerInventory([item(), item('570-show love')], { fetchImpl, timeoutMs: 10 });
    assert.equal(signal?.aborted, true);
    assert.deepEqual(result.map(sticker => sticker.name), ['show love']);
  }
});

test('authoritative item_name may itself contain a decorated suffix', async () => {
  const name = 'Cat Cam talking (Sticker)-37';
  const result = await resolveStickerInventory([item(`637310-${name} (Sticker)-42`)], {
    fetchImpl: async () => response([{ ...talking, community_item_type: 42,
      community_item_data: { item_name: name, item_title: 'Different display title' } }])
  });
  assert.equal(result[0]!.name, name);
  assert.equal(result[0]!.title, 'Different display title');
});

test('ambiguous authoritative aliases are omitted', async () => {
  const result = await resolveStickerInventory([item()], {
    fetchImpl: async () => response([talking, { ...talking, community_item_type: 99,
      community_item_data: { item_name: 'Cat Cam talking (Sticker)-37' } }])
  });
  assert.deepEqual(result, []);
});
