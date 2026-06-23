'use strict';

import type { LoggerLike, Persona } from '../types';
import { errorMessage } from '../types';

const {
  DEFAULT_LOG_PATH,
  appendLog,
  formatDate,
  steamIdToString
} = require('../storage/chat-log');

type SteamHistoryMessage = {
  imageUrl?: string | null;
  accountid?: string | number;
  message?: string;
  ordinal?: string | number | null;
  timestamp?: number;
};

type SteamMessageLoggerUser = {
  on: {
    (event: 'friendMessage', listener: (steamID: unknown, message: unknown, type?: unknown, chatter?: unknown, ordinal?: unknown) => void): void;
    (event: 'friendMessageEcho', listener: (steamID: unknown, message: unknown, ordinal?: unknown) => void): void;
  };
  off?: {
    (event: 'friendMessage', listener: (steamID: unknown, message: unknown, type?: unknown, chatter?: unknown, ordinal?: unknown) => void): void;
    (event: 'friendMessageEcho', listener: (steamID: unknown, message: unknown, ordinal?: unknown) => void): void;
  };
  getChatHistory?: (id: string, callback: (error: unknown, messages?: SteamHistoryMessage[]) => void) => void;
};

type SteamMessageLoggerOptions = {
  steamUser: SteamMessageLoggerUser;
  getUserInfo?: (steamID: unknown) => Promise<Persona>;
  getSelfName?: () => Promise<string>;
  logPath?: string;
  logger?: LoggerLike;
};

function createSteamMessageLogger(options: SteamMessageLoggerOptions) {
  const { steamUser, getSelfName = async () => 'Me', logPath = DEFAULT_LOG_PATH, logger = console } = options;
  const getUserInfo: (steamID: unknown) => Promise<Persona> = options.getUserInfo || (async () => ({ player_name: 'Unknown' }));
  if (!steamUser || typeof steamUser.on !== 'function') {
    throw new Error('steamUser EventEmitter is required');
  }

  const echoKeys = new Map<string, boolean>();
  const importAttempts = new Set<string>();

  function echoKey(id: string, message: unknown, ordinal: unknown): string {
    return `${id}:${ordinal || ''}:${message}`;
  }

  function rememberEcho(key: string): boolean {
    if (echoKeys.has(key)) return false;
    echoKeys.set(key, true);
    setTimeout(() => echoKeys.delete(key), 30 * 1000).unref?.();
    return true;
  }

  async function maybeImportSteamHistory(id: string) {
    if (!id || importAttempts.has(id) || typeof steamUser.getChatHistory !== 'function') return;
    importAttempts.add(id);
    try {
      const history = await new Promise<SteamHistoryMessage[]>((resolve) => {
        steamUser.getChatHistory?.(id, (error: unknown, messages?: SteamHistoryMessage[]) => resolve(error ? [] : messages || []));
      });
      for (const message of history) {
        await appendLog({
          type: message.imageUrl ? 'image' : 'message',
          id,
          name: message.accountid ? String(message.accountid) : 'Unknown',
          message: message.message || '',
          imageUrl: message.imageUrl || null,
          ordinal: message.ordinal ?? null,
          date: message.timestamp ? formatDate(new Date(message.timestamp * 1000)) : undefined
        }, { logPath });
      }
    } catch (error) {
      logger.warn?.('Steam history import failed', { id, error: errorMessage(error) });
    }
  }

  const onFriendMessage = async (steamID: unknown, message: unknown, type?: unknown, chatter?: unknown, ordinal?: unknown) => {
    const id = steamIdToString(steamID);
    try {
      await maybeImportSteamHistory(id);
      const info = await getUserInfo(steamID);
      await appendLog({
        type: 'message',
        id,
        name: info.player_name || info.personaName || id,
        message: typeof message === 'string' ? message : '',
        ordinal: typeof ordinal === 'string' || typeof ordinal === 'number' ? ordinal : null
      }, { logPath });
    } catch (error) {
      logger.error?.('Failed to log friend message', { id, error: errorMessage(error) });
    }
  };

  const onFriendMessageEcho = async (steamID: unknown, message: unknown, ordinal?: unknown) => {
    const id = steamIdToString(steamID);
    const key = echoKey(id, message, ordinal);
    if (!rememberEcho(key)) return;
    try {
      await appendLog({
        type: 'message',
        echo: true,
        id,
        name: await getSelfName(),
        message: typeof message === 'string' ? message : '',
        ordinal: typeof ordinal === 'string' || typeof ordinal === 'number' ? ordinal : null
      }, { logPath });
    } catch (error) {
      logger.error?.('Failed to log echoed message', { id, error: errorMessage(error) });
    }
  };

  steamUser.on('friendMessage', onFriendMessage);
  steamUser.on('friendMessageEcho', onFriendMessageEcho);

  return () => {
    steamUser.off?.('friendMessage', onFriendMessage);
    steamUser.off?.('friendMessageEcho', onFriendMessageEcho);
  };
}

module.exports = {
  createSteamMessageLogger
};
