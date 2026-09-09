'use strict';

import { createHistoryStorage } from './storage/history-storage';
import type { CallbackStyleFunction, Persona, UnknownRecord } from './types';
import type { IncomingMessage } from 'node:http';
import { errorMessage, isRecord } from './types';

const winston = require('winston');

const { createAuthStore } = require('./auth/store');
const { createSessionManager } = require('./auth/session');
const { loadConfig } = require('./config/load');
const { AUTH_DB_PATH, REFRESH_TOKEN_PATH } = require('./paths');
const { getClientIp } = require('./server/auth');
const { createChatService } = require('./server/chat-service');
const { createSteamLoginService, readRefreshToken } = require('./steam/lifecycle');
const {
  steamIdToString
} = require('./storage/chat-log');
const { createSteamMessageLogger } = require('./steam/message-logger');

type PersonaResponse = UnknownRecord & {
  personas?: Persona[];
  users?: Record<string, Persona>;
};

type SteamUserMain = {
  users?: Record<string, Persona>;
  steamID?: unknown;
  getPersonas?: (ids: string[], callback: (error: unknown, response: PersonaResponse) => void) => void;
  chat?: {
    sendFriendMessage?: CallbackStyleFunction;
    getEmoticonList?: CallbackStyleFunction;
  };
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
  myFriends?: UnknownRecord;
  myGroups?: unknown;
  groups?: unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  logOn: (options: unknown) => void;
  webLogOn: () => void;
  setPersona?: (state: number) => void;
  EPersonaState?: { Online?: number };
  logOff?: () => void;
};

type SteamCommunityMain = {
  setCookies?: (cookies: string[]) => void;
  startConfirmationChecker?: (intervalMs: number, identitySecret: string) => void;
  sendImageToUser?: CallbackStyleFunction;
};

type SteamUserConstructor = new (options: { renewRefreshTokens: boolean; autoRelogin: boolean }) => SteamUserMain;
type SteamCommunityConstructor = new () => SteamCommunityMain;
type ChatServiceRuntime = {
  start: () => unknown;
  stop: () => Promise<void>;
  server: { closeAllConnections: () => void };
};
type LogInfo = {
  timestamp?: string;
  level: string;
  message: string;
  stack?: string;
};

const SteamCommunity = require('steamcommunity') as SteamCommunityConstructor;
const SteamUser = require('steam-user') as SteamUserConstructor;

const config = loadConfig();
// The application owns reconnects; SDK auto-relogin would race scheduleReconnect.
const steamUser = new SteamUser({ renewRefreshTokens: true, autoRelogin: false });
const steamCommunity = new SteamCommunity();
const users: Record<string, Persona> = {};
const authStore = createAuthStore({ dbPath: AUTH_DB_PATH });
const chatAuthConfig = isRecord(config.chat) && isRecord(config.chat.auth) ? config.chat.auth : {};
const sessionManager = createSessionManager({
  store: authStore,
  getClientIp: (req: IncomingMessage) => getClientIp(req, chatAuthConfig)
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info: LogInfo) => `${info.timestamp} ${info.level}: ${info.message}${info.stack ? `\n${info.stack}` : ''}`)
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const historyStorage = createHistoryStorage({ logger });

function getPersonaFromCache(id: string) {
  return users[id] || steamUser.users?.[id] || null;
}

function personaFromUnknown(value: unknown): Persona | null {
  return isRecord(value) ? value : null;
}

