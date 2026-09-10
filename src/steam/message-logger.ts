'use strict';

import { settleMetadata } from './metadata';
import { imageEchoIdentity, steamEventKey } from '../storage/history-message';
import type { HistoryStorage } from '../storage/history-storage';
import type { LoggerLike, Persona, HistoryRecordInput } from '../types';
import type { SteamFriendMessageEvent, SteamFriendMessageEventUser } from './friend-message-events';
import { errorMessage } from '../types';

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
  timestamp?: number;
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
      options: { maxCount: number; wantBbcode: boolean },
      callback: (error: unknown, response?: { messages?: SteamFriendHistoryMessage[] }) => void
    ) => void;
};

type SteamMessageLoggerUser = SteamFriendMessageEventUser & {
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
};

function createSteamMessageLogger(options: SteamMessageLoggerOptions) {
  const { steamUser, getSelfName = async () => 'Me', getSteamAccountId = () => null, logPath = DEFAULT_LOG_PATH, logger = console } = options;
  const getUserInfo: (steamID: unknown) => Promise<Persona> = options.getUserInfo || (async () => ({ player_name: 'Unknown' }));
  if (!steamUser || typeof steamUser.on !== 'function') {
    throw new Error('steamUser EventEmitter is required');
  }

  const storage = options.historyStorage;
  const pending = new Set<Promise<unknown>>();
  function track(task: Promise<unknown>) {
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
  }
  let closed = false;
  function persist(record: HistoryRecordInput, historical = false) {
    if (closed) throw new Error('Message logger closed');
    record.imageSendSource = record.echo && !historical ? 'echo' : undefined;
    const at = record.sentAt || record.date;
    record.steamEventKey = steamEventKey(record.steamAccountId, String(record.id), Boolean(record.echo), record.message || '',
      at ? new Date(at.replace(' ', 'T')) : undefined, record.ordinal);
    if (storage?.appendSteamImage && record.steamEventKey && imageEchoIdentity({ ...record, imageSendSource: 'echo' })) {
      return storage.appendSteamImage(record, { notify: !historical });
    }
    return storage ? storage.append(record, { notify: !historical }) : appendLog(record, { logPath });
  }
  const echoKeys = new Map<string, boolean>();
  const importAttempts = new Set<string>();

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

  async function importFriendMessageHistory(id: string, steamAccountId: string | undefined, selfNamePromise: Promise<string>): Promise<boolean> {
    if (typeof steamUser.chat?.getFriendMessageHistory !== 'function') return false;
    const response = await new Promise<{ messages?: SteamFriendHistoryMessage[] }>((resolve, reject) => {
      steamUser.chat?.getFriendMessageHistory?.(id, { maxCount: 100, wantBbcode: true }, (error: unknown, result?: { messages?: SteamFriendHistoryMessage[] }) => {
        if (error) reject(error);
        else resolve(result || {});
      });
    });
    const friendInfo = await settleMetadata<Persona>(getUserInfo(id), { player_name: id });
    const selfName = await selfNamePromise;
    for (const message of response.messages || []) {
      const senderId = steamIdToString(message.sender);
      const echo = Boolean(senderId && senderId !== id);
      await persist({
        echo,
        steamAccountId,
        id,
        name: echo ? selfName : (friendInfo.player_name || friendInfo.personaName || id),
        message: typeof message.message === 'string' ? message.message : '',
        ordinal: message.ordinal ?? null,
        sentAt: message.server_timestamp instanceof Date ? message.server_timestamp.toISOString() : undefined,
        date: message.server_timestamp instanceof Date ? formatDate(message.server_timestamp) : undefined
      }, true);
    }
    return true;
  }

  async function importLegacyChatHistory(id: string, steamAccountId: string | undefined, selfNamePromise: Promise<string>): Promise<boolean> {
    if (storage && activeSteamAccountId() !== steamAccountId) return false;
    if (typeof steamUser.getChatHistory !== 'function') return false;
    const history = await new Promise<SteamHistoryMessage[]>((resolve) => {
      steamUser.getChatHistory?.(id, (error: unknown, messages?: SteamHistoryMessage[]) => resolve(error ? [] : messages || []));
    });
    for (const message of history) {
      const senderId = steamIdToString(message.steamID || message.accountid);
      const echo = Boolean(senderId && senderId !== id);
      await persist({
        echo,
        steamAccountId,
        id,
        name: echo ? await selfNamePromise : (message.accountid ? String(message.accountid) : 'Unknown'),
        message: message.message || '',
        ordinal: message.ordinal ?? null,
        sentAt: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : undefined,
        date: message.timestamp ? formatDate(new Date(message.timestamp * 1000)) : undefined
      }, true);
    }
    return true;
  }

  async function maybeImportSteamHistory(id: string, steamAccountId: string | undefined, selfNamePromise: Promise<string>) {
    const key = `${steamAccountId || ''}:${id}`;
    if (!id || importAttempts.has(key)) return;
    importAttempts.add(key);
    try {
      const imported = await importFriendMessageHistory(id, steamAccountId, selfNamePromise);
      if (!imported) await importLegacyChatHistory(id, steamAccountId, selfNamePromise);
    } catch (error) {
      try {
        await importLegacyChatHistory(id, steamAccountId, selfNamePromise);
      } catch (fallbackError) {
        logger.warn?.('Steam history import failed', { id, error: errorMessage(fallbackError || error) });
      }
    }
  }

  const onFriendMessage = async (event: SteamFriendMessageEvent) => {
    const id = event.id;
    const steamAccountId = activeSteamAccountId();
    const selfNamePromise = settleMetadata(getSelfName(steamAccountId), 'Me');
    try {
      if (storage && !steamAccountId) throw new Error('Steam account is required for history');
      const importing = maybeImportSteamHistory(id, steamAccountId, selfNamePromise);
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
    if (!rememberEcho(key)) return;
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

  const unsubscribe = subscribeFriendMessageEvents(steamUser, (event: SteamFriendMessageEvent) => {
    const task = event.echo ? onFriendMessageEcho(event) : onFriendMessage(event);
    track(task);
    task.catch((error) => logger.error?.('Failed to log Steam message event', { id: event.id, error: errorMessage(error) }));
  });
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
