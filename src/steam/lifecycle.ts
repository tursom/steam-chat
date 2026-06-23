'use strict';

import type { LoggerLike } from '../types';
import { errorCode, errorMessage, isRecord } from '../types';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REFRESH_TOKEN_PATH = path.resolve(__dirname, '..', '..', 'refresh.token');
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type RefreshTokenFileSystem = Pick<typeof import('node:fs'), 'readFileSync' | 'mkdirSync' | 'writeFileSync'>;

type TimerHandle = ReturnType<typeof setTimeout> | number;

type TimerApi = {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

type LogOnOptions = {
  logonID?: number;
  steamID?: string;
  refreshToken?: string;
  accountName?: string;
  password?: string;
};

type SteamLifecycleConfig = {
  accountName?: string;
  password?: string;
  logonID?: number;
  steamID?: string;
  identitySecret?: string;
};

type WebSession = {
  sessionID: string;
  cookies: string[];
};

type SteamUserLifecycleLike = {
  on: {
    (event: 'loggedOn', listener: () => void): void;
    (event: 'webSession', listener: (sessionID: string, cookies: string[]) => void): void;
    (event: 'refreshToken', listener: (refreshToken: string) => void): void;
    (event: 'error', listener: (error: unknown) => void): void;
    (event: 'disconnected', listener: (eresult: unknown, message?: string) => void): void;
  };
  logOn: (options: LogOnOptions) => void;
  webLogOn: () => void;
  setPersona?: (state: number) => void;
  EPersonaState?: { Online?: number };
  logOff?: () => void;
};

type SteamCommunityLifecycleLike = {
  setCookies?: (cookies: string[]) => void;
  startConfirmationChecker?: (intervalMs: number, identitySecret: string) => void;
};

type SteamLifecycleOptions = {
  steamUser: SteamUserLifecycleLike;
  steamCommunity?: SteamCommunityLifecycleLike | null;
  config?: SteamLifecycleConfig;
  logger?: LoggerLike;
  refreshTokenPath?: string;
  fileSystem?: RefreshTokenFileSystem;
  timers?: TimerApi;
};

function createDeferred<T = unknown>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

function codeOf(error: unknown): string {
  if (!error) return '';
  return errorCode(error).toLowerCase();
}

function isUnrecoverableLoginError(error: unknown): boolean {
  const text = codeOf(error);
  return [
    'invalidpassword',
    'accountlogindenied',
    'accountdisabled',
    'logindenied',
    'rate',
    'captcha',
    'twofactor',
    'steamguard',
    'accessdenied',
    'invalid login'
  ].some((needle) => text.includes(needle.toLowerCase()));
}

function isRecoverableLoginError(error: unknown): boolean {
  if (!error) return true;
  if (isUnrecoverableLoginError(error)) return false;
  const text = codeOf(error);
  return [
    'timeout',
    'timedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'enet',
    'socket',
    'tls',
    'serviceunavailable',
    'tryanothercm',
    'loggedinelsewhere',
    'disconnected',
    'connect',
    'network'
  ].some((needle) => text.includes(needle));
}

function readRefreshToken(refreshTokenPath: string, fileSystem: RefreshTokenFileSystem = fs): string | null {
  try {
    const token = fileSystem.readFileSync(refreshTokenPath, 'utf8').trim();
    return token || null;
  } catch (error) {
    if (isRecord(error) && error.code !== 'ENOENT') {
      throw error;
    }
    return null;
  }
}

function buildLogOnOptions(config: SteamLifecycleConfig, refreshTokenPath: string, fileSystem: RefreshTokenFileSystem = fs): LogOnOptions {
  const refreshToken = readRefreshToken(refreshTokenPath, fileSystem);
  const base: LogOnOptions = {};
  if (config.logonID !== undefined) base.logonID = config.logonID;
  if (config.steamID) base.steamID = config.steamID;
  if (refreshToken) {
    return { ...base, refreshToken };
  }
  return {
    ...base,
    accountName: config.accountName,
    password: config.password
  };
}

function createSteamLifecycle(options: SteamLifecycleOptions) {
  const {
    steamUser,
    steamCommunity,
    config = {},
    logger = console,
    refreshTokenPath = DEFAULT_REFRESH_TOKEN_PATH,
    fileSystem = fs,
    timers = { setTimeout, clearTimeout }
  } = options;

  if (!steamUser) {
    throw new Error('steamUser is required');
  }

  let loginDeferred = createDeferred<boolean>();
  let webDeferred = createDeferred<WebSession>();
  let retryTimer: TimerHandle | null = null;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let stopped = false;
  let latestWebSession: WebSession | null = null;

  function log(level: 'info' | 'warn' | 'error', message: string, meta?: unknown) {
    const method = logger[level] || logger.log || (() => {});
    method.call(logger, message, meta);
  }

  function clearRetryTimer() {
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function logOn() {
    if (stopped) return;
    const optionsForLogin = buildLogOnOptions(config, refreshTokenPath, fileSystem);
    if (!optionsForLogin.refreshToken && (!optionsForLogin.accountName || !optionsForLogin.password)) {
      const error = new Error('Steam credentials are missing. Configure accountName/password or refresh.token.');
      loginDeferred.reject(error);
      throw error;
    }
    log('info', optionsForLogin.refreshToken ? 'Logging on Steam with refresh token' : 'Logging on Steam with account credentials');
    steamUser.logOn(optionsForLogin);
  }

  function scheduleRetry(reason: unknown) {
    if (stopped || retryTimer) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    log('warn', `Steam login retry scheduled in ${delay} ms`, { reason: errorMessage(reason) });
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      try {
        logOn();
      } catch (error) {
        handleError(error);
      }
    }, delay);
  }

  function handleError(error: unknown) {
    if (stopped) return;
    if (isRecoverableLoginError(error)) {
      scheduleRetry(error);
      return;
    }
    log('error', 'Steam login failed with unrecoverable error', { error: errorMessage(error) });
    loginDeferred.reject(error);
    webDeferred.reject(error);
  }

  function refreshWebSession(): Promise<WebSession> {
    if (stopped) return Promise.reject(new Error('Steam lifecycle is stopped'));
    webDeferred = createDeferred<WebSession>();
    try {
      steamUser.webLogOn();
    } catch (error) {
      webDeferred.reject(error);
    }
    return webDeferred.promise;
  }

  steamUser.on('loggedOn', () => {
    clearRetryTimer();
    retryDelayMs = INITIAL_RETRY_DELAY_MS;
    log('info', 'Steam logged on');
    loginDeferred.resolve(true);
    try {
      steamUser.setPersona?.(steamUser.EPersonaState?.Online || 1);
    } catch (_) {
      // setPersona is optional and not important enough to break startup.
    }
    refreshWebSession().catch((error: unknown) => {
      log('warn', 'Steam webLogOn failed after login', { error: errorMessage(error) });
    });
  });

  steamUser.on('webSession', (sessionID: string, cookies: string[]) => {
    latestWebSession = { sessionID, cookies };
    if (steamCommunity && typeof steamCommunity.setCookies === 'function') {
      steamCommunity.setCookies(cookies);
    }
    if (steamCommunity && config.identitySecret && typeof steamCommunity.startConfirmationChecker === 'function') {
      steamCommunity.startConfirmationChecker(10 * 1000, config.identitySecret);
    }
    webDeferred.resolve(latestWebSession);
  });

  steamUser.on('refreshToken', (refreshToken: string) => {
    if (!refreshToken) return;
    fileSystem.mkdirSync(path.dirname(refreshTokenPath), { recursive: true });
    fileSystem.writeFileSync(refreshTokenPath, `${refreshToken}\n`, 'utf8');
    log('info', 'Steam refresh token saved');
  });

  steamUser.on('error', handleError);
  steamUser.on('disconnected', (eresult: unknown, message?: string) => {
    handleError(new Error(message || `Steam disconnected: ${eresult || 'unknown'}`));
  });

  return {
    start() {
      stopped = false;
      logOn();
      return loginDeferred.promise;
    },
    stop() {
      stopped = true;
      clearRetryTimer();
      if (typeof steamUser.logOff === 'function') {
        steamUser.logOff();
      }
    },
    waitForLogin() {
      return loginDeferred.promise;
    },
    waitForWebSession() {
      return webDeferred.promise;
    },
    refreshWebSession,
    getLatestWebSession() {
      return latestWebSession;
    },
    getRetryDelayMs() {
      return retryDelayMs;
    }
  };
}

module.exports = {
  DEFAULT_REFRESH_TOKEN_PATH,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  buildLogOnOptions,
  createDeferred,
  createSteamLifecycle,
  isRecoverableLoginError,
  isUnrecoverableLoginError,
  readRefreshToken
};