async function getUserInfo(value: unknown): Promise<Persona> {
  const id = steamIdToString(value);
  if (!id) return { player_name: 'Unknown' };
  const cached = getPersonaFromCache(id);
  if (cached) return cached;

  if (typeof steamUser.getPersonas !== 'function') {
    return { player_name: 'Unknown' };
  }

  try {
    const personas = await new Promise<PersonaResponse>((resolve, reject) => {
      steamUser.getPersonas?.([id], (error: unknown, response: PersonaResponse) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
    const persona = personas.personas?.[0] || personaFromUnknown(personas[id]) || personas.users?.[id] || null;
    if (persona) {
      users[id] = persona;
      return persona;
    }
  } catch (error) {
    logger.warn('Steam persona lookup failed', { id, error: errorMessage(error) });
  }
  return { player_name: 'Unknown' };
}

async function getSelfName(steamAccountId?: string) {
  const selfId = steamAccountId || steamIdToString(steamUser.steamID || config.steamID);
  if (!selfId) return 'Me';
  const info = await getUserInfo(selfId);
  return info.player_name || info.personaName || 'Me';
}

const lifecycle = createSteamLoginService({
  steamUser,
  steamCommunity,
  config: {
    steamID: typeof config.steamID === 'string' ? config.steamID : undefined,
    identitySecret: typeof config.identitySecret === 'string' ? config.identitySecret : undefined
  },
  logger,
  refreshTokenPath: REFRESH_TOKEN_PATH,
  getDefaultLogonID: authStore.getOrCreateSteamLogonID,
  onLoggedOn(steamId: string | null) {
    if (!steamId) return;
    authStore.upsertSteamAccount({
      steamId,
      refreshToken: readRefreshToken(REFRESH_TOKEN_PATH) || undefined,
      setActive: true
    });
  },
  onRefreshToken(refreshToken: string, steamId: string | null) {
    if (!steamId) return;
    authStore.upsertSteamAccount({
      steamId,
      refreshToken,
      setActive: true
    });
  }
});

const messageLogger = createSteamMessageLogger({
  historyStorage,
  steamUser,
  getUserInfo,
  getSelfName,
  getSteamAccountId: () => steamIdToString(steamUser.steamID || '') || authStore.getActiveSteamAccount(false)?.steamId,
  logger
});

let steamLoginPromise = lifecycle.waitForLogin();
let steamWebLoginPromise = lifecycle.waitForWebSession();
let chatService: ChatServiceRuntime | null = null;

function start() {
  const tokenLoginPromise = lifecycle.start().catch((error: unknown) => {
    logger.warn('Steam token login failed', { error: errorMessage(error) });
    return false;
  });
  steamLoginPromise = lifecycle.waitForLogin();
  steamWebLoginPromise = lifecycle.waitForWebSession();
  chatService = createChatService({
    historyStorage,
    config,
    steamUser,
    steamCommunity,
    logger,
    getUserInfo,
    getSelfName,
    waitForLogin: () => lifecycle.waitForLogin(),
    waitForWebSession: () => lifecycle.waitForWebSession(),
    refreshWebSession: lifecycle.refreshWebSession,
    authStore,
    sessionManager,
    steamLoginService: lifecycle
  });
  chatService.start();
  return tokenLoginPromise;
}

if (process.env.STEAM_CHAT_DISABLE_AUTOSTART !== '1') {
  start().catch((error: unknown) => {
    logger.error('Steam startup failed', { error: errorMessage(error) });
  });
}

let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  return shutdownPromise ||= (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      messageLogger();
      await Promise.race([
        chatService?.stop(),
        new Promise<void>((resolve) => { timer = setTimeout(() => {
          logger.warn('Chat shutdown deadline reached');
          chatService?.server.closeAllConnections();
          resolve();
        }, 5000); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      try { await messageLogger.close(); }
      finally {
        lifecycle.stop();
        await historyStorage.close();
        authStore.close();
      }
    }
  })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      logger.error('Steam shutdown failed', { error: errorMessage(error) });
      process.exitCode = 1;
    });
  });
}

module.exports = {
  historyStorage,
  shutdown,
  authStore,
  chatService,
  config,
  getSelfName,
  getUserInfo,
  lifecycle,
  logger,
  sessionManager,
  start,
  steamCommunity,
  steamLoginPromise,
  steamUser,
  steamWebLoginPromise,
  users
};
