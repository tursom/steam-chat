'use strict';

import { handleDeployWebhook } from './deploy-webhook';
import { settleMetadata } from '../steam/metadata';
import { steamEventKey } from '../storage/history-message';
import type { HistoryStorage } from '../storage/history-storage';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket as WsConnection, WebSocketServer as WsServer } from 'ws';
import type { AppSession } from '../auth/session';
import type { PublicAuditLog, PublicSteamAccount, PublicUser, PublicUserSession, UserPermission } from '../auth/store';
import type {
  AuthConfig,
  CallbackStyleFunction,
  ChatConfig,
  ConversationSummary,
  HistoryItem,
  HistoryRecordInput,
  LoggerLike,
  Persona,
  UnknownRecord
} from '../types';
import type { SteamFriendMessageEvent, SteamFriendMessageEventUser } from '../steam/friend-message-events';
import { errorCode, errorMessage, isRecord } from '../types';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');

const {
  DEFAULT_LOG_PATH,
  appendLog,
  buildConversations,
  extractStickerType,
  formatDate,
  limitFrom,
  normalizeHistoryItem,
  previewForMessage,
  readHistory,
  steamIdToString
} = require('../storage/chat-log');
const {
  subscribeFriendMessageEvents
} = require('../steam/friend-message-events');
const {
  IMAGE_CACHE_DIR,
  STICKER_CACHE_DIR,
  cacheKeyForUrl,
  inferImageContentType,
  isAllowedRemoteImageUrl,
  loadOrDownloadRemoteImage,
  loadOrDownloadSticker,
  stickerUrlForType
} = require('../storage/media-cache');
const { WEB_DIR } = require('../paths');
const { createAuthChecker, getClientIp } = require('./auth');
const { isLocalOrLanIp, normalizeIp } = require('./network');

type Waiter = Promise<unknown> | (() => Promise<unknown> | unknown);

type SteamChatApi = {
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
  on?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  off?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
};

type SteamUserLike = {
  chat?: SteamChatApi;
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
  on?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  off?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  myFriends?: UnknownRecord;
  users?: Record<string, Persona>;
  myGroups?: unknown;
  groups?: unknown;
};

type SteamCommunityLike = {
  sendImageToUser?: CallbackStyleFunction;
};

type EmoticonPayload = {
  emoticons: unknown[];
  stickers: unknown[];
};

type GetEmoticonsOptions = {
  steamUser?: SteamUserLike;
  waitForLogin: Waiter;
  waitForWebSession: Waiter;
};

type ChatServiceOptions = {
  deploymentWebhookUrl?: string;
  historyStorage?: HistoryStorage;
  config?: unknown;
  chatConfig?: unknown;
  logger?: LoggerLike;
  logPath?: string;
  steamUser?: SteamUserLike;
  steamCommunity?: SteamCommunityLike;
  waitForLogin?: Waiter;
  steamLoginPromise?: Waiter;
  waitForWebSession?: Waiter;
  steamWebLoginPromise?: Waiter;
  refreshWebSession?: () => Promise<unknown> | unknown;
  getUserInfo?: (value: unknown) => Promise<Persona>;
  getSelfName?: (steamAccountId?: string) => Promise<string>;
  getEmoticons?: (options: GetEmoticonsOptions) => Promise<EmoticonPayload>;
  fetchImpl?: typeof fetch;
  server?: Server;
  authStore?: AuthStoreLike;
  sessionManager?: SessionManagerLike;
  steamLoginService?: SteamLoginServiceLike;
};

type RequestContext = {
  ip?: string | null;
  userAgent?: string | null;
};

type AuthStoreLike = {
  authenticate: (username: unknown, password: unknown, context?: RequestContext) => PublicUser | null;
  canAccessSteamAccount: (userId: unknown, steamAccountId: unknown) => boolean;
  changeOwnPassword: (id: unknown, oldPassword: unknown, newPassword: unknown) => PublicUser;
  createInitialAdmin: (input: UnknownRecord) => PublicUser;
  createUser: (input: UnknownRecord) => PublicUser;
  deleteSteamAccount: (id: unknown) => void;
  deleteUser: (id: unknown, currentUserId: unknown) => void;
  getActiveSteamAccount: (includeToken?: boolean) => (PublicSteamAccount & { refreshToken?: string | null }) | null;
  getSteamAccountById: (id: unknown, includeToken?: boolean) => (PublicSteamAccount & { refreshToken?: string | null }) | null;
  hasPermission: (roleOrUser: string | Pick<PublicUser, 'role'>, permission: UserPermission) => boolean;
  listAuditLogs: (filters?: UnknownRecord) => PublicAuditLog[];
  listSteamAccountsForUser: (userId: unknown) => PublicSteamAccount[];
  listUserSessions: (userId: unknown) => PublicUserSession[];
  listUserSteamAccounts: (userId: unknown) => PublicSteamAccount[];
  listUsers: (filters?: UnknownRecord) => PublicUser[];
  markSteamAccountActive: (id: unknown) => void;
  permissionsForRole: (role: PublicUser['role']) => UserPermission[];
  recordAudit: (input: UnknownRecord) => PublicAuditLog;
  replaceUserSteamAccounts: (userId: unknown, steamAccountIds: unknown, grantedBy?: unknown) => PublicSteamAccount[];
  requiresSetup: () => boolean;
  revokeSession: (sessionId: unknown, revokedBy?: unknown) => boolean;
  revokeUserSessions: (userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown) => number;
  setActiveSteamAccount: (id: unknown) => PublicSteamAccount;
  setPassword: (id: unknown, password: unknown, options?: UnknownRecord) => PublicUser;
  updateSteamAccount: (id: unknown, patch: UnknownRecord) => PublicSteamAccount;
  updateUser: (id: unknown, patch: UnknownRecord) => PublicUser;
  upsertSteamAccount: (input: UnknownRecord) => PublicSteamAccount;
};

type SessionManagerLike = {
  createClearCookie: (req?: IncomingMessage) => string;
  createSetCookie: (user: PublicUser, req?: IncomingMessage) => string;
  getSession: (req: IncomingMessage) => AppSession | null;
  requireAdmin: (req: IncomingMessage) => AppSession;
  requireSession: (req: IncomingMessage) => AppSession;
  revokeCurrentSession: (req: IncomingMessage, revokedBy?: unknown) => boolean;
  revokeUserSessions: (userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown) => number;
};

type SteamStatusSummary = {
  status: string;
  requiresGuard?: boolean;
  guardType?: string | null;
  domain?: string | null;
  lastCodeWrong?: boolean;
  error?: string | null;
  steamId?: string | null;
  activeAccount?: Pick<PublicSteamAccount, 'id' | 'steamId' | 'label'> | null;
  accessAllowed?: boolean;
};

