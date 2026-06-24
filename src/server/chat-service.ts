'use strict';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket as WsConnection, WebSocketServer as WsServer } from 'ws';
import type { AppSession } from '../auth/session';
import type { PublicUser } from '../auth/store';
import type {
  AuthConfig,
  CallbackStyleFunction,
  ChatConfig,
  ConversationSummary,
  HistoryItem,
  LoggerLike,
  Persona,
  UnknownRecord
} from '../types';
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
const { createAuthChecker } = require('./auth');
const { isLocalOrLanIp, normalizeIp } = require('./network');

type Waiter = Promise<unknown> | (() => Promise<unknown> | unknown);

type SteamChatApi = {
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
};

type SteamUserLike = {
  chat?: SteamChatApi;
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
  on?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
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
  getSelfName?: () => Promise<string>;
  getEmoticons?: (options: GetEmoticonsOptions) => Promise<EmoticonPayload>;
  fetchImpl?: typeof fetch;
  server?: Server;
  authStore?: AuthStoreLike;
  sessionManager?: SessionManagerLike;
  steamLoginService?: SteamLoginServiceLike;
};

type AuthStoreLike = {
  authenticate: (username: unknown, password: unknown) => PublicUser | null;
  changeOwnPassword: (id: unknown, oldPassword: unknown, newPassword: unknown) => PublicUser;
  createInitialAdmin: (input: UnknownRecord) => PublicUser;
  createUser: (input: UnknownRecord) => PublicUser;
  deleteUser: (id: unknown, currentUserId: unknown) => void;
  listUsers: () => PublicUser[];
  requiresSetup: () => boolean;
  setPassword: (id: unknown, password: unknown) => PublicUser;
  updateUser: (id: unknown, patch: UnknownRecord) => PublicUser;
};

type SessionManagerLike = {
  createClearCookie: (req?: IncomingMessage) => string;
  createSetCookie: (user: PublicUser, req?: IncomingMessage) => string;
  getSession: (req: IncomingMessage) => AppSession | null;
  requireAdmin: (req: IncomingMessage) => AppSession;
  requireSession: (req: IncomingMessage) => AppSession;
};

type SteamStatusSummary = {
  status: string;
  requiresGuard?: boolean;
  guardType?: string | null;
  domain?: string | null;
  lastCodeWrong?: boolean;
  error?: string | null;
  steamId?: string | null;
};

