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
    eventId, type: item.type, date: input.date || formatDate(new Date(at)),
    echo: item.echo, steamAccountId: BigInt(item.steamAccountId).toString(),
    id: BigInt(item.id).toString(), name: item.name, message: item.message,
    ordinal, sentAt: new Date(at).toISOString()
  };
  if (Buffer.byteLength(canonicalMessage(result)) > 1024 * 1024) throw new Error('Message exceeds 1 MiB storage limit');
  return Object.freeze(result);
}

// Fixed field order is shared by conflict checks and offline reconciliation.
export function canonicalMessage(item: HistoryItem): string {
  return JSON.stringify({ eventId: item.eventId, type: item.type, date: item.date,
    echo: item.echo, steamAccountId: item.steamAccountId, id: item.id,
    name: item.name, message: item.message, ordinal: item.ordinal, sentAt: item.sentAt });
}

export function serializeStoredMessage(item: HistoryItem): string {
  return canonicalMessage(item);
}