type SteamLoginServiceLike = {
  ensureOnline: () => void;
  getStatus: () => SteamStatusSummary;
  connectWithRefreshToken?: (refreshToken: unknown, steamID?: unknown) => SteamStatusSummary;
  login: (input: UnknownRecord) => SteamStatusSummary;
  logout: () => SteamStatusSummary;
  submitGuard: (code: unknown) => SteamStatusSummary;
};

type WsPayload = UnknownRecord & {
  requestId?: string;
  type?: string;
};

type ImageBody = UnknownRecord & {
  img?: string;
  url?: string;
};

type SteamAccessContext = {
  session: AppSession | null;
  activeAccount: PublicSteamAccount | null;
  steamAccountId?: string;
  includeLegacy: boolean;
};

type FriendSummary = {
  id: string;
  name: string;
  avatar: string;
  personaState: unknown;
  online: boolean;
  gameName: string;
};

type GroupSummary = {
  id: string;
  clanId: string;
  name: string;
};

const DEFAULT_CHAT_CONFIG: ChatConfig = {
  enabled: true,
  host: '0.0.0.0',
  port: 3000,
  wsPath: '/ws',
  auth: {
    username: '',
    password: '',
    realm: 'Steam Chat',
    trustProxy: false
  }
};

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WS_CONNECTIONS = 100;
const PUBLIC_DIR = WEB_DIR;

function stringProp(record: UnknownRecord, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function numberProp(record: UnknownRecord, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' ? value : fallback;
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolveWaiter(waiter: Waiter): Promise<unknown> {
  return Promise.resolve(typeof waiter === 'function' ? waiter() : waiter);
}

function statusCodeForError(error: unknown): number {
  if (isRecord(error) && typeof error.statusCode === 'number') return error.statusCode;
  return error instanceof SyntaxError ? 400 : 500;
}

function normalizeChatConfig(config: unknown): ChatConfig {
  if (config === true || config == null) {
    return { ...DEFAULT_CHAT_CONFIG, auth: { ...DEFAULT_CHAT_CONFIG.auth } };
  }
  if (!isRecord(config)) {
    return { ...DEFAULT_CHAT_CONFIG, auth: { ...DEFAULT_CHAT_CONFIG.auth } };
  }
  const authInput = isRecord(config.auth) ? config.auth : {};
  const auth: AuthConfig = {
    username: typeof authInput.username === 'string' ? authInput.username : DEFAULT_CHAT_CONFIG.auth.username,
    password: typeof authInput.password === 'string' ? authInput.password : DEFAULT_CHAT_CONFIG.auth.password,
    realm: typeof authInput.realm === 'string' ? authInput.realm : DEFAULT_CHAT_CONFIG.auth.realm,
    trustProxy: typeof authInput.trustProxy === 'boolean' ? authInput.trustProxy : DEFAULT_CHAT_CONFIG.auth.trustProxy
  };
  return {
    ...DEFAULT_CHAT_CONFIG,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_CHAT_CONFIG.enabled,
    host: stringProp(config, 'host', DEFAULT_CHAT_CONFIG.host),
    port: numberProp(config, 'port', DEFAULT_CHAT_CONFIG.port),
    wsPath: stringProp(config, 'wsPath', DEFAULT_CHAT_CONFIG.wsPath),
    auth
  };
}

function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown, headers: Record<string, string> = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function errorPayload(error: unknown): UnknownRecord {
  const payload: UnknownRecord = {
    error: errorMessage(error) || 'Internal Server Error'
  };
  if (isRecord(error) && typeof error.steamStatus === 'string') {
    payload.steamStatus = error.steamStatus;
  }
  if (isRecord(error) && error.resetRequired === true) payload.resetRequired = true;
  return payload;
}

function textResponse(res: ServerResponse, statusCode: number, payload: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(statusCode, headers);
  res.end(payload);
}

function readRequestBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<UnknownRecord> {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  const parsed: unknown = JSON.parse(body);
  return isRecord(parsed) ? parsed : {};
}

function contentTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  return types[ext] || 'application/octet-stream';
}

function staticFileForUrl(pathname: string) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return null;
  }
  return filePath;
}

