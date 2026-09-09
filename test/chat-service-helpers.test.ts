'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  decodeBase64Image,
  defaultGetEmoticons,
  listFriends,
  listGroups,
  readRequestBody
} = require('../src/server/chat-service');

test('listFriends normalizes persona fields and sorts online friends by name', async () => {
  const friends = await listFriends({
    myFriends: {
      offline: 0,
      zed: 1,
      amy: 2
    },
    users: {
      offline: { name: 'Bob' },
      zed: { personaName: 'Zed', avatar_url_icon: 'zed-icon', game_name: 'Playing Z' },
      amy: { player_name: 'Amy', avatar_url_medium: 'amy-avatar', personaState: 2, gameName: 'Playing A' }
    }
  });

  assert.deepEqual(friends.map((friend: { id: string }) => friend.id), ['amy', 'zed', 'offline']);
  assert.deepEqual(friends.map((friend: { online: boolean }) => friend.online), [true, true, false]);
  assert.equal(friends[0].avatar, 'amy-avatar');
  assert.equal(friends[0].gameName, 'Playing A');
  assert.equal(friends[1].avatar, 'zed-icon');
  assert.equal(friends[1].gameName, 'Playing Z');
});

test('listGroups accepts array and object group shapes', async () => {
  const fromArray = await listGroups({
    myGroups: [
      { steamID: { getSteamID64: () => '100' }, clanID: 'clan-100', group_name: 'Array Group' },
      'raw-group'
    ]
  });
  assert.deepEqual(fromArray, [
    { id: '100', clanId: 'clan-100', name: 'Array Group' },
    { id: 'raw-group', clanId: '', name: 'raw-group' }
  ]);

  const fromObject = await listGroups({
    groups: {
      fallback: { clanid: 'clan-fallback', name: 'Object Group' },
      simple: null
    }
  });
  assert.deepEqual(fromObject, [
    { id: 'fallback', clanId: 'clan-fallback', name: 'Object Group' },
    { id: 'simple', clanId: '', name: 'simple' }
  ]);
});

test('defaultGetEmoticons waits for login and supports callback-style chat APIs', async () => {
  const order: string[] = [];
  const steamUser = {
    chat: {
      getEmoticonList(callback: (error: unknown, response?: unknown) => void) {
        order.push('source');
        callback(null, {
          emoticon_list: [{ name: ':wave:' }],
          sticker_list: [{ name: 'sticker' }]
        });
      }
    }
  };

  const data = await defaultGetEmoticons({
    steamUser,
    waitForLogin: async () => {
      order.push('login');
    },
    waitForWebSession: async () => {
      order.push('web');
    }
  });

  assert.deepEqual(order, ['login', 'web', 'source']);
  assert.deepEqual(data.emoticons, [{ name: ':wave:' }]);
  assert.deepEqual(data.stickers, [{ name: 'sticker' }]);
});

test('defaultGetEmoticons accepts the name-keyed inventory returned by steam-user', async () => {
  const emoticon = { name: ':steamhappy:', count: 1 };
  const data = await defaultGetEmoticons({
    steamUser: { getEmoticonList: async () => ({ emoticons: { ':steamhappy:': emoticon } }) }
  });
  assert.deepEqual(data.emoticons, [emoticon]);
});

// Public reward definition 153568; adapter tests must not depend on live catalog availability.
function mockStickerCatalog(t: import('node:test').TestContext): void {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ response: {
    definitions: [{ appid: 1203420, defid: 153568, community_item_class: 11, community_item_type: 28,
      internal_description: 'show love', community_item_data: { item_name: 'Show Love', item_title: 'Show Love' } }],
    count: 1, total_count: 1
  } }));
}

