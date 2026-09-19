import { isRecord } from '../types';

export type ReactionClient = {
  _send?: (header: unknown, body: Buffer, callback: (body: unknown, header: unknown) => void) => void;
  _sendUnified?: (method: string, data: Record<string, unknown>, callback: (body: unknown, header: unknown) => void) => void;
};
const resultNames: Record<number, string> = require('steam-user/enums/EResult');
export function reactionNumber(value: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw Object.assign(new Error('Invalid message timestamp or ordinal'), { statusCode: 400 });
  }
  return number;
}
export function reactionPeer(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{17}$/.test(value) || ((BigInt(value) >> 52n) & 15n) !== 1n) {
    throw Object.assign(new Error('A friend SteamID64 is required'), { statusCode: 400 });
  }
  return value;
}
export function reactionUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)
    .map(id => String(76561197960265728n + BigInt(id))))];
}
async function unified(client: ReactionClient, method: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!client._sendUnified) throw Object.assign(new Error('Steam reactions unavailable'), { statusCode: 503 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Steam reaction request timed out; result not confirmed'), { statusCode: 504 })), 10000);
    try {
      const callback = (body: unknown, header: unknown) => {
        clearTimeout(timer);
        const code = isRecord(header) && isRecord(header.proto) ? Number(header.proto.eresult) : NaN;
        if (code !== 1) { reject(Object.assign(new Error(resultNames[code] || 'Steam did not confirm reaction request'), { statusCode: code === 84 ? 429 : 502 })); return; }
        if (!isRecord(body)) { reject(Object.assign(new Error('Invalid reaction response'), { statusCode: 502 })); return; }
        resolve(body);
      };
      if (method === 'FriendMessages.UpdateMessageReaction#1') {
        // steam-user ships these schemas but does not register this method in _sendUnified.
        if (!client._send) throw new Error('Steam reaction transport unavailable');
        const schema = require('steam-user/protobufs/generated/_load.js');
        const emsg = require('steam-user/enums/EMsg.js');
        client._send({ msg: emsg.ServiceMethodCallFromClient, proto: { target_job_name: method } },
          Buffer.from(schema.CFriendMessages_UpdateMessageReaction_Request.encode(data).finish()), (raw, header) => {
            try {
              const bytes = Buffer.isBuffer(raw) ? raw : (raw as { toBuffer(): Buffer }).toBuffer();
              const result = schema.CFriendMessages_UpdateMessageReaction_Response.toObject(
                schema.CFriendMessages_UpdateMessageReaction_Response.decode(bytes), { defaults: true });
              callback(result, header);
            } catch (error) { clearTimeout(timer); reject(error); }
          });
      } else client._sendUnified!(method, data, callback);
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
export async function readMessageReactions(client: ReactionClient, account: string, peer: string, before: unknown) {
  const end = reactionNumber(before);
  const response = await unified(client, 'FriendMessages.GetRecentMessages#1', {
    steamid1: account, steamid2: reactionPeer(peer), count: 100, most_recent_conversation: false, bbcode_format: true,
    time_last: end, ordinal_last: 0xffffffff
  });
  return { items: (Array.isArray(response.messages) ? response.messages : []).filter(isRecord).map(message => ({
    timestamp: reactionNumber(message.timestamp), ordinal: reactionNumber(message.ordinal),
    reactions: (Array.isArray(message.reactions) ? message.reactions : []).filter(isRecord)
      .filter(reaction => [1, 2].includes(Number(reaction.reaction_type)) && typeof reaction.reaction === 'string')
      .map(reaction => ({ type: Number(reaction.reaction_type), name: String(reaction.reaction), users: reactionUsers(reaction.reactors) }))
  })) };
}
export async function updateMessageReaction(client: ReactionClient, body: Record<string, unknown>) {
  const id = reactionPeer(body.id);
  const timestamp = reactionNumber(body.timestamp), ordinal = reactionNumber(body.ordinal);
  if (![1, 2].includes(Number(body.reactionType)) || typeof body.reaction !== 'string' || !body.reaction.trim()
    || body.reaction.length > 512 || /[\[\]"\\\x00-\x1f\x7f]/.test(body.reaction) || typeof body.add !== 'boolean') {
    throw Object.assign(new Error('Invalid message reaction'), { statusCode: 400 });
  }
  const result = await unified(client, 'FriendMessages.UpdateMessageReaction#1', {
    steamid: id, server_timestamp: timestamp, ordinal, reaction_type: Number(body.reactionType), reaction: body.reaction, is_add: body.add
  });
  if (!Array.isArray(result.reactors)) throw Object.assign(new Error('Steam did not return reaction members'), { statusCode: 502 });
  return { timestamp, ordinal, type: Number(body.reactionType), name: body.reaction, users: reactionUsers(result.reactors) };
}
