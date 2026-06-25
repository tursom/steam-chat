'use strict';

import type { LoggerLike, Persona } from '../types';
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
  steamUser: SteamMessageLoggerUser;
  getUserInfo?: (steamID: unknown) => Promise<Persona>;
  getSelfName?: () => Promise<string>;
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

  async function importFriendMessageHistory(id: string): Promise<boolean> {
    if (typeof steamUser.chat?.getFriendMessageHistory !== 'function') return false;
    const response = await new Promise<{ messages?: SteamFriendHistoryMessage[] }>((resolve, reject) => {
      steamUser.chat?.getFriendMessageHistory?.(id, { maxCount: 100, wantBbcode: true }, (error: unknown, result?: { messages?: SteamFriendHistoryMessage[] }) => {
        if (error) reject(error);
        else resolve(result || {});
      });
    });
    const friendInfo = await getUserInfo(id).catch((): Persona => ({ player_name: id }));
    const selfName = await getSelfName();
    for (const message of response.messages || []) {
      const senderId = steamIdToString(message.sender);
      const echo = Boolean(senderId && senderId !== id);
      await appendLog({
        echo,
        steamAccountId: activeSteamAccountId(),
        id,
        name: echo ? selfName : (friendInfo.player_name || friendInfo.personaName || id),
        message: typeof message.message === 'string' ? message.message : '',
        ordinal: message.ordinal ?? null,
        date: message.server_timestamp instanceof Date ? formatDate(message.server_timestamp) : undefined
      }, { logPath });
    }
    return true;
  }

  async function importLegacyChatHistory(id: string): Promise<boolean> {
    if (typeof steamUser.getChatHistory !== 'function') return false;
    const history = await new Promise<SteamHistoryMessage[]>((resolve) => {
      steamUser.getChatHistory?.(id, (error: unknown, messages?: SteamHistoryMessage[]) => resolve(error ? [] : messages || []));
    });
    for (const message of history) {
      const senderId = steamIdToString(message.steamID || message.accountid);
      const echo = Boolean(senderId && senderId !== id);
      await appendLog({
        echo,
        steamAccountId: activeSteamAccountId(),
        id,
        name: echo ? await getSelfName() : (message.accountid ? String(message.accountid) : 'Unknown'),
        message: message.message || '',
        ordinal: message.ordinal ?? null,
        date: message.timestamp ? formatDate(new Date(message.timestamp * 1000)) : undefined
      }, { logPath });
    }
    return true;
  }

  async function maybeImportSteamHistory(id: string) {
    if (!id || importAttempts.has(id)) return;
    importAttempts.add(id);
    try {
      const imported = await importFriendMessageHistory(id);
      if (!imported) await importLegacyChatHistory(id);
    } catch (error) {
      try {
        await importLegacyChatHistory(id);
      } catch (fallbackError) {
        logger.warn?.('Steam history import failed', { id, error: errorMessage(fallbackError || error) });
      }
    }
  }

  const onFriendMessage = async (event: SteamFriendMessageEvent) => {
    const id = event.id;
    try {
      await maybeImportSteamHistory(id);
      const info = await getUserInfo(event.steamID || id);
      await appendLog({
        steamAccountId: activeSteamAccountId(),
        id,
        name: info.player_name || info.personaName || id,
        message: event.message,
        ordinal: event.ordinal ?? null,
        date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
      }, { logPath });
    } catch (error) {
      logger.error?.('Failed to log friend message', { id, error: errorMessage(error) });
    }
  };

  const onFriendMessageEcho = async (event: SteamFriendMessageEvent) => {
    const id = event.id;
    const key = echoKey(id, event.message, event.ordinal);
    if (!rememberEcho(key)) return;
    try {
      await appendLog({
        echo: true,
        steamAccountId: activeSteamAccountId(),
        id,
        name: await getSelfName(),
        message: event.message,
        ordinal: event.ordinal ?? null,
        date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
      }, { logPath });
    } catch (error) {
      logger.error?.('Failed to log echoed message', { id, error: errorMessage(error) });
    }
  };

  return subscribeFriendMessageEvents(steamUser, (event: SteamFriendMessageEvent) => {
    const task = event.echo ? onFriendMessageEcho(event) : onFriendMessage(event);
    task.catch((error) => logger.error?.('Failed to log Steam message event', { id: event.id, error: errorMessage(error) }));
  });
}

module.exports = {
  createSteamMessageLogger
};
