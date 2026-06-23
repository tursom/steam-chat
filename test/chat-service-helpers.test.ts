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
