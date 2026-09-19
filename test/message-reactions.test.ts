import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readMessageReactions, updateMessageReaction } from '../src/server/message-reactions';
const schema = require('steam-user/protobufs/generated/_load.js');
const SteamUser = require('steam-user');
const peer = '76561198000000001', self = '76561198000000002';

test('installed SDK wire uses reaction schemas and preserves message ordinal, type and colon names', async () => {
  const user = new SteamUser({ autoRelogin: false });
  let calls = 0;
  user._send = (header: any, bytes: Buffer, callback: any) => {
    calls++;
    assert.equal(header.proto.target_job_name, 'FriendMessages.UpdateMessageReaction#1');
    const request = schema.CFriendMessages_UpdateMessageReaction_Request.toObject(schema.CFriendMessages_UpdateMessageReaction_Request.decode(bytes), { longs: String });
    assert.deepEqual(request, { steamid: peer, server_timestamp: 1700000000, ordinal: 2, reaction_type: 1, reaction: ':smile:', is_add: true });
    callback(Buffer.from(schema.CFriendMessages_UpdateMessageReaction_Response.encode({ reactors: [39734273, 39734274] }).finish()), { proto: { eresult: 1 } });
  };
  const result = await updateMessageReaction(user, { id: peer, timestamp: 1700000000, ordinal: 2, reactionType: 1, reaction: ':smile:', add: true });
  assert.deepEqual(result.users, [peer, self]); assert.equal(calls, 1);
});

test('removing a sticker uses the official name and zero reactors is an authoritative empty result', async () => {
  const result = await updateMessageReaction({ _sendUnified() {}, _send(_header, bytes, callback) {
    const request = schema.CFriendMessages_UpdateMessageReaction_Request.toObject(schema.CFriendMessages_UpdateMessageReaction_Request.decode(bytes));
    assert.equal(request.reaction, 'AnimationSticker8'); assert.equal(request.is_add, false);
    callback(Buffer.alloc(0), { proto: { eresult: 1 } });
  } }, { id: peer, timestamp: 1700000000, ordinal: 0, reactionType: 2, reaction: 'AnimationSticker8', add: false });
  assert.deepEqual(result.users, []);
});

test('reaction read uses server history, retaining distinct messages in the same second', async () => {
  const result = await readMessageReactions({ _sendUnified(method, data, cb) {
    assert.equal(method, 'FriendMessages.GetRecentMessages#1'); assert.equal(data.steamid1, self); assert.equal(data.steamid2, peer);
    cb({ messages: [
      { timestamp: 1700000000, ordinal: 0, reactions: [{ reaction_type: 2, reaction: 'AnimationSticker8', reactors: [39734273, 39734273] }] },
      { timestamp: 1700000000, ordinal: 1, reactions: [] }
    ] }, { proto: { eresult: 1 } });
  } }, self, peer, 1700000001);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].reactions[0].users, [peer]);
  assert.deepEqual(result.items[1].reactions, []);
});

test('invalid targets and Steam failures do not become successful local reactions or retry', async () => {
  let calls = 0;
  const client = { _sendUnified() {}, _send(_header: unknown, _bytes: Buffer, cb: any) { calls++; cb(Buffer.alloc(0), { proto: { eresult: 84 } }); } };
  const body = { id: peer, timestamp: 1700000000, ordinal: 0, reactionType: 2, reaction: 'snow', add: true };
  await assert.rejects(updateMessageReaction(client, { ...body, id: '3' }));
  await assert.rejects(updateMessageReaction(client, { ...body, ordinal: -1 }));
  assert.equal(calls, 0);
  await assert.rejects(updateMessageReaction(client, body), /RateLimitExceeded/);
  assert.equal(calls, 1);
});