function isStaticRequest(pathname: string) {
  return pathname === '/'
    || pathname === '/index.html'
    || pathname === '/style.css'
    || pathname === '/app.js'
    || pathname.startsWith('/icons/')
    || pathname === '/favicon.ico';
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const filePath = staticFileForUrl(pathname);
  if (!filePath) {
    jsonResponse(res, 404, { error: 'Not found' });
    return true;
  }
  try {
    const data = await fs.readFile(filePath);
    textResponse(res, 200, data, {
      'Content-Type': contentTypeForPath(filePath),
      'Cache-Control': pathname === '/' ? 'no-store' : 'public, max-age=60'
    });
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isTransientSteamError(error: unknown): boolean {
  const text = errorCode(error).toLowerCase();
  return ['timeout', 'econnreset', 'econnrefused', 'socket', 'network', 'temporar', 'busy', 'unavailable'].some((needle) => text.includes(needle));
}

function isSessionExpiredError(error: unknown): boolean {
  const text = errorCode(error).toLowerCase();
  return ['session', 'not logged in', 'notloggedin', 'access denied', 'forbidden', 'eresult 15'].some((needle) => text.includes(needle));
}

async function callMaybeCallback(fn: CallbackStyleFunction, context: unknown, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    function callback(error: unknown, result: unknown) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    }
    try {
      const result = fn.apply(context, [...args, callback]);
      if (isRecord(result) && typeof result.then === 'function') {
        Promise.resolve(result).then((value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        }, (error: unknown) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      } else if (fn.length < args.length + 1) {
        settled = true;
        resolve(result);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function decodeBase64Image(input: unknown): Buffer {
  const text = String(input || '');
  const match = text.match(/^data:([^;,]+)?;base64,(.*)$/i);
  return Buffer.from(match ? match[2] : text, 'base64');
}

function sendWs(ws: WsConnection, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function createChatService(options: ChatServiceOptions = {}) {
  const rawConfig = isRecord(options.config) && 'chat' in options.config
    ? options.config.chat
    : options.chatConfig ?? options.config ?? true;
  const config = normalizeChatConfig(rawConfig);
  const historyStorage = options.historyStorage;
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  }
  const logger = options.logger || console;
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const steamUser = options.steamUser;
  const steamCommunity = options.steamCommunity;
  const waitForLogin = options.waitForLogin || options.steamLoginPromise || Promise.resolve();
  const waitForWebSession = options.waitForWebSession || options.steamWebLoginPromise || Promise.resolve();
  const refreshWebSession = options.refreshWebSession || (async () => {});
  const getUserInfo: (value: unknown) => Promise<Persona> = options.getUserInfo || (async () => ({ player_name: 'Unknown' }));
  const getSelfName = options.getSelfName || (async () => 'Me');
  const getEmoticons = options.getEmoticons || defaultGetEmoticons;
  const fetchImpl = options.fetchImpl;
  const authStore = options.authStore;
  const sessionManager = options.sessionManager;
  const steamLoginService = options.steamLoginService;
  const legacyAuth = createAuthChecker(config.auth);
  const clients = new Set<WsConnection>();
  const wsRequests = new Map<WsConnection, IncomingMessage>();
  const recentSentText = new Map<string, number>();
  let disposeSteamEvents = () => {};

  const server: Server = options.server || http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void track(handleHttpRequest(req, res));
  });
  const wss: WsServer = new WebSocketServer({ noServer: true });

  function remember(map: Map<string, number>, key: string, ttl = 30 * 1000) {
    map.set(key, Date.now());
    setTimeout(() => map.delete(key), ttl).unref?.();
  }

  function isRecent(map: Map<string, number>, key: string) {
    return map.has(key);
  }

  function requestContext(req: IncomingMessage): RequestContext {
    return {
      ip: getClientIp(req, config.auth),
      userAgent: Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'][0] || null : req.headers['user-agent'] || null
    };
  }

  function activeAccountSummary(account: PublicSteamAccount | null) {
    return account ? { id: account.id, steamId: account.steamId, label: account.label } : null;
  }

  function ensureActiveSteamAccount(status = currentSteamStatus()): PublicSteamAccount | null {
    if (!authStore) return null;
    const active = authStore.getActiveSteamAccount(false);
    const statusSteamId = status.steamId ? String(status.steamId) : '';
    if (statusSteamId && (!active || active.steamId !== statusSteamId)) {
      return authStore.upsertSteamAccount({ steamId: statusSteamId, setActive: true });
    }
    return active;
  }

  function steamStatusForSession(session: AppSession | null): SteamStatusSummary {
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    const accessAllowed = !session || !active ? false : authStore?.canAccessSteamAccount(session.user.id, active.id) === true;
    return {
      ...status,
      activeAccount: accessAllowed || session?.user.role === 'admin' ? activeAccountSummary(active) : null,
      accessAllowed
    };
  }

  function requirePermission(req: IncomingMessage, permission: UserPermission): AppSession | null {
    if (!sessionManager || !authStore) return requireAdminSession(req);
    const session = sessionManager.requireSession(req);
    if (!authStore.hasPermission(session.user, permission)) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return session;
  }

  function recordAudit(session: AppSession | null, req: IncomingMessage, action: string, targetType: string, targetId: unknown, detail: UnknownRecord = {}) {
    if (!authStore || !session) return;
    const context = requestContext(req);
    authStore.recordAudit({
      actorUserId: session.user.id,
      action,
      targetType,
      targetId: String(targetId || ''),
      detail,
      ip: context.ip,
      userAgent: context.userAgent
    });
  }

  function steamAccountUnavailable(status = currentSteamStatus()) {
    return Object.assign(new Error('Steam account is not connected'), {
      statusCode: 503,
      steamStatus: status.status
    });
  }

  function requireSteamAccountAccess(req: IncomingMessage, needsOnline: boolean): SteamAccessContext {
    const session = requireLegacyOrSession(req);
    if (needsOnline) requireSteamOnline();
    if (!sessionManager || !authStore) {
      const active = ensureActiveSteamAccount();
      return {
        session,
        activeAccount: active,
        steamAccountId: active?.steamId || currentSteamStatus().steamId || undefined,
        includeLegacy: true
      };
    }
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    if (!active) throw steamAccountUnavailable(status);
    if (!authStore.canAccessSteamAccount(session?.user.id, active.id)) {
      throw Object.assign(new Error('Steam account access denied'), { statusCode: 403 });
    }
    authStore.markSteamAccountActive(active.id);
    return {
      session,
      activeAccount: active,
      steamAccountId: active.steamId,
      includeLegacy: session?.user.role === 'admin'
    };
  }

  function liveWsSession(ws: WsConnection): AppSession | null {
    if (!sessionManager) return null;
    const req = wsRequests.get(ws);
    const session = req ? sessionManager.getSession(req) : null;
    if (!session) ws.close(1008, 'Session expired or revoked');
    return session;
  }

  function wsAccessContext(ws: WsConnection, needsOnline: boolean): SteamAccessContext {
    const session = liveWsSession(ws);
    if (sessionManager && !session) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (needsOnline) requireSteamOnline();
    if (!sessionManager || !authStore) {
      const active = ensureActiveSteamAccount();
      return { session, activeAccount: active, steamAccountId: active?.steamId || currentSteamStatus().steamId || undefined, includeLegacy: true };
    }
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    if (!active) throw steamAccountUnavailable(status);
    if (!session || !authStore.canAccessSteamAccount(session.user.id, active.id)) {
      throw Object.assign(new Error('Steam account access denied'), { statusCode: 403 });
    }
    authStore.markSteamAccountActive(active.id);
    return { session, activeAccount: active, steamAccountId: active.steamId, includeLegacy: session.user.role === 'admin' };
  }

  function canWsReceiveActiveAccount(ws: WsConnection): boolean {
    if (!sessionManager || !authStore) return true;
    const session = liveWsSession(ws);
    const active = ensureActiveSteamAccount();
    return Boolean(session && active && authStore.canAccessSteamAccount(session.user.id, active.id));
  }

  function broadcast(payload: unknown, except?: WsConnection) {
    for (const ws of clients) {
      if (ws !== except && canWsReceiveActiveAccount(ws)) sendWs(ws, payload);
    }
  }

  function currentSteamStatus(): SteamStatusSummary {
    return steamLoginService?.getStatus?.() || {
      status: 'online',
      requiresGuard: false,
      guardType: null,
      domain: null,
      lastCodeWrong: false,
      error: null,
      steamId: null
    };
  }

  function requireLegacyOrSession(req: IncomingMessage): AppSession | null {
    if (sessionManager) return sessionManager.requireSession(req);
    if (!legacyAuth.isAuthorized(req)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401, legacyChallenge: true });
    return null;
  }

  function requireAdminSession(req: IncomingMessage): AppSession | null {
    if (sessionManager) return sessionManager.requireAdmin(req);
    if (!legacyAuth.isAuthorized(req)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401, legacyChallenge: true });
    return null;
  }

  function requireSteamOnline() {
    steamLoginService?.ensureOnline?.();
  }

  function writeAuthError(req: IncomingMessage, res: ServerResponse, error: unknown) {
    if (isRecord(error) && error.legacyChallenge && !sessionManager) {
      legacyAuth.challenge(res);
      return;
    }
    jsonResponse(res, statusCodeForError(error), errorPayload(error));
  }

  function authMe(req: IncomingMessage) {
    const session = sessionManager?.getSession(req) || null;
    return {
      needsSetup: authStore?.requiresSetup?.() ?? false,
      user: session?.user || null,
      permissions: session && authStore ? authStore.permissionsForRole(session.user.role) : [],
      steam: steamStatusForSession(session)
    };
  }

  async function handleAuthApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!authStore || !sessionManager) return false;

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      jsonResponse(res, 200, authMe(req));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/setup') {
      const body = await readJsonBody(req);
      const user = authStore.createInitialAdmin(body);
      jsonResponse(res, 200, { ok: true, user, permissions: authStore.permissionsForRole(user.role), steam: steamStatusForSession(null) }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const user = authStore.authenticate(body.username, body.password, requestContext(req));
      if (!user) throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
      jsonResponse(res, 200, { ok: true, user, permissions: authStore.permissionsForRole(user.role), steam: steamStatusForSession(null) }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const session = sessionManager.getSession(req);
      if (session) {
        sessionManager.revokeCurrentSession(req, session.user.id);
        recordAudit(session, req, 'session.logout', 'session', session.sessionId);
      }
      jsonResponse(res, 200, { ok: true }, {
        'Set-Cookie': sessionManager.createClearCookie(req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout-all') {
      const session = sessionManager.requireSession(req);
      sessionManager.revokeUserSessions(session.user.id, session.user.id);
      recordAudit(session, req, 'session.logout_all', 'user', session.user.id);
      jsonResponse(res, 200, { ok: true }, {
        'Set-Cookie': sessionManager.createClearCookie(req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/password') {
      const session = sessionManager.requireSession(req);
      const body = await readJsonBody(req);
      const user = authStore.changeOwnPassword(session.user.id, body.oldPassword, body.newPassword);
      recordAudit(session, req, 'user.password.change_self', 'user', session.user.id);
      jsonResponse(res, 200, { ok: true, user }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    return false;
  }

  async function handleUsersApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!authStore || !sessionManager) return false;
    const pathname = url.pathname;
    if (pathname === '/api/users') {
      const session = requirePermission(req, 'user.manage');
      if (req.method === 'GET') {
        jsonResponse(res, 200, {
          users: authStore.listUsers({
            query: url.searchParams.get('query'),
            role: url.searchParams.get('role'),
            status: url.searchParams.get('status')
          })
        });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const user = authStore.createUser({ ...body, createdBy: session?.user.id });
        recordAudit(session, req, 'user.create', 'user', user.id, { username: user.username, role: user.role, steamAccountIds: body.steamAccountIds });
        jsonResponse(res, 201, { ok: true, user });
        return true;
      }
      return false;
    }

    const sessionsMatch = pathname.match(/^\/api\/users\/(\d+)\/sessions$/);
    if (sessionsMatch) {
      const session = requirePermission(req, 'session.manage');
      if (req.method === 'GET') {
        jsonResponse(res, 200, { sessions: authStore.listUserSessions(sessionsMatch[1]) });
        return true;
      }
      if (req.method === 'DELETE') {
        const revoked = authStore.revokeUserSessions(sessionsMatch[1], session?.user.id);
        recordAudit(session, req, 'session.revoke_user', 'user', sessionsMatch[1], { revoked });
        jsonResponse(res, 200, { ok: true, revoked });
        return true;
      }
    }

    const sessionMatch = pathname.match(/^\/api\/users\/(\d+)\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'DELETE') {
      const session = requirePermission(req, 'session.manage');
      const revoked = authStore.revokeSession(decodeURIComponent(sessionMatch[2]), session?.user.id);
      recordAudit(session, req, 'session.revoke', 'session', sessionMatch[2], { userId: sessionMatch[1], revoked });
      jsonResponse(res, 200, { ok: true, revoked });
      return true;
    }

    const steamAccountsMatch = pathname.match(/^\/api\/users\/(\d+)\/steam-accounts$/);
    if (steamAccountsMatch) {
      const session = requirePermission(req, 'steam.account.manage');
      if (req.method === 'GET') {
        jsonResponse(res, 200, { steamAccounts: authStore.listUserSteamAccounts(steamAccountsMatch[1]) });
        return true;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const steamAccounts = authStore.replaceUserSteamAccounts(steamAccountsMatch[1], body.steamAccountIds, session?.user.id);
        recordAudit(session, req, 'steam_account.grant_replace', 'user', steamAccountsMatch[1], { steamAccountIds: body.steamAccountIds });
        jsonResponse(res, 200, { ok: true, steamAccounts });
        return true;
      }
    }

    const passwordMatch = pathname.match(/^\/api\/users\/(\d+)\/password$/);
    if (passwordMatch && req.method === 'POST') {
      const session = requirePermission(req, 'user.manage');
      const body = await readJsonBody(req);
      const user = authStore.setPassword(passwordMatch[1], body.password, { forcePasswordChange: body.forcePasswordChange });
      recordAudit(session, req, 'user.password.reset', 'user', user.id, { forcePasswordChange: body.forcePasswordChange });
      jsonResponse(res, 200, { ok: true, user });
      return true;
    }

    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
      const session = requirePermission(req, 'user.manage');
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const user = authStore.updateUser(userMatch[1], body);
        recordAudit(session, req, 'user.update', 'user', user.id, body);
        jsonResponse(res, 200, { ok: true, user });
        return true;
      }
      if (req.method === 'DELETE') {
        authStore.deleteUser(userMatch[1], session?.user.id);
        recordAudit(session, req, 'user.delete', 'user', userMatch[1]);
        jsonResponse(res, 200, { ok: true });
        return true;
      }
    }

    return false;
  }

  async function handleSteamApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!steamLoginService) return false;
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/steam/status') {
      const session = requireLegacyOrSession(req);
      jsonResponse(res, 200, steamStatusForSession(session));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/steam/accounts') {
      const session = requireLegacyOrSession(req);
      if (!session || !authStore) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      jsonResponse(res, 200, { steamAccounts: authStore.listSteamAccountsForUser(session.user.id) });
      return true;
    }

    if (req.method === 'POST' && (pathname === '/api/steam/login' || pathname === '/api/steam/accounts/login')) {
      const session = requirePermission(req, 'steam.manage');
      const body = await readJsonBody(req);
      const status = steamLoginService.login(body);
      if (authStore && status.steamId) {
        authStore.upsertSteamAccount({
          steamId: status.steamId,
          label: body.label,
          accountNameHint: body.accountName,
          createdBy: session?.user.id,
          setActive: true
        });
      }
      recordAudit(session, req, 'steam_account.login', 'steam_account', status.steamId || 'pending', { label: body.label, accountName: body.accountName });
      jsonResponse(res, 200, steamStatusForSession(session));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/steam/guard') {
      const session = requirePermission(req, 'steam.manage');
      const body = await readJsonBody(req);
      steamLoginService.submitGuard(body.code);
      recordAudit(session, req, 'steam_account.guard_submit', 'steam_account', 'pending');
      jsonResponse(res, 200, steamStatusForSession(session));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/steam/logout') {
      const session = requirePermission(req, 'steam.manage');
      const active = authStore?.getActiveSteamAccount(false);
      steamLoginService.logout();
      recordAudit(session, req, 'steam_account.logout', 'steam_account', active?.id || 'active');
      jsonResponse(res, 200, steamStatusForSession(session));
      return true;
    }

    const accountMatch = pathname.match(/^\/api\/steam\/accounts\/(\d+)$/);
    if (accountMatch) {
      const session = requirePermission(req, 'steam.account.manage');
      if (req.method === 'PATCH') {
        const account = authStore!.updateSteamAccount(accountMatch[1], await readJsonBody(req));
        recordAudit(session, req, 'steam_account.update', 'steam_account', account.id);
        jsonResponse(res, 200, { ok: true, steamAccount: account });
        return true;
      }
      if (req.method === 'DELETE') {
        const active = authStore!.getActiveSteamAccount(false);
        if (active?.id === Number(accountMatch[1])) steamLoginService.logout();
        authStore!.deleteSteamAccount(accountMatch[1]);
        recordAudit(session, req, 'steam_account.delete', 'steam_account', accountMatch[1]);
        jsonResponse(res, 200, { ok: true });
        return true;
      }
    }

    const connectMatch = pathname.match(/^\/api\/steam\/accounts\/(\d+)\/connect$/);
    if (connectMatch && req.method === 'POST') {
      const session = requirePermission(req, 'steam.manage');
      const account = authStore!.getSteamAccountById(connectMatch[1], true);
      if (!account) throw Object.assign(new Error('Steam account not found'), { statusCode: 404 });
      if (!account.enabled) throw Object.assign(new Error('Steam account is disabled'), { statusCode: 409 });
      const status = steamLoginService.connectWithRefreshToken
        ? steamLoginService.connectWithRefreshToken(account.refreshToken, account.steamId)
        : steamLoginService.login({});
      authStore!.setActiveSteamAccount(account.id);
      recordAudit(session, req, 'steam_account.connect', 'steam_account', account.id);
      jsonResponse(res, 200, { ...steamStatusForSession(session), ...status });
      return true;
    }

    const accountLogoutMatch = pathname.match(/^\/api\/steam\/accounts\/(\d+)\/logout$/);
    if (accountLogoutMatch && req.method === 'POST') {
      const session = requirePermission(req, 'steam.manage');
      const active = authStore?.getActiveSteamAccount(false);
      if (!active || active.id !== Number(accountLogoutMatch[1])) {
        throw Object.assign(new Error('Steam account is not active'), { statusCode: 409 });
      }
      steamLoginService.logout();
      recordAudit(session, req, 'steam_account.logout', 'steam_account', active.id);
      jsonResponse(res, 200, steamStatusForSession(session));
      return true;
    }

    return false;
  }

  async function handleAuditApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!authStore || !sessionManager) return false;
    if (req.method !== 'GET' || url.pathname !== '/api/audit-logs') return false;
    requirePermission(req, 'audit.view');
    jsonResponse(res, 200, {
      auditLogs: authStore.listAuditLogs({
        action: url.searchParams.get('action'),
        targetType: url.searchParams.get('targetType'),
        actorUserId: url.searchParams.get('actorUserId'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: url.searchParams.get('limit')
      })
    });
    return true;
  }

  async function withSteamRetry<T>(operation: () => Promise<T> | T, needsWebSession = false): Promise<T> {
    requireSteamOnline();
    await resolveWaiter(waitForLogin);
    if (needsWebSession) {
      await resolveWaiter(waitForWebSession);
    }
    try {
      return await operation();
    } catch (error) {
      if (isSessionExpiredError(error)) {
        await refreshWebSession();
        return operation();
      }
      if (isTransientSteamError(error)) {
        return operation();
      }
      throw error;
    }
  }

  function validateAccountPrecondition(requested: unknown): void {
    if (requested !== undefined && (typeof requested !== 'string' || !/^\d{17}$/.test(requested))) {
      throw Object.assign(new Error('steamAccountId must be a SteamID64 string'), { statusCode: 400 });
    }
  }

  function checkAccountPrecondition(access: SteamAccessContext, requested: unknown): void {
    validateAccountPrecondition(requested);
    if (requested !== undefined && requested !== access.steamAccountId) {
      throw Object.assign(new Error('Steam account changed before sending'), { statusCode: 409 });
    }
  }

  function httpSendAuthorization(req: IncomingMessage, access: SteamAccessContext, requested: unknown): () => void {
    checkAccountPrecondition(access, requested);
    // Capture the pre-body account, and recheck access at every actual send attempt.
    return () => {
      const current = requireSteamAccountAccess(req, true);
      checkAccountPrecondition(current, requested);
      if (access.steamAccountId !== current.steamAccountId) {
        throw Object.assign(new Error('Steam account changed before sending'), { statusCode: 409 });
      }
    };
  }

  // First version is active-account-only; a caller-supplied account is never authority.
  function historyAccount(access: SteamAccessContext, requested?: unknown): string {
    if (!access.steamAccountId) throw steamAccountUnavailable();
    if (requested != null && requested !== '' && requested !== access.steamAccountId) {
      throw Object.assign(new Error('Only the active Steam account is supported'), { statusCode: 403 });
    }
    return access.steamAccountId;
  }

  function historyQuery(access: SteamAccessContext, input: UnknownRecord) {
    const steamAccountId = historyAccount(access, input.steamAccountId);
    if (!input.id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
    return { steamAccountId, id: String(input.id), limit: input.limit == null ? undefined : Number(input.limit),
      before: input.before == null ? undefined : String(input.before),
      after: input.after == null ? undefined : String(input.after),
      at: input.at == null ? undefined : Number(input.at) };
  }

  function checkSend(steamAccountId?: string) {
    if (stopping || (historyStorage && !historyStorage.canSend())) {
      throw Object.assign(new Error('History storage unavailable for sending'), { statusCode: 503 });
    }
    if (historyStorage && !steamAccountId) throw steamAccountUnavailable();
    const currentAccount = ensureActiveSteamAccount()?.steamId || currentSteamStatus().steamId;
    if (historyStorage && currentAccount && currentAccount !== steamAccountId) {
      throw Object.assign(new Error('Steam account changed before sending'), { statusCode: 409 });
    }
  }

  async function persistSent(record: HistoryRecordInput): Promise<HistoryItem> {
    if (!historyStorage) {
      const item = await appendLog(record, { logPath });
      broadcast({ type: 'message', ...item });
      return item;
    }
    try { return historyStorage.append(record); }
    catch (error) {
      // Steam already accepted this send. A persistence failure must not invite a retry.
      logger.error?.('Sent message persistence failed', { error: errorMessage(error) });
      return { ...normalizeHistoryItem(record), persistence: { jsonl: 'failed', rocksdb: 'failed' } };
    }
  }

  async function sendTextMessage(id: unknown, msg: unknown, steamAccountId?: string, authorize?: () => void): Promise<HistoryItem> {
    steamAccountId = steamAccountId || ensureActiveSteamAccount()?.steamId || currentSteamStatus().steamId || undefined;
    checkSend(steamAccountId);
    const selfName = settleMetadata(getSelfName(steamAccountId), 'Me');
    if (!id || !String(msg || '').trim()) {
      throw Object.assign(new Error('id and msg are required'), { statusCode: 400 });
    }
    if (!steamUser?.chat?.sendFriendMessage && !steamUser?.sendFriendMessage) {
      throw new Error('Steam chat sender is unavailable');
    }
    const message = String(msg);
    const result = await withSteamRetry(() => {
      authorize?.();
      checkSend(steamAccountId);
      const sender = steamUser.chat?.sendFriendMessage || steamUser.sendFriendMessage;
      const context = steamUser.chat?.sendFriendMessage ? steamUser.chat : steamUser;
      if (!sender) throw new Error('Steam chat sender is unavailable');
      return callMaybeCallback(sender, context, [id, message]);
    });
    remember(recentSentText, `${id}:${message}`);
    const record: HistoryRecordInput = {
      type: 'message',
      echo: true,
      steamAccountId,
      id,
      name: await selfName,
      message
    };
    if (isRecord(result)) {
      if (typeof result.ordinal === 'string' || typeof result.ordinal === 'number') record.ordinal = result.ordinal;
      if (result.server_timestamp instanceof Date) record.sentAt = result.server_timestamp.toISOString();
      record.steamEventKey = steamEventKey(steamAccountId, String(id), true, message, result.server_timestamp, result.ordinal);
    }
    return persistSent(record);
  }

  async function sendImageMessage(id: unknown, body: ImageBody, steamAccountId?: string, authorize?: () => void): Promise<HistoryItem> {
    steamAccountId = steamAccountId || ensureActiveSteamAccount()?.steamId || currentSteamStatus().steamId || undefined;
    checkSend(steamAccountId);
    const selfName = settleMetadata(getSelfName(steamAccountId), 'Me');
    if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
    if (!steamCommunity || typeof steamCommunity.sendImageToUser !== 'function') {
      throw new Error('Steam image sender is unavailable');
    }
    let imageBuffer: Buffer;
    let message = body.url || '';
    if (body.img) {
      imageBuffer = decodeBase64Image(body.img);
    } else if (body.url) {
      const downloaded = await loadOrDownloadRemoteImage(body.url, { fetchImpl });
      imageBuffer = downloaded.buffer;
    } else {
      throw Object.assign(new Error('img or url is required'), { statusCode: 400 });
    }
    const imageArgs = steamCommunity.sendImageToUser.length >= 4 ? [id, imageBuffer, {}] : [id, imageBuffer];
    const result = await withSteamRetry(() => {
      authorize?.();
      checkSend(steamAccountId);
      return callMaybeCallback(steamCommunity.sendImageToUser!, steamCommunity, imageArgs);
    }, true);
    if (typeof result === 'string' && result) message = result;
    else if (isRecord(result) && typeof result.url === 'string' && result.url) message = result.url;
    const record: HistoryRecordInput = {
      imageSendSource: 'upload',
      type: historyStorage ? 'image' : 'message',
      echo: true,
      steamAccountId,
      id,
      name: await selfName,
      message,
      sentAt: isRecord(result) && result.server_timestamp instanceof Date ? result.server_timestamp.toISOString() : undefined,
      ordinal: isRecord(result) && (typeof result.ordinal === 'string' || typeof result.ordinal === 'number') ? result.ordinal : 0,
      steamEventKey: isRecord(result) ? steamEventKey(steamAccountId, String(id), true, message, result.server_timestamp, result.ordinal) : undefined
    };
    return historyStorage ? persistSent(record) : normalizeHistoryItem(record);
  }

  async function handleSteamIncoming(event: SteamFriendMessageEvent) {
    const id = event.id;
    const active = ensureActiveSteamAccount();
    const info = await getUserInfo(event.steamID || id).catch((): Persona => ({ player_name: id }));
    const item = normalizeHistoryItem({
      type: 'message',
      steamAccountId: active?.steamId,
      id,
      name: info.player_name || info.personaName || id,
      message: event.message,
      ordinal: event.ordinal ?? 0,
      date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
    });
    broadcast({ type: 'message', ...item });
  }

  async function handleSteamEcho(event: SteamFriendMessageEvent) {
    const id = event.id;
    if (isRecent(recentSentText, `${id}:${event.message}`) || isRecent(recentSentText, `${id}:${event.compatibilityMessage}`)) return;
    const active = ensureActiveSteamAccount();
    const item = normalizeHistoryItem({
      type: 'message',
      echo: true,
      steamAccountId: active?.steamId,
      id,
      name: await getSelfName(),
      message: event.message,
      ordinal: event.ordinal ?? 0,
      date: event.serverTimestamp ? formatDate(event.serverTimestamp) : undefined
    });
    broadcast({ type: 'message', ...item });
  }

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (stopping) {
        jsonResponse(res, 503, { error: 'Service is stopping' });
        return;
      }
      if (url.pathname === '/api/deploy') {
        await handleDeployWebhook(req, res, options.deploymentWebhookUrl ?? process.env.STEAM_CHAT_DEPLOY_WEBHOOK_URL);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && isStaticRequest(url.pathname)) {
        if (await serveStatic(req, res, url.pathname)) return;
      }

      if (await handleAuthApi(req, res, url.pathname)) return;
      if (await handleSteamApi(req, res, url)) return;
      if (await handleUsersApi(req, res, url)) return;
      if (await handleAuditApi(req, res, url)) return;

      requireLegacyOrSession(req);

      if (req.method === 'GET') {
        if (url.pathname === '/api/messages/sync') {
          if (!sessionManager || !authStore) throw Object.assign(new Error('Session authentication required'), { statusCode: 401 });
          const access = requireSteamAccountAccess(req, false);
          const requestedAccount = url.searchParams.get('steamAccountId') ?? undefined;
          validateAccountPrecondition(requestedAccount);
          const steamAccountId = historyAccount(access, requestedAccount);
          if (!historyStorage) throw Object.assign(new Error('History storage unavailable'), { statusCode: 503 });
          const page = await historyStorage.sync({ steamAccountId,
            cursor: url.searchParams.has('cursor') ? url.searchParams.get('cursor')! : undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined });
          const current = requireSteamAccountAccess(req, false);
          historyAccount(current, steamAccountId);
          jsonResponse(res, 200, page, { 'Cache-Control': 'no-store' });
          return;
        }
        if (url.pathname === '/api/config') {
          jsonResponse(res, 200, { wsPath: config.wsPath });
          return;
        }
        if (url.pathname === '/api/emoticons') {
          requireSteamAccountAccess(req, true);
          const data = await getEmoticons({ steamUser, waitForLogin, waitForWebSession });
          jsonResponse(res, 200, data);
          return;
        }
        if (url.pathname === '/api/friends') {
          requireSteamAccountAccess(req, true);
          jsonResponse(res, 200, await listFriends(steamUser));
          return;
        }
        if (url.pathname === '/api/groups') {
          requireSteamAccountAccess(req, true);
          jsonResponse(res, 200, await listGroups(steamUser));
          return;
        }
        if (url.pathname === '/api/history/status') {
          if (!historyStorage) throw Object.assign(new Error('History storage unavailable'), { statusCode: 503 });
          const { jsonl, rocksdb } = historyStorage.status();
          const { lastError: _jsonlError, ...safeJsonl } = jsonl;
          const { lastError: _dbError, ...safeDb } = rocksdb;
          jsonResponse(res, 200, { jsonl: safeJsonl, rocksdb: safeDb });
          return;
        }
        if (historyStorage && ['/history', '/api/history', '/conversations', '/api/conversations'].includes(url.pathname)) {
          const access = requireSteamAccountAccess(req, false);
          const input = Object.fromEntries(url.searchParams);
          const page = url.pathname.endsWith('/history')
            ? await historyStorage.history(historyQuery(access, input))
            : await historyStorage.conversations({ steamAccountId: historyAccount(access, input.steamAccountId),
              limit: input.limit == null ? undefined : Number(input.limit), before: input.before });
          jsonResponse(res, 200, url.pathname.startsWith('/api/') ? page : page.items);
          return;
        }
        if (url.pathname === '/history') {
          const access = requireSteamAccountAccess(req, false);
          jsonResponse(res, 200, await readHistory({
            logPath,
            id: url.searchParams.get('id'),
            limit: url.searchParams.get('limit'),
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            logger
          }));
          return;
        }
        if (url.pathname === '/conversations') {
          const access = requireSteamAccountAccess(req, false);
          jsonResponse(res, 200, await buildConversations({
            logPath,
            limit: url.searchParams.get('limit'),
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            getUserInfo,
            logger
          }));
          return;
        }
        if (url.pathname.startsWith('/proxy/sticker/')) {
          requireSteamAccountAccess(req, false);
          const type = decodeURIComponent(url.pathname.slice('/proxy/sticker/'.length));
          const sticker = await loadOrDownloadSticker(type, { fetchImpl });
          textResponse(res, 200, sticker.buffer, { 'Content-Type': sticker.contentType, 'Cache-Control': 'public, max-age=86400' });
          return;
        }
        if (url.pathname === '/proxy/image') {
          requireSteamAccountAccess(req, false);
          const source = url.searchParams.get('url') || '';
          const image = await loadOrDownloadRemoteImage(source, { fetchImpl });
          textResponse(res, 200, image.buffer, { 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=86400' });
          return;
        }
        if (await serveStatic(req, res, url.pathname)) return;
        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/message')) {
        const access = requireSteamAccountAccess(req, true);
        const body = await readJsonBody(req);
        const authorize = httpSendAuthorization(req, access, body.steamAccountId);
        authorize();
        const item = await sendTextMessage(body.id, body.msg, access.steamAccountId, authorize);
        jsonResponse(res, 200, { ok: true, item });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/image' || url.pathname === '/img')) {
        const access = requireSteamAccountAccess(req, true);
        const body = await readJsonBody(req);
        const authorize = httpSendAuthorization(req, access, body.steamAccountId);
        authorize();
        const item = await sendImageMessage(body.id, body, access.steamAccountId, authorize);
        jsonResponse(res, 200, { ok: true, item });
        return;
      }

      jsonResponse(res, req.method === 'GET' ? 404 : 405, { error: 'Not found' });
    } catch (error) {
      writeAuthError(req, res, error);
    }
  }

  async function handleWsMessage(ws: WsConnection, raw: RawData) {
    let payload: WsPayload;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      payload = isRecord(parsed) ? parsed : {};
    } catch (_) {
      sendWs(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const type = payload.type;
    let responseAccount: string | undefined;
    const reply = (message: UnknownRecord) => {
      if (sessionManager && message.type !== 'error') {
        if (!liveWsSession(ws)) return;
        if (responseAccount) historyAccount(wsAccessContext(ws, false), responseAccount);
      }
      sendWs(ws, requestId ? { requestId, ...message } : message);
    };
    try {
      if (sessionManager && !liveWsSession(ws)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      if (type === 'ping') {
        reply({ type: 'pong' });
        return;
      }
      if (sessionManager) responseAccount = wsAccessContext(ws, false).steamAccountId;
      if (type === 'send_message' || type === 'msg') {
        const access = wsAccessContext(ws, true);
        checkAccountPrecondition(access, payload.steamAccountId);
        const item = await sendTextMessage(payload.id, payload.msg || payload.message || '', access.steamAccountId,
          () => {
            if (payload.steamAccountId !== undefined) checkAccountPrecondition(wsAccessContext(ws, true), payload.steamAccountId);
            if (sessionManager) historyAccount(wsAccessContext(ws, true), access.steamAccountId);
          });
        reply({ type: 'message_sent', item });
        return;
      }
      if (type === 'send_image' || type === 'img') {
        const access = wsAccessContext(ws, true);
        checkAccountPrecondition(access, payload.steamAccountId);
        const item = await sendImageMessage(payload.id, payload, access.steamAccountId,
          () => {
            if (payload.steamAccountId !== undefined) checkAccountPrecondition(wsAccessContext(ws, true), payload.steamAccountId);
            if (sessionManager) historyAccount(wsAccessContext(ws, true), access.steamAccountId);
          });
        reply({ type: 'image_sent', item });
        return;
      }
      if (historyStorage && ['get_history', 'history', 'get_history_page', 'get_conversations', 'conversations', 'get_conversations_page'].includes(String(type))) {
        const access = wsAccessContext(ws, false);
        const isHistory = String(type).includes('history');
        const page = isHistory
          ? await historyStorage.history(historyQuery(access, payload))
          : await historyStorage.conversations({ steamAccountId: historyAccount(access, payload.steamAccountId),
            limit: payload.limit == null ? undefined : Number(payload.limit),
            before: payload.before == null ? undefined : String(payload.before) });
        reply(String(type).endsWith('_page')
          ? { type: isHistory ? 'history_page' : 'conversations_page', ...page }
          : isHistory ? { type: 'history', items: page.items } : { type: 'conversations', conversations: page.items });
        return;
      }
      if (type === 'get_history' || type === 'history') {
        const access = wsAccessContext(ws, false);
        reply({
          type: 'history',
          items: await readHistory({
            logPath,
            id: payload.id,
            limit: payload.limit,
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            logger
          })
        });
        return;
      }
      if (type === 'get_conversations' || type === 'conversations') {
        const access = wsAccessContext(ws, false);
        reply({
          type: 'conversations',
          conversations: await buildConversations({
            logPath,
            limit: payload.limit,
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            getUserInfo,
            logger
          })
        });
        return;
      }
      if (type === 'get_emoticons' || type === 'emoticons') {
        wsAccessContext(ws, true);
        reply({ type: 'emoticons', ...(await getEmoticons({ steamUser, waitForLogin, waitForWebSession })) });
        return;
      }
      if (type === 'get_friends' || type === 'friends') {
        wsAccessContext(ws, true);
        reply({ type: 'friends', friends: await listFriends(steamUser) });
        return;
      }
      if (type === 'get_groups' || type === 'groups') {
        wsAccessContext(ws, true);
        reply({ type: 'groups', groups: await listGroups(steamUser) });
        return;
      }
      reply({ type: 'error', error: `Unsupported WebSocket type: ${type || 'unknown'}` });
    } catch (error) {
      reply({ type: 'error', error: errorMessage(error) || 'Request failed', statusCode: statusCodeForError(error), ...(errorPayload(error)) });
    }
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }
    try {
      requireLegacyOrSession(req);
    } catch (error) {
      if (sessionManager) {
        socket.write([
          'HTTP/1.1 401 Unauthorized',
          'Content-Type: application/json; charset=utf-8',
          'Connection: close',
          '',
          JSON.stringify({ error: 'Unauthorized' })
        ].join('\r\n'));
        socket.destroy();
        return;
      }
      legacyAuth.challengeUpgrade(socket);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WsConnection) => {
      wsRequests.set(ws, req);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WsConnection) => {
    if (clients.size >= MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Too many connections');
      return;
    }
    clients.add(ws);
    sendWs(ws, { type: 'ready', wsPath: config.wsPath });
    ws.on('message', (raw: RawData) => { if (!stopping) void track(handleWsMessage(ws, raw)); });
    ws.on('close', () => {
      clients.delete(ws);
      wsRequests.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
      wsRequests.delete(ws);
    });
  });

  const disposeStorageMessages = historyStorage?.onMessage((item) => {
    for (const ws of clients) {
      if (sessionManager && authStore) {
        const session = liveWsSession(ws);
        if (!session) continue;
        const account = authStore.listSteamAccountsForUser(session.user.id).find((account) => account.steamId === item.steamAccountId);
        if (!account || !authStore.canAccessSteamAccount(session.user.id, account.id)) continue;
      }
      sendWs(ws, { type: 'message', ...item });
    }
  });

  const disposeDurableMessages = historyStorage?.onDurable((item) => {
    // Sync is session-only even when the service also supports legacy Web access.
    if (!sessionManager || !authStore) return;
    for (const ws of clients) {
      const session = liveWsSession(ws);
      const active = authStore.getActiveSteamAccount(false);
      if (!session || !active || active.steamId !== item.steamAccountId ||
          !authStore.canAccessSteamAccount(session.user.id, active.id)) continue;
      sendWs(ws, { type: 'sync_available', steamAccountId: item.steamAccountId });
    }
  });

  if (steamUser && !historyStorage) {
    disposeSteamEvents = subscribeFriendMessageEvents(steamUser as SteamFriendMessageEventUser, (event: SteamFriendMessageEvent) => {
      const task = event.echo ? handleSteamEcho(event) : handleSteamIncoming(event);
      task.catch((error) => {
        logger.warn?.('Failed to broadcast Steam message', { id: event.id, error: errorMessage(error) });
      });
    });
  }

  return {
    config,
    server,
    wss,
    clients,
    start(callback?: () => void) {
      server.listen(config.port, config.host, () => {
        logger.info?.(`Steam Chat listening on ${config.host}:${config.port}`);
        callback?.();
      });
      return server;
    },
    async stop() {
      stopping = true;
      disposeSteamEvents();
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      while (pending.size) await Promise.allSettled([...pending]);
      disposeStorageMessages?.();
      disposeDurableMessages?.();
    },
    sendTextMessage: (...args: Parameters<typeof sendTextMessage>) => track(sendTextMessage(...args)),
    sendImageMessage: (...args: Parameters<typeof sendImageMessage>) => track(sendImageMessage(...args)),
    broadcast,
    handleHttpRequest,
    handleWsMessage
  };
}

async function defaultGetEmoticons({ steamUser, waitForLogin, waitForWebSession }: GetEmoticonsOptions): Promise<EmoticonPayload> {
  await resolveWaiter(waitForLogin);
  await resolveWaiter(waitForWebSession);
  const source = steamUser?.getEmoticonList || steamUser?.chat?.getEmoticonList;
  if (!source) return { emoticons: [], stickers: [] };
  const context = steamUser?.getEmoticonList ? steamUser : steamUser.chat;
  const response = await callMaybeCallback(source, context, []);
  const emoticons = isRecord(response)
    ? arrayFromUnknown(response.emoticons || response.emoticon_list)
    : [];
  const stickers = isRecord(response)
    ? arrayFromUnknown(response.stickers || response.sticker_list)
    : [];
  return { emoticons, stickers };
}

async function listFriends(steamUser?: SteamUserLike): Promise<FriendSummary[]> {
  if (!steamUser) return [];
  const friends = isRecord(steamUser.myFriends) ? steamUser.myFriends : {};
  const ids = Object.keys(friends);
  const users = steamUser.users || {};
  return ids.map((id) => {
    const persona = users[id] || {};
    const state = persona.persona_state ?? persona.personaState ?? friends[id];
    return {
      id,
      name: persona.player_name || persona.personaName || persona.name || id,
      avatar: persona.avatar_url_icon || persona.avatar_url_medium || persona.avatar || '',
      personaState: state,
      online: Number(state || 0) > 0,
      gameName: persona.game_name || persona.gameName || ''
    };
  }).sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
}

function groupFromUnknown(group: unknown, fallbackId = ''): GroupSummary {
  if (!isRecord(group)) {
    const id = steamIdToString(group || fallbackId);
    return { id, clanId: '', name: id };
  }
  const id = steamIdToString(group.steamID || group.id || fallbackId || group);
  const clanId = typeof group.clanid === 'string'
    ? group.clanid
    : typeof group.clanID === 'string'
      ? group.clanID
      : '';
  const name = typeof group.name === 'string'
    ? group.name
    : typeof group.group_name === 'string'
      ? group.group_name
      : id;
  return { id, clanId, name };
}

async function listGroups(steamUser?: SteamUserLike): Promise<GroupSummary[]> {
  if (!steamUser) return [];
  const groups = steamUser.myGroups || steamUser.groups || {};
  if (Array.isArray(groups)) {
    return groups.map((group) => groupFromUnknown(group));
  }
  if (!isRecord(groups)) return [];
  return Object.entries(groups).map(([id, group]) => groupFromUnknown(group, id));
}

module.exports = {
  DEFAULT_CHAT_CONFIG,
  IMAGE_CACHE_DIR,
  MAX_BODY_BYTES,
  MAX_WS_CONNECTIONS,
  STICKER_CACHE_DIR,
  cacheKeyForUrl,
  createAuthChecker,
  createChatService,
  decodeBase64Image,
  defaultGetEmoticons,
  extractStickerType,
  inferImageContentType,
  isAllowedRemoteImageUrl,
  isLocalOrLanIp,
  isSessionExpiredError,
  isTransientSteamError,
  listFriends,
  listGroups,
  loadOrDownloadRemoteImage,
  loadOrDownloadSticker,
  normalizeChatConfig,
  normalizeIp,
  previewForMessage,
  readRequestBody,
  stickerUrlForType
};
