'use strict';

import type { ConversationSummary, HistoryItem, HistoryRecordInput, LoggerLike } from '../types';
import { errorMessage, isRecord } from '../types';

const fs = require('node:fs/promises');
const path = require('node:path');
const { CHAT_LOG_PATH } = require('../paths');

const DEFAULT_LOG_PATH = CHAT_LOG_PATH;
const MAX_HISTORY_LIMIT = 500;

function formatDate(date = new Date()) {
  const pad = (value: unknown, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    '.',
    pad(date.getMilliseconds(), 3)
  ].join('');
}

function parseMessageDate(item: Pick<HistoryItem, 'date' | 'sentAt' | 'ordinal'>): number {
  if (item.sentAt) {
    const sentAt = Date.parse(item.sentAt);
    if (!Number.isNaN(sentAt)) return sentAt;
  }
  if (item.date) {
    const normalized = String(item.date).replace(' ', 'T');
    const parsed = Date.parse(normalized);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function limitFrom(value: unknown, fallback = 100): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

function steamIdToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const getSteamID64 = value.getSteamID64;
    if (typeof getSteamID64 === 'function') return String(getSteamID64.call(value));
    if (value.steamid) return String(value.steamid);
  }
  return String(value);
}

function normalizeHistoryItem(record: HistoryRecordInput): HistoryItem {
  const item: HistoryItem = {
    type: typeof record.type === 'string' ? record.type : (record.imageUrl ? 'image' : 'message'),
    date: typeof record.date === 'string' ? record.date : formatDate(record.sentAt ? new Date(record.sentAt) : new Date()),
    echo: Boolean(record.echo),
    id: steamIdToString(record.id || record.steamID),
    name: typeof record.name === 'string' ? record.name : (record.echo ? 'Me' : 'Unknown'),
    message: typeof record.message === 'string' ? record.message : '',
    imageUrl: typeof record.imageUrl === 'string' ? record.imageUrl : null,
    ordinal: typeof record.ordinal === 'string' || typeof record.ordinal === 'number' ? record.ordinal : null
  };
  if (typeof record.sentAt === 'string') item.sentAt = record.sentAt;
  return item;
}

async function appendLog(item: HistoryRecordInput, options: { logPath?: string } = {}): Promise<HistoryItem> {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const normalized = normalizeHistoryItem(item);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

async function readAllLogLines(logPath: string, logger: LoggerLike = console): Promise<HistoryItem[]> {
  let content;
  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const records: HistoryItem[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      records.push(normalizeHistoryItem(isRecord(parsed) ? parsed : {}));
    } catch (error) {
      logger.warn?.('Skipping invalid JSONL chat log line', { line: index + 1, error: errorMessage(error) });
    }
  }
  return records;
}

function sortHistoryItems(items: HistoryItem[]) {
  return items.sort((left, right) => {
    const diff = parseMessageDate(left) - parseMessageDate(right);
    if (diff !== 0) return diff;
    return Number(left.ordinal || 0) - Number(right.ordinal || 0);
  });
}

async function readHistory(options: { logPath?: string; limit?: unknown; id?: unknown; logger?: LoggerLike } = {}): Promise<HistoryItem[]> {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const limit = limitFrom(options.limit);
  const id = options.id ? steamIdToString(options.id) : '';
  let records = await readAllLogLines(logPath, options.logger);
  if (id) {
    records = records.filter((item) => item.id === id);
  }
  records = sortHistoryItems(records);
  return records.slice(-limit);
}

function extractStickerType(message: unknown): string {
  const match = String(message || '').match(/\[sticker\s+type=["']?([^"'\]\s]+)["']?[^]*?\]\s*\[\/sticker\]/i);
  return match ? match[1] : '';
}

function extractOpenGraphTitle(message: unknown): string {
  const match = String(message || '').match(/\[og\b[^\]]*title=["']([^"']+)["'][^\]]*\]/i);
  return match ? match[1] : '';
}

function isEmoticonOnly(message: unknown): string {
  const text = String(message || '').trim();
  if (/^:[A-Za-z0-9_+\-.]+:$/.test(text)) return text.slice(1, -1);
  const named = text.match(/^\[emoticon\s+name=["']?([^"'\]\s]+)["']?\]\s*\[\/emoticon\]$/i);
  if (named) return named[1];
  const body = text.match(/^\[emoticon\]([^[]+)\[\/emoticon\]$/i);
  return body ? body[1] : '';
}

function stripMarkup(message: unknown): string {
  return String(message || '')
    .replace(/\[url=([^\]]+)\]([^[]+)\[\/url\]/gi, '$2')
    .replace(/\[url\]([^[]+)\[\/url\]/gi, '$1')
    .replace(/\[img[^\]]*\][^[]*\[\/img\]/gi, '[图片]')
    .replace(/<img\b[^>]*>/gi, '[图片]')
    .replace(/\s+/g, ' ')
    .trim();
}

function previewForMessage(item: Pick<HistoryItem, 'type' | 'message' | 'imageUrl'>): string {
  if (item.type === 'image' || item.imageUrl) return '[图片]';
  const stickerType = extractStickerType(item.message);
  if (stickerType) return `[贴纸] ${stickerType}`;
  const emoticon = isEmoticonOnly(item.message);
  if (emoticon) return `[表情] ${emoticon}`;
  const ogTitle = extractOpenGraphTitle(item.message);
  if (ogTitle) return ogTitle;
  return stripMarkup(item.message) || '[空消息]';
}

async function buildConversations(options: {
  logPath?: string;
  limit?: unknown;
  getUserInfo?: (id: string) => Promise<{ player_name?: string; personaName?: string }>;
  logger?: LoggerLike;
} = {}): Promise<ConversationSummary[]> {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const limit = limitFrom(options.limit, 100);
  const getUserInfo = options.getUserInfo;
  const records = await readHistory({ logPath, limit, logger: options.logger });
  const conversations = new Map<string, ConversationSummary & { updatedAtMs: number }>();

  for (const item of records) {
    if (!item.id) continue;
    const previous = conversations.get(item.id);
    const at = parseMessageDate(item);
    const name = !item.echo && item.name && item.name !== 'Unknown' ? item.name : previous?.name;
    conversations.set(item.id, {
      id: item.id,
      name: name || item.name || item.id,
      updatedAt: item.sentAt || item.date,
      updatedAtMs: at,
      preview: previewForMessage(item),
      lastType: item.type,
      lastEcho: item.echo,
      messageCount: (previous?.messageCount || 0) + 1
    });
  }

  const result = [...conversations.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  if (getUserInfo) {
    await Promise.all(result.map(async (conversation) => {
      if (conversation.name && conversation.name !== conversation.id && conversation.name !== 'Unknown') return;
      try {
        const info = await getUserInfo(conversation.id);
        conversation.name = info.player_name || info.personaName || conversation.id;
      } catch (_) {
        conversation.name = conversation.id;
      }
    }));
  }
  return result.map(({ updatedAtMs, ...conversation }) => conversation);
}

module.exports = {
  DEFAULT_LOG_PATH,
  MAX_HISTORY_LIMIT,
  appendLog,
  buildConversations,
  extractOpenGraphTitle,
  extractStickerType,
  formatDate,
  isEmoticonOnly,
  limitFrom,
  normalizeHistoryItem,
  parseMessageDate,
  previewForMessage,
  readHistory,
  sortHistoryItems,
  steamIdToString,
  stripMarkup
};