type SteamLoginServiceLike = {
  ensureOnline: () => void;
  getStatus: () => SteamStatusSummary;
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
  const recentSentText = new Map<string, number>();
  const recentSentImages = new Map<string, number>();

  const server: Server = options.server || http.createServer(handleHttpRequest);
  const wss: WsServer = new WebSocketServer({ noServer: true });

  function remember(map: Map<string, number>, key: string, ttl = 30 * 1000) {
    map.set(key, Date.now());
    setTimeout(() => map.delete(key), ttl).unref?.();
  }

  function isRecent(map: Map<string, number>, key: string) {
    return map.has(key);
  }

  function broadcast(payload: unknown, except?: WsConnection) {
    for (const ws of clients) {
      if (ws !== except) sendWs(ws, payload);
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
      steam: currentSteamStatus()
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
      jsonResponse(res, 200, { ok: true, user, steam: currentSteamStatus() }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const user = authStore.authenticate(body.username, body.password);
      if (!user) throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
      jsonResponse(res, 200, { ok: true, user, steam: currentSteamStatus() }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      jsonResponse(res, 200, { ok: true }, {
        'Set-Cookie': sessionManager.createClearCookie(req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/password') {
      const session = sessionManager.requireSession(req);
      const body = await readJsonBody(req);
      const user = authStore.changeOwnPassword(session.user.id, body.oldPassword, body.newPassword);
      jsonResponse(res, 200, { ok: true, user }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    return false;
  }

  async function handleUsersApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!authStore || !sessionManager) return false;
    if (pathname === '/api/users') {
      requireAdminSession(req);
      if (req.method === 'GET') {
        jsonResponse(res, 200, { users: authStore.listUsers() });
        return true;
      }
      if (req.method === 'POST') {
        const user = authStore.createUser(await readJsonBody(req));
        jsonResponse(res, 201, { ok: true, user });
        return true;
      }
      return false;
    }

    const passwordMatch = pathname.match(/^\/api\/users\/(\d+)\/password$/);
    if (passwordMatch && req.method === 'POST') {
      requireAdminSession(req);
      const body = await readJsonBody(req);
      const user = authStore.setPassword(passwordMatch[1], body.password);
      jsonResponse(res, 200, { ok: true, user });
      return true;
    }

    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
      const session = requireAdminSession(req);
      if (req.method === 'PATCH') {
        const user = authStore.updateUser(userMatch[1], await readJsonBody(req));
        jsonResponse(res, 200, { ok: true, user });
        return true;
      }
      if (req.method === 'DELETE') {
        authStore.deleteUser(userMatch[1], session?.user.id);
        jsonResponse(res, 200, { ok: true });
        return true;
      }
    }

    return false;
  }

  async function handleSteamApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!steamLoginService) return false;

    if (req.method === 'GET' && pathname === '/api/steam/status') {
      requireLegacyOrSession(req);
      jsonResponse(res, 200, currentSteamStatus());
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/steam/login') {
      requireAdminSession(req);
      const status = steamLoginService.login(await readJsonBody(req));
      jsonResponse(res, 200, status);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/steam/guard') {
      requireAdminSession(req);
      const body = await readJsonBody(req);
      jsonResponse(res, 200, steamLoginService.submitGuard(body.code));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/steam/logout') {
      requireAdminSession(req);
      jsonResponse(res, 200, steamLoginService.logout());
      return true;
    }

    return false;
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

  async function sendTextMessage(id: unknown, msg: unknown): Promise<HistoryItem> {
    if (!id || !String(msg || '').trim()) {
      throw Object.assign(new Error('id and msg are required'), { statusCode: 400 });
    }
    if (!steamUser?.chat?.sendFriendMessage && !steamUser?.sendFriendMessage) {
      throw new Error('Steam chat sender is unavailable');
    }
    const message = String(msg);
    await withSteamRetry(() => {
      const sender = steamUser.chat?.sendFriendMessage || steamUser.sendFriendMessage;
      const context = steamUser.chat?.sendFriendMessage ? steamUser.chat : steamUser;
      if (!sender) throw new Error('Steam chat sender is unavailable');
      return callMaybeCallback(sender, context, [id, message]);
    });
    remember(recentSentText, `${id}:${message}`);
    const item = await appendLog({
      type: 'message',
      echo: true,
      id,
      name: await getSelfName(),
      message
    }, { logPath });
    broadcast({ type: 'message', ...item });
    return item;
  }

  async function sendImageMessage(id: unknown, body: ImageBody): Promise<HistoryItem> {
    if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
    if (!steamCommunity || typeof steamCommunity.sendImageToUser !== 'function') {
      throw new Error('Steam image sender is unavailable');
    }
    let imageBuffer: Buffer;
    let imageUrl: string | null = body.url || null;
    if (body.img) {
      imageBuffer = decodeBase64Image(body.img);
    } else if (body.url) {
      const downloaded = await loadOrDownloadRemoteImage(body.url, { fetchImpl });
      imageBuffer = downloaded.buffer;
      remember(recentSentImages, body.url);
    } else {
      throw Object.assign(new Error('img or url is required'), { statusCode: 400 });
    }
    const imageArgs = steamCommunity.sendImageToUser.length >= 4 ? [id, imageBuffer, 'image.png'] : [id, imageBuffer];
    const result = await withSteamRetry(() => callMaybeCallback(steamCommunity.sendImageToUser, steamCommunity, imageArgs), true);
    if (!imageUrl && isRecord(result) && typeof result.url === 'string') imageUrl = result.url;
    if (imageUrl) remember(recentSentImages, imageUrl);
    const item = await appendLog({
      type: 'image',
      echo: true,
      id,
      name: await getSelfName(),
      message: '',
      imageUrl,
      sentAt: new Date().toISOString()
    }, { logPath });
    return item;
  }

  function containsRecentImageEcho(message: unknown): boolean {
    const text = String(message || '');
    for (const url of recentSentImages.keys()) {
      if (text.includes(url)) return true;
    }
    return false;
  }

  async function handleSteamIncoming(steamID: unknown, message: unknown, type?: unknown, chatter?: unknown, ordinal?: unknown) {
    const id = steamIdToString(steamID);
    if (containsRecentImageEcho(message)) return;
    const info = await getUserInfo(steamID).catch((): Persona => ({ player_name: id }));
    const item = normalizeHistoryItem({
      type: 'message',
      id,
      name: info.player_name || info.personaName || id,
      message: typeof message === 'string' ? message : '',
      ordinal: typeof ordinal === 'string' || typeof ordinal === 'number' ? ordinal : null
    });
    broadcast({ type: 'message', ...item });
  }

  async function handleSteamEcho(steamID: unknown, message: unknown, ordinal?: unknown) {
    const id = steamIdToString(steamID);
    if (isRecent(recentSentText, `${id}:${message}`) || containsRecentImageEcho(message)) return;
    const item = normalizeHistoryItem({
      type: 'message',
      echo: true,
      id,
      name: await getSelfName(),
      message: typeof message === 'string' ? message : '',
      ordinal: typeof ordinal === 'string' || typeof ordinal === 'number' ? ordinal : null
    });
    broadcast({ type: 'message', ...item });
  }

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && isStaticRequest(url.pathname)) {
        if (await serveStatic(req, res, url.pathname)) return;
      }

      if (await handleAuthApi(req, res, url.pathname)) return;
      if (await handleSteamApi(req, res, url.pathname)) return;
      if (await handleUsersApi(req, res, url.pathname)) return;

      requireLegacyOrSession(req);

      if (req.method === 'GET') {
        if (url.pathname === '/api/config') {
          jsonResponse(res, 200, { wsPath: config.wsPath });
          return;
        }
        if (url.pathname === '/api/emoticons') {
          requireSteamOnline();
          const data = await getEmoticons({ steamUser, waitForLogin, waitForWebSession });
          jsonResponse(res, 200, data);
          return;
        }
        if (url.pathname === '/api/friends') {
          requireSteamOnline();
          jsonResponse(res, 200, await listFriends(steamUser));
          return;
        }
        if (url.pathname === '/api/groups') {
          requireSteamOnline();
          jsonResponse(res, 200, await listGroups(steamUser));
          return;
        }
        if (url.pathname === '/history') {
          jsonResponse(res, 200, await readHistory({
            logPath,
            id: url.searchParams.get('id'),
            limit: url.searchParams.get('limit'),
            logger
          }));
          return;
        }
        if (url.pathname === '/conversations') {
          jsonResponse(res, 200, await buildConversations({
            logPath,
            limit: url.searchParams.get('limit'),
            getUserInfo,
            logger
          }));
          return;
        }
        if (url.pathname.startsWith('/proxy/sticker/')) {
          const type = decodeURIComponent(url.pathname.slice('/proxy/sticker/'.length));
          const sticker = await loadOrDownloadSticker(type, { fetchImpl });
          textResponse(res, 200, sticker.buffer, { 'Content-Type': sticker.contentType, 'Cache-Control': 'public, max-age=86400' });
          return;
        }
        if (url.pathname === '/proxy/image') {
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
        const body = await readJsonBody(req);
        const item = await sendTextMessage(body.id, body.msg);
        jsonResponse(res, 200, { ok: true, item });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/image' || url.pathname === '/img')) {
        const body = await readJsonBody(req);
        const item = await sendImageMessage(body.id, body);
        broadcast({ type: 'image', ...item });
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
    const reply = (message: UnknownRecord) => sendWs(ws, requestId ? { requestId, ...message } : message);
    try {
      if (type === 'ping') {
        reply({ type: 'pong' });
        return;
      }
      if (type === 'send_message' || type === 'msg') {
        const item = await sendTextMessage(payload.id, payload.msg || payload.message || '');
        reply({ type: 'message_sent', item });
        return;
      }
      if (type === 'send_image' || type === 'img') {
        const item = await sendImageMessage(payload.id, payload);
        reply({ type: 'image_sent', item });
        broadcast({ type: 'image', ...item }, ws);
        return;
      }
      if (type === 'get_history' || type === 'history') {
        reply({
          type: 'history',
          items: await readHistory({ logPath, id: payload.id, limit: payload.limit, logger })
        });
        return;
      }
      if (type === 'get_conversations' || type === 'conversations') {
        reply({
          type: 'conversations',
          conversations: await buildConversations({ logPath, limit: payload.limit, getUserInfo, logger })
        });
        return;
      }
      if (type === 'get_emoticons' || type === 'emoticons') {
        requireSteamOnline();
        reply({ type: 'emoticons', ...(await getEmoticons({ steamUser, waitForLogin, waitForWebSession })) });
        return;
      }
      if (type === 'get_friends' || type === 'friends') {
        requireSteamOnline();
        reply({ type: 'friends', friends: await listFriends(steamUser) });
        return;
      }
      if (type === 'get_groups' || type === 'groups') {
        requireSteamOnline();
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
    ws.on('message', (raw: RawData) => handleWsMessage(ws, raw));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  if (steamUser?.on) {
    steamUser.on('friendMessage', (steamID: unknown, message: unknown, type?: unknown, chatter?: unknown, ordinal?: unknown) => {
      handleSteamIncoming(steamID, message, type, chatter, ordinal).catch((error) => {
        logger.warn?.('Failed to broadcast Steam message', { error: errorMessage(error) });
      });
    });
    steamUser.on('friendMessageEcho', (steamID: unknown, message: unknown, ordinal?: unknown) => {
      handleSteamEcho(steamID, message, ordinal).catch((error) => {
        logger.warn?.('Failed to broadcast Steam echo', { error: errorMessage(error) });
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
    stop() {
      for (const ws of clients) ws.close();
      wss.close();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    sendTextMessage,
    sendImageMessage,
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
