'use strict';

import { settleMetadata } from './metadata';
import { imageEchoIdentity, steamEventKey } from '../storage/history-message';
import type { HistoryStorage } from '../storage/history-storage';
import type { LoggerLike, Persona, HistoryRecordInput } from '../types';
import type { SteamFriendMessageEvent, SteamFriendMessageEventUser } from './friend-message-events';
import { errorMessage } from '../types';
import { createHistoryRecovery, steamHistoryCall, type RecoveryUser } from './history-recovery';

const {
  DEFAULT_LOG_PATH,
  appendLog,
  formatDate,
  steamIdToString
} = require('../storage/chat-log');
const {
  subscribeFriendMessageEvents
} = require('./friend-message-events');

type SteamHistoryMessage = {
  accountid?: string | number;
  message?: string;
  ordinal?: string | number | null;
  steamID?: unknown;
  timestamp?: Date | number;
};

type SteamFriendHistoryMessage = {
  sender?: unknown;
  server_timestamp?: Date;
  ordinal?: string | number | null;
  message?: string;
};

type SteamMessageLoggerChat = NonNullable<SteamFriendMessageEventUser['chat']> & {
    getFriendMessageHistory?: (
      id: string,
      options: { maxCount: number; wantBbcode: boolean; startTime: number; lastTime?: Date; lastOrdinal?: number },
      callback: (error: unknown, response?: { messages?: SteamFriendHistoryMessage[]; more_available?: boolean }) => void
    ) => unknown;
};

type SteamMessageLoggerUser = SteamFriendMessageEventUser & RecoveryUser & {
  chat?: SteamMessageLoggerChat;
  getChatHistory?: (id: string, callback: (error: unknown, messages?: SteamHistoryMessage[]) => void) => void;
};

type SteamMessageLoggerOptions = {
  historyStorage?: HistoryStorage;
  steamUser: SteamMessageLoggerUser;
  getUserInfo?: (steamID: unknown) => Promise<Persona>;
  getSelfName?: (steamAccountId?: string) => Promise<string>;
  getSteamAccountId?: () => string | null | undefined;
  logPath?: string;
  logger?: LoggerLike;
  historyRetryMs?: number;
  historyTimeoutMs?: number;
};

