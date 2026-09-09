'use strict';

import type { LoggerLike } from '../types';
import { errorCode, errorMessage, isRecord } from '../types';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REFRESH_TOKEN_PATH = path.resolve(__dirname, '..', '..', 'refresh.token');
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

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
    (event: 'steamGuard', listener: (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => void): void;
    (event: 'error', listener: (error: unknown) => void): void;
    (event: 'disconnected', listener: (eresult: unknown, message?: string) => void): void;
  };
  steamID?: unknown;
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

type SteamStatus = 'logged_out' | 'logging_in' | 'waiting_guard' | 'online' | 'error' | 'reconnecting';

type SteamGuardInfo = {
  guardType: 'email' | 'device';
  domain: string | null;
  lastCodeWrong: boolean;
};

type SteamStatusSummary = {
  status: SteamStatus;
  requiresGuard: boolean;
  guardType: 'email' | 'device' | null;
  domain: string | null;
  lastCodeWrong: boolean;
  error: string | null;
  steamId: string | null;
};

type SteamLoginRequest = {
  accountName?: unknown;
  password?: unknown;
  logonID?: unknown;
};

type SteamLoginServiceOptions = SteamLifecycleOptions & {
  getDefaultLogonID?: () => number;
  onLoggedOn?: (steamId: string | null) => void;
  onRefreshToken?: (refreshToken: string, steamId: string | null) => void;
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

function deleteRefreshToken(refreshTokenPath: string) {
  try {
    fs.unlinkSync(refreshTokenPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
}

function steamIdToText(value: unknown): string | null {
  if (!value) return null;
  if (isRecord(value) && typeof value.getSteamID64 === 'function') return String(value.getSteamID64.call(value));
  if (isRecord(value) && value.steamid) return String(value.steamid);
  return String(value);
}

function steamUnavailableError(status: SteamStatus) {
  return Object.assign(new Error('Steam is not logged in'), {
    statusCode: 503,
    steamStatus: status
  });
}

function createHandledDeferred<T = unknown>(): Deferred<T> {
  const deferred = createDeferred<T>();
  deferred.promise.catch(() => {});
  return deferred;
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

function createSteamLoginService(options: SteamLoginServiceOptions) {
  const {
    steamUser,
    steamCommunity,
    config = {},
    logger = console,
    refreshTokenPath = DEFAULT_REFRESH_TOKEN_PATH,
    fileSystem = fs,
    timers = { setTimeout, clearTimeout },
    getDefaultLogonID,
    onLoggedOn,
    onRefreshToken
  } = options;

  if (!steamUser) {
    throw new Error('steamUser is required');
  }

  let status: SteamStatus = 'logged_out';
  let lastError: string | null = null;
  let guard: SteamGuardInfo | null = null;
  let pendingGuardCallback: ((code: string) => void) | null = null;
  let loginDeferred = createHandledDeferred<boolean>();
  let webDeferred = createHandledDeferred<WebSession>();
  let retryTimer: TimerHandle | null = null;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let latestWebSession: WebSession | null = null;
  let stopped = false;
  let manualLogoff = false;
  let retired = false;
  let handlingFailure = false;
  let loginTimer: TimerHandle | null = null;
  let loginGeneration = 0;
  let retryGeneration = 0;
  let steamId: string | null = null;

  function clearLoginTimer() {
    loginGeneration += 1;
    if (loginTimer !== null) timers.clearTimeout(loginTimer);
    loginTimer = null;
  }

  function assertReusable() {
    if (stopped || retired) {
      throw Object.assign(new Error('Steam login client is stopped; restart the service to log in'), { statusCode: 503 });
    }
    if (manualLogoff || steamUser.steamID && status !== 'online') {
      throw Object.assign(new Error('Steam logout is still in progress'), { statusCode: 409 });
    }
  }

  function armLoginTimer() {
    clearLoginTimer();
    const generation = loginGeneration;
    loginTimer = timers.setTimeout(() => {
      if (generation !== loginGeneration || status !== 'logging_in' || stopped || retired) return;
      clearLoginTimer();
      clearRetryTimer();
      // logOff cancels retry timers, but cannot acknowledge cancellation of async auth work.
      // Do not reuse this client after an unbounded SDK attempt.
      retired = true;
      status = 'error';
      lastError = 'Steam login timed out after 120000 ms; restart the service to retry';
      guard = null;
      pendingGuardCallback = null;
      const error = new Error(lastError);
      loginDeferred.reject(error);
      webDeferred.reject(error);
      log('error', lastError);
      steamUser.logOff?.();
    }, LOGIN_TIMEOUT_MS);
    if (typeof loginTimer === 'object') loginTimer.unref?.();
  }

  function log(level: 'info' | 'warn' | 'error', message: string, meta?: unknown) {
    const method = logger[level] || logger.log || (() => {});
    method.call(logger, message, meta);
  }

  function callHook(name: 'onLoggedOn' | 'onRefreshToken', callback: (() => void) | undefined) {
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      log('warn', `${name} hook failed`, { error: errorMessage(error) });
    }
  }

  function resetDeferreds() {
    loginDeferred = createHandledDeferred<boolean>();
    webDeferred = createHandledDeferred<WebSession>();
  }

  function clearRetryTimer() {
    retryGeneration += 1;
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function baseLoginOptions(): LogOnOptions {
    const base: LogOnOptions = {};
    if (config.steamID) base.steamID = config.steamID;
    return base;
  }

  function beginLogin(logOnOptions: LogOnOptions, label: string) {
    assertReusable();
    clearRetryTimer();
    resetDeferreds();
    status = 'logging_in';
    guard = null;
    pendingGuardCallback = null;
    lastError = null;
    try {
      log('info', `Logging on Steam with ${label}`);
      armLoginTimer();
      steamUser.logOn(logOnOptions);
    } catch (error) {
      handleLoginFailure(error);
    }
    return loginDeferred.promise;
  }

  function tryTokenLogin(nextStatus: SteamStatus = 'logging_in'): Promise<boolean> {
    const refreshToken = readRefreshToken(refreshTokenPath, fileSystem);
    if (!refreshToken) {
      status = 'logged_out';
      guard = null;
      pendingGuardCallback = null;
      return Promise.resolve(false);
    }
    status = nextStatus;
    const logOnOptions = { ...baseLoginOptions(), refreshToken };
    return beginLogin(logOnOptions, 'refresh token');
  }

  function scheduleReconnect(reason: unknown) {
    if (stopped || retired || manualLogoff || retryTimer !== null) return;
    const refreshToken = readRefreshToken(refreshTokenPath, fileSystem);
    if (!refreshToken) {
      status = 'logged_out';
      return;
    }
    status = 'reconnecting';
    lastError = errorMessage(reason);
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    log('warn', `Steam reconnect scheduled in ${delay} ms`, { reason: errorMessage(reason) });
    const generation = retryGeneration;
    retryTimer = timers.setTimeout(() => {
      if (generation !== retryGeneration) return;
      retryTimer = null;
      if (stopped || retired || manualLogoff) return;
      try {
        tryTokenLogin('reconnecting').catch(() => {});
      } catch (error) {
        handleLoginFailure(error);
      }
    }, delay);
  }

  function handleLoginFailure(error: unknown, disconnected = false) {
    if (handlingFailure || stopped || retired || manualLogoff || status === 'logged_out' || status === 'error') return;
    const recoverable = disconnected || isRecoverableLoginError(error);
    if (retryTimer !== null && recoverable) return;
    clearRetryTimer();
    clearLoginTimer();
    latestWebSession = null;
    steamId = null;
    loginDeferred.reject(error);
    webDeferred.reject(error);
    // Transport errors can leave SDK connection retries active even with autoRelogin off.
    handlingFailure = true;
    try { steamUser.logOff?.(); }
    finally { handlingFailure = false; }
    lastError = errorMessage(error);
    guard = null;
    pendingGuardCallback = null;
    if (recoverable) {
      scheduleReconnect(error);
      return;
    }
    status = 'error';
    log('error', 'Steam login failed', { error: lastError });
  }

  function refreshWebSession(): Promise<WebSession> {
    if (stopped || retired || status !== 'online') return Promise.reject(steamUnavailableError(status));
    webDeferred = createHandledDeferred<WebSession>();
    try {
      steamUser.webLogOn();
    } catch (error) {
      webDeferred.reject(error);
    }
    return webDeferred.promise;
  }

  steamUser.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
    if (stopped || retired || manualLogoff || status !== 'logging_in') return;
    clearLoginTimer();
    status = 'waiting_guard';
    guard = {
      guardType: typeof domain === 'string' ? 'email' : 'device',
      domain: typeof domain === 'string' ? domain : null,
      lastCodeWrong: Boolean(lastCodeWrong)
    };
    pendingGuardCallback = callback;
    lastError = lastCodeWrong ? 'Steam Guard code was rejected' : null;
  });

  steamUser.on('loggedOn', () => {
    if (stopped || retired || manualLogoff || (status !== 'logging_in' && status !== 'waiting_guard')) {
      if (status !== 'online') steamUser.logOff?.();
      return;
    }
    clearLoginTimer();
    clearRetryTimer();
    retryDelayMs = INITIAL_RETRY_DELAY_MS;
    status = 'online';
    guard = null;
    pendingGuardCallback = null;
    lastError = null;
    steamId = steamIdToText(steamUser.steamID);
    loginDeferred.resolve(true);
    callHook('onLoggedOn', () => onLoggedOn?.(steamId));
    log('info', 'Steam logged on');
    try {
      steamUser.setPersona?.(steamUser.EPersonaState?.Online || 1);
    } catch (_) {
      // setPersona is optional and not important enough to break runtime login.
    }
    refreshWebSession().catch((error: unknown) => {
      log('warn', 'Steam webLogOn failed after login', { error: errorMessage(error) });
    });
  });

  steamUser.on('webSession', (sessionID: string, cookies: string[]) => {
    if (stopped || retired || manualLogoff || status !== 'online') return;
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
    if (!refreshToken || stopped || retired || manualLogoff || (status !== 'logging_in' && status !== 'online')) return;
    fileSystem.mkdirSync(path.dirname(refreshTokenPath), { recursive: true });
    fileSystem.writeFileSync(refreshTokenPath, `${refreshToken}\n`, 'utf8');
    callHook('onRefreshToken', () => onRefreshToken?.(refreshToken, steamId));
    log('info', 'Steam refresh token saved');
  });

  steamUser.on('error', handleLoginFailure);

  steamUser.on('disconnected', (eresult: unknown, message?: string) => {
    if (stopped || retired) return;
    if (manualLogoff) {
      manualLogoff = false;
      return;
    }
    const error = new Error(message || `Steam disconnected: ${eresult || 'unknown'}`);
    handleLoginFailure(error, status === 'online' || status === 'reconnecting');
  });

  function getStatus(): SteamStatusSummary {
    return {
      status,
      requiresGuard: status === 'waiting_guard',
      guardType: guard?.guardType || null,
      domain: guard?.domain || null,
      lastCodeWrong: Boolean(guard?.lastCodeWrong),
      error: lastError,
      steamId
    };
  }

  return {
    start() {
      assertReusable();
      if (status === 'online') return Promise.resolve(true);
      if (status === 'logging_in' || status === 'waiting_guard' || status === 'reconnecting') return loginDeferred.promise;
      return tryTokenLogin();
    },
    stop() {
      const pendingLogin = status === 'logging_in' || status === 'waiting_guard';
      stopped = true;
      clearRetryTimer();
      clearLoginTimer();
      status = 'logged_out';
      guard = null;
      pendingGuardCallback = null;
      latestWebSession = null;
      steamId = null;
      const error = new Error('Steam login service is stopped');
      loginDeferred.reject(error);
      webDeferred.reject(error);
      if (typeof steamUser.logOff === 'function') steamUser.logOff();
      // logOn itself is deferred by the SDK; also cancel after that queued tick.
      if (pendingLogin) process.nextTick(() => steamUser.logOff?.());
    },
    login(input: SteamLoginRequest) {
      assertReusable();
      if (status === 'logging_in' || status === 'waiting_guard' || status === 'reconnecting' || status === 'online') {
        throw Object.assign(new Error('Steam login is already active'), { statusCode: 409 });
      }
      const accountName = String(input.accountName || '').trim();
      const password = String(input.password || '');
      if (!accountName || !password) {
        throw Object.assign(new Error('accountName and password are required'), { statusCode: 400 });
      }
      const parsedLogonID = Number(input.logonID);
      const logonID = Number.isFinite(parsedLogonID) && parsedLogonID > 0
        ? Math.floor(parsedLogonID)
        : getDefaultLogonID?.();
      const optionsForLogin: LogOnOptions = {
        ...baseLoginOptions(),
        accountName,
        password
      };
      if (logonID) optionsForLogin.logonID = logonID;
      beginLogin(optionsForLogin, 'account credentials').catch(() => {});
      return getStatus();
    },
    connectWithRefreshToken(refreshToken: unknown, steamID?: unknown) {
      assertReusable();
      if (status === 'logging_in' || status === 'waiting_guard' || status === 'reconnecting' || status === 'online') {
        throw Object.assign(new Error('Steam login is already active'), { statusCode: 409 });
      }
      const token = String(refreshToken || '').trim();
      if (!token) throw Object.assign(new Error('Steam account refresh token is missing'), { statusCode: 409 });
      const logOnOptions: LogOnOptions = {
        ...baseLoginOptions(),
        refreshToken: token
      };
      if (steamID) logOnOptions.steamID = String(steamID);
      beginLogin(logOnOptions, 'stored refresh token').catch(() => {});
      return getStatus();
    },
    submitGuard(code: unknown) {
      const value = String(code || '').trim();
      if (!value) throw Object.assign(new Error('Steam Guard code is required'), { statusCode: 400 });
      if (status !== 'waiting_guard' || !pendingGuardCallback) {
        throw Object.assign(new Error('Steam Guard is not pending'), { statusCode: 409 });
      }
      const callback = pendingGuardCallback;
      pendingGuardCallback = null;
      guard = null;
      lastError = null;
      status = 'logging_in';
      armLoginTimer();
      try {
        callback(value);
      } catch (error) {
        handleLoginFailure(error);
      }
      return getStatus();
    },
    logout() {
      clearRetryTimer();
      clearLoginTimer();
      retired ||= status === 'logging_in' || status === 'waiting_guard';
      manualLogoff = status === 'online';
      const error = new Error('Steam logged out');
      loginDeferred.reject(error);
      webDeferred.reject(error);
      guard = null;
      pendingGuardCallback = null;
      latestWebSession = null;
      steamId = null;
      lastError = null;
      status = 'logged_out';
      resetDeferreds();
      deleteRefreshToken(refreshTokenPath);
      if (typeof steamUser.logOff === 'function') steamUser.logOff();
      if (retired) process.nextTick(() => steamUser.logOff?.());
      return getStatus();
    },
    ensureOnline() {
      if (status !== 'online') throw steamUnavailableError(status);
    },
    waitForLogin() {
      return status === 'online' ? Promise.resolve(true) : loginDeferred.promise;
    },
    waitForWebSession() {
      return latestWebSession ? Promise.resolve(latestWebSession) : webDeferred.promise;
    },
    refreshWebSession,
    getLatestWebSession() {
      return latestWebSession;
    },
    getStatus,
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
  createSteamLoginService,
  createSteamLifecycle,
  deleteRefreshToken,
  isRecoverableLoginError,
  isUnrecoverableLoginError,
  readRefreshToken
};