test('defaultGetEmoticons loads owned community stickers through the installed inventory SDK', async (t: import('node:test').TestContext) => {
  mockStickerCatalog(t);
  const calls: unknown[][] = [];
  const sticker = { appid: 753, market_hash_name: '1203420-Show Love', name: 'Localized title',
    icon_url: 'icon/hash', tags: [{ category: 'item_class', internal_name: 'item_class_11' }] };
  const data = await defaultGetEmoticons({
    steamUser: { steamID: '76561198000000001', getEmoticonList: async () => ({ emoticons: { ':wave:': { name: ':wave:' } } }) },
    steamCommunity: { getUserInventoryContents(...args: unknown[]) {
      const callback = args.pop() as (error: unknown, items: unknown[]) => void;
      calls.push(args);
      callback(null, [sticker, sticker, { ...sticker, tags: [] }, { ...sticker, market_hash_name: undefined }]);
    } }
  });
  assert.deepEqual(calls, [['76561198000000001', 753, 6, false]]);
  assert.equal(data.stickers.length, 1);
  assert.equal(data.stickers[0].name, 'show love');
  assert.equal(data.stickers[0].title, 'Show Love');
  assert.equal(data.stickers[0].imageUrl, 'https://community.cloudflare.steamstatic.com/economy/image/icon/hash');
  assert.ok(data.stickers[0].aliases.includes('1203420-Show Love'));
  assert.deepEqual(data.emoticons, [{ name: ':wave:' }]);
});

test('owned sticker adaptation consumes actual SDK paginated CEconItems, including non-tradable items', async (t: import('node:test').TestContext) => {
  mockStickerCatalog(t);
  const SteamCommunity = require('steamcommunity');
  const pages: unknown[] = [];
  const community = new SteamCommunity();
  community.httpRequest = (options: { qs: { start_assetid?: string } }, callback: (error: unknown, response: unknown, body: unknown) => void) => {
    pages.push(options.qs.start_assetid);
    const second = Boolean(options.qs.start_assetid);
    queueMicrotask(() => callback(null, {}, {
      success: 1, total_inventory_count: 2, more_items: !second, last_assetid: '10',
      assets: [{ assetid: second ? '20' : '10', appid: 753, classid: '1', instanceid: '0', amount: '1' }],
      descriptions: [{ classid: '1', instanceid: '0', tradable: 0, market_hash_name: '1203420-Show Love',
        name: 'Localized title', icon_url: 'hash', tags: [{ category: 'item_class', internal_name: 'item_class_11', localized_tag_name: 'Sticker' }] }]
    }));
  };
  const data = await defaultGetEmoticons({ steamUser: { steamID: '76561198000000001' }, steamCommunity: community });
  assert.deepEqual(pages, [undefined, '10']);
  assert.deepEqual(data.emoticons, []);
  assert.equal(data.stickers.length, 1);
  assert.equal(data.stickers[0].name, 'show love');
  assert.equal(data.stickers[0].title, 'Show Love');
  assert.equal(data.stickers[0].imageUrl, 'https://community.cloudflare.steamstatic.com/economy/image/hash');
  assert.ok(data.stickers[0].aliases.includes('1203420-Show Love'));
});

test('owned inventory errors are reported rather than disguised as an empty inventory', async () => {
  await assert.rejects(defaultGetEmoticons({
    steamUser: { steamID: '76561198000000001' },
    steamCommunity: { getUserInventoryContents: async () => { throw new Error('inventory unavailable'); } }
  }), /inventory unavailable/);
});

test('decodeBase64Image accepts data URLs and readRequestBody enforces byte limits', async () => {
  const encoded = Buffer.from('hello image').toString('base64');
  assert.deepEqual(decodeBase64Image(`data:image/png;base64,${encoded}`), Buffer.from('hello image'));

  const okReq = new PassThrough();
  const okBody = readRequestBody(okReq, 5);
  okReq.end('12345');
  assert.equal(await okBody, '12345');

  const largeReq = new PassThrough();
  const tooLarge = readRequestBody(largeReq, 3);
  largeReq.end('1234');
  await assert.rejects(tooLarge, (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 413);
    assert.match(error.message, /too large/);
    return true;
  });
});