function createSteamMessageLogger(options: SteamMessageLoggerOptions) {
  const { steamUser, getSelfName = async () => 'Me', getSteamAccountId = () => null, logPath = DEFAULT_LOG_PATH, logger = console } = options;
  const getUserInfo: (steamID: unknown) => Promise<Persona> = options.getUserInfo || (async () => ({ player_name: 'Unknown' }));
  if (!steamUser || typeof steamUser.on !== 'function') {
    throw new Error('steamUser EventEmitter is required');
  }

  const storage = options.historyStorage;
  const historyTimeoutMs = options.historyTimeoutMs ?? 15000;
  const pending = new Set<Promise<unknown>>();
  function track(task: Promise<unknown>) {
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
  }
  let closed = false;
  async function persist(record: HistoryRecordInput, historical = false, signal?: AbortSignal) {
    if (closed) throw new Error('Message logger closed');
    record.imageSendSource = record.echo && !historical ? 'echo' : undefined;
    const at = record.sentAt || record.date;
    record.steamEventKey = steamEventKey(record.steamAccountId, String(record.id), Boolean(record.echo), record.message || '',
      at ? new Date(at.replace(' ', 'T')) : undefined, record.ordinal);
    // Admission to a writer queue is not a durable archive. Install the listener
    // before append so even an immediate worker acknowledgement cannot be lost.
    const durable = new Set<string>();
    let acknowledge: ((id: string) => void) | undefined;
    const unsubscribe = historical ? storage?.onDurable(item => {
      if (item.eventId) { durable.add(item.eventId); acknowledge?.(item.eventId); }
    }) : undefined;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const item = await (storage?.appendSteamImage && record.steamEventKey && imageEchoIdentity({ ...record, imageSendSource: 'echo' })
        ? storage.appendSteamImage(record, { notify: !historical })
        : storage ? storage.append(record, { notify: !historical }) : appendLog(record, { logPath }));
      if (historical && item?.persistence) {
        if (item.persistence.rocksdb === 'failed' || !item.eventId) throw new Error('History recovery archive unavailable');
        if (!durable.has(item.eventId)) await new Promise<void>((resolve, reject) => {
          acknowledge = id => { if (id === item.eventId) resolve(); };
          timer = setTimeout(() => reject(new Error('History recovery durability timed out')), historyTimeoutMs);
          abort = () => reject(new Error('Steam history connection changed'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return item;
    } finally {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  const echoKeys = new Map<string, boolean>();

  function echoKey(id: string, message: unknown, ordinal: unknown): string {
    return `${id}:${ordinal ?? ''}:${message}`;
  }

  function rememberEcho(key: string): boolean {
    if (echoKeys.has(key)) return false;
    echoKeys.set(key, true);
    setTimeout(() => echoKeys.delete(key), 30 * 1000).unref?.();
    return true;
  }

  function activeSteamAccountId(): string | undefined {
    return getSteamAccountId() || undefined;
  }

  async function importFriendMessageHistory(id: string, steamAccountId: string | undefined, selfNamePromise: Promise<string>, current: () => boolean, signal: AbortSignal): Promise<boolean> {
    if (typeof steamUser.chat?.getFriendMessageHistory !== 'function') return false;
    const friendInfo = await settleMetadata<Persona>(getUserInfo(id), { player_name: id });
    const selfName = await selfNamePromise;
    let boundary: { lastTime: Date; lastOrdinal: number } | undefined;
    for (;;) {
      if (!current()) throw new Error('Steam history connection changed');
      const chat = steamUser.chat!;
      const response = await steamHistoryCall<{ messages?: SteamFriendHistoryMessage[]; more_available?: boolean }>(
        // Zero/omitted startTime invokes Steam's recent cutoff, even with paging.
        callback => chat.getFriendMessageHistory!(id, { maxCount: 100, wantBbcode: true, startTime: 1, ...boundary }, callback), historyTimeoutMs, signal);
      if (!current()) throw new Error('Steam history connection changed');
      if (!Array.isArray(response?.messages)) throw new Error('Invalid Steam history response');
      const messages = [...response.messages].sort((a, b) =>
        (a.server_timestamp?.getTime() || 0) - (b.server_timestamp?.getTime() || 0) || Number(a.ordinal || 0) - Number(b.ordinal || 0));
      for (const message of messages) {
        if (!current()) throw new Error('Steam history connection changed');
        const senderId = steamIdToString(message.sender);
        const echo = Boolean(senderId && senderId !== id);
        await persist({
          echo, steamAccountId, id,
          name: echo ? selfName : (friendInfo.player_name || friendInfo.personaName || id),
          message: typeof message.message === 'string' ? message.message : '',
          ordinal: message.ordinal ?? null,
          sentAt: message.server_timestamp instanceof Date ? message.server_timestamp.toISOString() : undefined,
          date: message.server_timestamp instanceof Date ? formatDate(message.server_timestamp) : undefined
        }, true, signal);
      }
      if (!response?.more_available) break;
      const oldest = messages[0];
      const at = oldest?.server_timestamp;
      const ordinal = Number(oldest?.ordinal);
      if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || oldest.ordinal == null
        || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff
        || boundary && (at > boundary.lastTime || (+at === +boundary.lastTime && ordinal >= boundary.lastOrdinal))) {
        throw new Error('Steam history pagination did not advance');
      }
      boundary = { lastTime: at, lastOrdinal: ordinal };
    }
    return true;
  }

  async function importLegacyChatHistory(id: string, steamAccountId: string | undefined, selfNamePromise: Promise<string>, current: () => boolean, signal: AbortSignal, requireIdentity = false): Promise<boolean> {
    if (!current()) throw new Error('Steam history connection changed');
    if (typeof steamUser.getChatHistory !== 'function') return false;
    const history = await steamHistoryCall<SteamHistoryMessage[]>(callback => steamUser.getChatHistory!(id, callback), historyTimeoutMs, signal);
    if (!current()) throw new Error('Steam history connection changed');
    const timestamp = (message: SteamHistoryMessage) => message.timestamp instanceof Date
      ? message.timestamp.getTime() : (message.timestamp || 0) * 1000;
    for (const message of [...(history || [])].sort((a, b) =>
      timestamp(a) - timestamp(b) || Number(a.ordinal || 0) - Number(b.ordinal || 0))) {
      if (!current()) throw new Error('Steam history connection changed');
      const senderId = steamIdToString(message.steamID || message.accountid);
      const echo = Boolean(senderId && senderId !== id);
      const at = message.timestamp ? new Date(timestamp(message)) : undefined;
      // Modern failures are retried. The real legacy SDK normally has no
      // ordinal, so replaying its rows would manufacture an extra archive entry
      // every retry, and again when modern recovery succeeds. Keep retrying the
      // modern source instead of guessing identity from body/time.
      if (requireIdentity && !steamEventKey(steamAccountId, id, echo, message.message || '', at, message.ordinal)) continue;
      await persist({
        echo,
        steamAccountId,
        id,
        name: echo ? await selfNamePromise : (message.accountid ? String(message.accountid) : 'Unknown'),
        message: message.message || '',
        ordinal: message.ordinal ?? null,
        sentAt: at?.toISOString(),
        date: at ? formatDate(at) : undefined
      }, true, signal);
    }
    return true;
  }

  const recovery = createHistoryRecovery({ steamUser, storage, account: activeSteamAccountId,
    steamId: steamIdToString, logger, track, retryMs: options.historyRetryMs ?? 30000, timeoutMs: historyTimeoutMs,
    async importHistory(id, steamAccountId, current, signal) {
      if (storage && !steamAccountId) throw new Error('Steam account is required for history');
      const selfName = settleMetadata(getSelfName(steamAccountId), 'Me');
      try {
        if (!await importFriendMessageHistory(id, steamAccountId, selfName, current, signal)) {
          await importLegacyChatHistory(id, steamAccountId, selfName, current, signal);
        }
      } catch (error) {
        // Legacy recovery can salvage rows, but cannot certify a failed modern
        // paginated import as complete. Retain the modern failure for retry.
        if (current()) await importLegacyChatHistory(id, steamAccountId, selfName, current, signal, Boolean(storage)).catch(() => {});
        throw error;
      }
    }
  });

  const onFriendMessage = async (event: SteamFriendMessageEvent) => {
    const id = event.id;
    const steamAccountId = activeSteamAccountId();
    try {
      if (storage && !steamAccountId) throw new Error('Steam account is required for history');
      const importing = recovery.request(id);
      if (storage) track(importing); else await importing;
      const info = await settleMetadata<Persona>(getUserInfo(event.steamID || id), { player_name: id });
      await persist({
        steamAccountId,
        id,
        name: info.player_name || info.personaName || id,
        message: event.message,
        ordinal: event.ordinal ?? null,
        sentAt: event.serverTimestamp?.toISOString(),
        date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
      });
    } catch (error) {
      logger.error?.('Failed to log friend message', { id, error: errorMessage(error) });
    }
  };

  const onFriendMessageEcho = async (event: SteamFriendMessageEvent) => {
    const id = event.id;
    const steamAccountId = activeSteamAccountId();
    const selfNamePromise = settleMetadata(getSelfName(steamAccountId), 'Me');
    const key = echoKey(`${steamAccountId || ''}:${id}:${event.serverTimestamp?.getTime() ?? ''}`, event.message, event.ordinal);
    // Storage coordinates complete event identities durably. Its metadata-poor
    // events must remain independent, rather than being merged by body here.
    if (!storage && !rememberEcho(key)) return;
    try {
      if (storage && !steamAccountId) throw new Error('Steam account is required for history');
      await persist({
        echo: true,
        steamAccountId,
        id,
        name: await selfNamePromise,
        message: event.message,
        ordinal: event.ordinal ?? null,
        sentAt: event.serverTimestamp?.toISOString(),
        date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
      });
    } catch (error) {
      logger.error?.('Failed to log echoed message', { id, error: errorMessage(error) });
    }
  };

  const unsubscribeEvents = subscribeFriendMessageEvents(steamUser, (event: SteamFriendMessageEvent) => {
    const task = event.echo ? onFriendMessageEcho(event) : onFriendMessage(event);
    track(task);
    task.catch((error) => logger.error?.('Failed to log Steam message event', { id: event.id, error: errorMessage(error) }));
  });
  const unsubscribe = () => { unsubscribeEvents(); recovery.stop(); };
  return Object.assign(unsubscribe, {
    async close(timeoutMs = 5000) {
      unsubscribe();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
        ]);
        if (pending.size) logger.warn?.('Message logger shutdown deadline reached', { pending: pending.size });
      } finally { if (timer) clearTimeout(timer); closed = true; }
    }
  });
}

module.exports = {
  createSteamMessageLogger
};
