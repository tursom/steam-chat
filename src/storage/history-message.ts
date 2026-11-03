import { createHash, randomBytes } from 'node:crypto';
import type { HistoryItem, HistoryRecordInput } from '../types';
const { normalizeHistoryItem, formatDate } = require('./chat-log');

export type StoredMessage = HistoryItem & { eventId: string; sentAt: string; steamAccountId: string; ordinal: number };

export function steamEventKey(account: string | undefined, peer: string, echo: boolean, message: string, at: unknown, ordinal: unknown): string | undefined {
  if (!account || !(at instanceof Date) || !Number.isFinite(at.getTime()) || ordinal === null || ordinal === undefined) return undefined;
  const sequence = Number(ordinal);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) return undefined;
  return createHash('sha256').update(JSON.stringify([account, peer, echo, message, at.getTime(), sequence])).digest('hex');
}

// Only validated Steam wire wrappers are projected. Labels, whitespace and URL
// spelling stay significant. A body alone is never an event identity.
export function replayMessage(message: string): string {
  if (/\\[\[\]]/.test(message)) return message;
  let valid = true;
  const plain = message.replace(/\[(url|emoticon|img|og)([^\[\]]*)\]([^\[\]]*)\[\/\1\]/gi, (original, name: string, attrs: string, body: string) => {
    const tag = name.toLowerCase();
    if (tag === 'emoticon') {
      if (!attrs && /^[A-Za-z0-9_-]+$/.test(body)) return `:${body}:`;
    } else if (/^https?:\/\/[^\s\[\]<>"']+$/i.test(body)) {
      if (tag === 'url') {
        const target = attrs.startsWith('=') ? attrs.slice(1).replace(/^(["'])(.*)\1$/, '$2') : undefined;
        if (!attrs || target === body) return body;
      } else {
        const values = new Map<string, string>();
        const attribute = /\s+(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
        let offset = 0;
        for (const match of attrs.matchAll(attribute)) {
          const key = match[1].toLowerCase();
          if (match.index !== offset || values.has(key)) break;
          values.set(key, match[2] ?? match[3] ?? match[4]);
          offset = match.index + match[0].length;
        }
        const allowed = tag === 'img' ? ['src', 'thumbnail_src', 'proxied'] : ['url', 'img', 'title', 'desc', 'share_source', 'vd_source'];
        if (!attrs.slice(offset).trim() && [...values.keys()].every(key => allowed.includes(key))
          && values.get(tag === 'img' ? 'src' : 'url') === body) return body;
      }
    }
    valid = false;
    return original;
  });
  return valid && !/[\[\]]/.test(plain) ? plain : message;
}

export function steamReplayIdentity(input: HistoryRecordInput): string | undefined {
  if (input.steamMetadata === false || input.imageSendSource === 'upload') return undefined;
  // Image echoes keep their EXACT existing alias key. Callback/echo pairing is
  // handled separately; do not replace that protocol with URL/time matching.
  const image = input.echo && (input.type === 'image' || imageEchoIdentity({ ...input, imageSendSource: 'echo' }));
  const account = input.steamAccountId;
  const peer = String(input.id ?? '');
  if (!account || !/^[1-9][0-9]*$/.test(account) || !/^[1-9][0-9]*$/.test(peer)) return undefined;
  if (typeof input.ordinal !== 'number' && !(typeof input.ordinal === 'string' && /^\d+$/.test(input.ordinal))) return undefined;
  const at = input.sentAt || input.date?.replace(' ', 'T');
  if (!at) return undefined;
  const message = input.message || '';
  return steamEventKey(account, peer, Boolean(input.echo), image ? message : replayMessage(message), new Date(at), input.ordinal);
}

// Steam can echo an upload as either image BBCode or a bare UGC image URL.
export function isSteamImageUrl(message: string): boolean {
  try {
    const url = new URL(message);
    return url.href === message && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.hostname === 'images.steamusercontent.com'
      && /^\/ugc\/\d+\/[a-f0-9]+\/$/i.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

// Only the upload callback and a complete realtime image echo may be paired.
export function imageEchoIdentity(input: HistoryRecordInput) {
  const source = input.imageSendSource;
  if (!input.echo || (source !== 'upload' && source !== 'echo')) return undefined;
  let raw = input.message || '';
  if (source === 'echo') {
    const tag = /^\[img\b([^\]]*)\]([\s\S]*)\[\/img\]$/i.exec(raw);
    if (tag) {
      if (/\[\/?img\b/i.test(tag[2])) return undefined;
      const src = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s\]]+))/i.exec(tag[1]);
      if (!src) return undefined;
      raw = src[1] || src[2] || src[3];
    } else if (!isSteamImageUrl(raw)) return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const at = input.sentAt ? Date.parse(input.sentAt) : input.date ? Date.parse(input.date.replace(' ', 'T')) : Date.now();
    if (!Number.isFinite(at)) return undefined;
    return { source, at, paired: false,
      key: createHash('sha256').update(JSON.stringify([input.steamAccountId, String(input.id), url.href])).digest('hex') };
  } catch { return undefined; }
}

export function normalizeStoredMessage(input: HistoryRecordInput): StoredMessage {
  const item: HistoryItem = normalizeHistoryItem(input);
  for (const [name, value] of [['steamAccountId', item.steamAccountId], ['id', item.id]]) {
    if (!value || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n || BigInt(value) > 0xffffffffffffffffn) {
      throw new Error(`Invalid ${name}: expected a nonzero uint64 Steam ID`);
    }
  }
  const at = input.sentAt ? Date.parse(input.sentAt) : input.date ? Date.parse(input.date.replace(' ', 'T')) : Date.now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid message timestamp');
  const ordinal = item.ordinal === null ? 0 : Number(item.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff) throw new Error('Invalid uint32 ordinal');
  const eventId = input.eventId === undefined ? randomBytes(16).toString('hex') : input.eventId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(eventId)) throw new Error('Invalid eventId');
  const result: StoredMessage = {
    eventId, type: input.imageSendSource === 'echo' && isSteamImageUrl(item.message || '') ? 'image' : item.type, date: input.date || formatDate(new Date(at)),
    echo: item.echo, steamAccountId: BigInt(item.steamAccountId).toString(),
    id: BigInt(item.id).toString(), name: item.name, message: item.message,
    ordinal, sentAt: new Date(at).toISOString()
  };
  // Keep legacy records/aliases byte-compatible when re-normalizing them.
  // New records must not turn synthesized metadata into replay evidence after
  // an index rebuild. Complete images continue to use their alias protocol.
  const suppliedOrdinal = typeof input.ordinal === 'number' || typeof input.ordinal === 'string' && /^\d+$/.test(input.ordinal);
  if (input.steamMetadata === false || input.imageSendSource === 'upload' ||
    !(input.sentAt || input.date) || !suppliedOrdinal) result.steamMetadata = false;
  if (Buffer.byteLength(canonicalMessage(result)) > 1024 * 1024) throw new Error('Message exceeds 1 MiB storage limit');
  return Object.freeze(result);
}

// Fixed field order is shared by conflict checks and offline reconciliation.
export function canonicalMessage(item: HistoryItem): string {
  return JSON.stringify({ eventId: item.eventId, type: item.type, date: item.date,
    echo: item.echo, steamAccountId: item.steamAccountId, id: item.id,
    name: item.name, message: item.message, ordinal: item.ordinal, sentAt: item.sentAt,
    steamMetadata: item.steamMetadata });
}

export function serializeStoredMessage(item: HistoryItem): string {
  return canonicalMessage(item);
}
