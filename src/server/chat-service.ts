'use strict';

import { ImageEmoteStore } from '../storage/image-emotes';
import { handleDeployWebhook } from './deploy-webhook';
import { readMessageReactions, updateMessageReaction, type ReactionClient } from './message-reactions';
import { resolveBilibiliLink } from './bilibili-links';
import { resolveStickerAlias } from './sticker-inventory';
import { SteamInventoryCache, type SteamInventory } from './steam-inventory-cache';
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
import { sendSteamImage, sendSteamImageAttempt } from './image-upload';
import { SendOperations, SendOperationOptions, SendOwner } from './send-operations';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const { ALL_PERMISSIONS, FAILED_LOGIN_LOCK_THRESHOLD } = require('../auth/store') as { ALL_PERMISSIONS: UserPermission[]; FAILED_LOGIN_LOCK_THRESHOLD: number };

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
const { WEB_DIR, DATA_DIR } = require('../paths');
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

type SteamUserLike = ReactionClient & {
  steamID?: unknown;
  chat?: SteamChatApi;
  sendFriendMessage?: CallbackStyleFunction;
  getEmoticonList?: CallbackStyleFunction;
  on?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  off?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: 'friendMessage' | 'friendMessageEcho', listener: (...args: unknown[]) => void) => void;
  myFriends?: UnknownRecord;
  myNicknames?: UnknownRecord;
  getProductInfo?: CallbackStyleFunction;
  users?: Record<string, Persona>;
  myGroups?: unknown;
  groups?: unknown;
};

type SteamCommunityLike = {
  steamID?: unknown;
  getUserInventoryContents?: CallbackStyleFunction;
  sendImageToUser?: CallbackStyleFunction;
  httpRequest?: CallbackStyleFunction;
  httpRequestPost?: CallbackStyleFunction;
};

type EmoticonPayload = {
  emoticons: unknown[];
  stickers: unknown[];
  effects?: unknown[];
  complete?: boolean;
  failedCategories?: ('emoticons' | 'stickers' | 'effects')[];
};

type GetEmoticonsOptions = {
  previousInventory?: SteamInventory;
  logger?: LoggerLike;
  steamCommunity?: SteamCommunityLike;
  steamUser?: SteamUserLike;
  waitForLogin: Waiter;
  waitForWebSession: Waiter;
};

type ChatServiceOptions = {
  inventoryCacheDir?: string;
  sendOperationOptions?: Partial<Pick<SendOperationOptions, 'tickMs' | 'windowMs' | 'delaysMs' | 'maxAttempts' | 'random' | 'preparedMs' | 'imageMs' | 'resultMs' | 'maxBytes' | 'userBytes' | 'maxTasks'>>;
  imageEmoteDir?: string;
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
  hasPermission: (user: PublicUser, permission: UserPermission) => boolean;
  effectivePermissions: (userOrId: PublicUser | number) => UserPermission[];
  permissionDetails: (userId: unknown) => Array<{ permission: UserPermission; effective: boolean; source: string }>;
  getPermissionOverrides: (userId: unknown) => Array<{ permission: UserPermission; effect: 'grant' | 'revoke' }>;
  getUserById: (id: unknown) => PublicUser | null;
  getUserByUsername?: (username: unknown) => PublicUser | null;
  unlockUser: (id: unknown, actorId: unknown) => PublicUser;
  listRoles: () => RoleView[];
  getRole: (id: unknown) => RoleView | null;
  createRole: (input: UnknownRecord, actorId?: unknown) => RoleView;
  updateRole: (id: unknown, input: UnknownRecord, actorId?: unknown) => RoleView;
  deleteRole: (id: unknown, actorId?: unknown) => void;
  setPermissionOverrides: (userId: unknown, overrides: unknown, actorId?: unknown) => unknown;
  getSteamGrant: (userId: unknown, accountId: unknown) => StoredSteamGrant | null;
  listUserSteamGrants: (userId: unknown) => SteamGrantRecord[];
  replaceUserSteamGrants: (userId: unknown, grants: unknown, actorId?: unknown) => unknown;
  listSteamGrantOverview: () => unknown;
  listAuditLogs: (filters?: UnknownRecord) => PublicAuditLog[];
  listSteamAccountsForUser: (userId: unknown) => PublicSteamAccount[];
  listUserSessions: (userId: unknown) => PublicUserSession[];
  listUserSteamAccounts: (userId: unknown) => PublicSteamAccount[];
  listUsers: (filters?: UnknownRecord) => PublicUser[];
  markSteamAccountActive: (id: unknown) => void;
  recordAudit: (input: UnknownRecord) => PublicAuditLog;
  replaceUserSteamAccounts: (userId: unknown, steamAccountIds: unknown, grantedBy?: unknown) => PublicSteamAccount[];
  requiresSetup: () => boolean;
  revokeSession: (sessionId: unknown, revokedBy?: unknown) => boolean;
  revokeUserSessions: (userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown) => number;
  setActiveSteamAccount: (id: unknown) => PublicSteamAccount;
  setPassword: (id: unknown, password: unknown, options?: UnknownRecord) => PublicUser;
  updateSteamAccount: (id: unknown, patch: UnknownRecord) => PublicSteamAccount;
  updateUser: (id: unknown, patch: UnknownRecord, actorId?: unknown) => PublicUser;
  upsertSteamAccount: (input: UnknownRecord) => PublicSteamAccount;
};

type SessionManagerLike = {
  createClearCookie: (req?: IncomingMessage) => string;
  createSetCookie: (user: PublicUser, req?: IncomingMessage) => string;
  getSession: (req: IncomingMessage) => AppSession | null;
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
  accessRevision?: string;
  steamGrant?: { level: SteamLevel; scope: 'all' | 'some'; peerCount: number; expiresAt: string | null; via: 'grant' | 'all' } | null;
  qrLogin?: { imageDataUrl: string | null; scanned: boolean; expiresAt: number } | null;
};

type SteamLoginServiceLike = {
  ensureOnline: () => void;
  getStatus: () => SteamStatusSummary;
  connectWithRefreshToken?: (refreshToken: unknown, steamID?: unknown) => SteamStatusSummary;
  login: (input: UnknownRecord) => SteamStatusSummary;
  startQrLogin?: () => SteamStatusSummary;
  cancelQrLogin?: () => SteamStatusSummary;
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
  emoteId?: string;
};

type SteamAccessContext = {
  session: AppSession | null;
  activeAccount: PublicSteamAccount | null;
  steamAccountId?: string;
  includeLegacy: boolean;
  grant: { level: SteamLevel; scope: 'all' | 'some'; peers: Set<string> } | null;
};

type SteamLevel = 'read' | 'chat' | 'full';
type StoredSteamGrant = { level: SteamLevel; scope: 'all' | 'some'; peers: Set<string>; expiresAt: string | null; via: 'grant' | 'all' };
type SteamGrantRecord = Omit<StoredSteamGrant, 'via' | 'peers'> & { peers: string[]; steamAccountId: number; updatedAt?: string; updatedBy?: number | null };
type RoleView = { id: string; name: string; description: string; builtin: boolean; permissions: UserPermission[]; memberCount: number; editable?: boolean; deletable?: boolean };

function requiresFullLevel(text: unknown): boolean {
  return /^\s*\/(sticker|roomeffect)(\s|$)/i.test(String(text || '')) || /\[(sticker|roomeffect)\b/i.test(String(text || ''));
}

function requireLevel(access: Pick<SteamAccessContext, 'grant'>, required: SteamLevel) {
  const ranks = { read: 1, chat: 2, full: 3 };
  if (!access.grant || ranks[access.grant.level] < ranks[required]) {
    const names = { read: '只读', chat: '聊天', full: '完整' };
    throw Object.assign(new Error(`当前 Steam 授权不足，需要「${names[required]}」授权`), {
      statusCode: 403, code: 'steam_grant_insufficient', required
    });
  }
}

function peerAllowed(access: Pick<SteamAccessContext, 'grant'>, peer: unknown): boolean {
  const id = String(peer || '');
  if (!access.grant) return false;
  if (access.grant.scope === 'all') return true;
  // A restricted grant never includes group/clan IDs, even if one was stored as a peer.
  if (/^\d{17}$/.test(id) && [7n, 8n].includes((BigInt(id) >> 52n) & 15n)) return false;
  return access.grant.peers.has(id);
}

function requirePeer(access: SteamAccessContext, peer: unknown) {
  if (!peerAllowed(access, peer)) throw Object.assign(new Error('该会话不在 Steam 授权好友范围内'), {
    statusCode: 403, code: 'steam_peer_out_of_scope'
  });
}

function filterPeers<T extends { id: string }>(access: SteamAccessContext, items: T[]): T[] {
  return items.filter(item => peerAllowed(access, item.id));
}

type FriendSummary = {
  id: string;
  name: string;
  avatar: string;
  personaState: unknown;
  online: boolean;
  gameName: string;
  /** Nickname the logged-in account set for this friend. */
  nickname: string;
  /** Steam app currently played; 0 when not in a Steam game. */
  gameAppId: number;
  /** In-game status text published by the game, e.g. map and score. */
  richPresence: string;
  /** ISO time the friend was last seen online, or '' when Steam has not reported it. */
  lastOnline: string;
};

function personaDate(value: unknown): string {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value * 1000 : NaN;
  // Steam reports 0 (1970) for unknown times.
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : '';
}

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
  wsHeartbeatMs: 45_000,
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

function heartbeatProp(value: unknown): number {
  if (value === 0) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_CHAT_CONFIG.wsHeartbeatMs;
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
    wsHeartbeatMs: heartbeatProp(config.wsHeartbeatMs),
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
  if (isRecord(error) && typeof error.code === 'string') payload.code = error.code;
  if (isRecord(error) && typeof error.required === 'string') payload.required = error.required;
  if (isRecord(error) && typeof error.memberCount === 'number') payload.memberCount = error.memberCount;
  if (isRecord(error) && typeof error.remainingAttempts === 'number') payload.remainingAttempts = error.remainingAttempts;
  if (isRecord(error) && typeof error.lockedUntil === 'string') payload.lockedUntil = error.lockedUntil;
  if (isRecord(error) && error.statusCode === 403) payload.statusCode = 403;
  if (isRecord(error) && typeof error.steamStatus === 'string') {
    payload.steamStatus = error.steamStatus;
  }
  if (isRecord(error) && error.resetRequired === true) payload.resetRequired = true;
  if (isRecord(error) && typeof error.uncertain === 'boolean') payload.uncertain = error.uncertain;
  if (isRecord(error) && ['prepare', 'begin', 'upload', 'commit', 'unknown'].includes(String(error.imageUploadPhase))) {
    payload.imageUploadPhase = error.imageUploadPhase;
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
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.m4a': 'audio/mp4',
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
    || pathname === '/console.js'
    || pathname === '/vendor/artplayer-5.4.0.mjs'
    || pathname === '/vendor/artplayer-LICENSE.txt'
    || pathname === '/sw.js'
    || pathname === '/manifest.webmanifest'
    || pathname.startsWith('/sounds/')
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
    const versions = new URL(req.url || '/', 'http://localhost').searchParams.getAll('v');
    const unversioned = ['/', '/index.html', '/sw.js', '/manifest.webmanifest'].includes(pathname);
    // Match the build's v contract: the first 16 lowercase SHA-256 hex digits.
    const immutable = !unversioned && versions.length === 1 && /^[a-f0-9]{16}$/.test(versions[0])
      && versions[0] === createHash('sha256').update(data).digest('hex').slice(0, 16);
    textResponse(res, 200, data, {
      'Content-Type': contentTypeForPath(filePath),
      'Cache-Control': unversioned ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60'
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
  if (isRecord(error) && Number(error.eresult) === 21) return true; // Steam EResult.NotLoggedOn
  const text = `${errorCode(error)} ${errorMessage(error)}`.toLowerCase();
  if (/not\s*logged\s*(?:in|on)\b|session (?:expired|invalid)|(?:expired|invalid) session/.test(text)) return true;
  return ['access denied', 'forbidden', 'eresult 15'].some((needle) => text.includes(needle));
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
  const conversationCursorKey = randomBytes(32);
  const rawConfig = isRecord(options.config) && 'chat' in options.config
    ? options.config.chat
    : options.chatConfig ?? options.config ?? true;
  const config = normalizeChatConfig(rawConfig);
  const historyStorage = options.historyStorage;
  const imageEmotes = new ImageEmoteStore(options.imageEmoteDir || path.join(DATA_DIR, 'image-emotes'));
  const sendOperations = new SendOperations({ ...options.sendOperationOptions, refreshWebSession: () => refreshSharedWebSession(),
    onChange: (owner, operation) => {
      for (const ws of clients) {
        const session = liveWsSession(ws);
        if (session?.user.id === owner.userId && session.sessionId === owner.sessionId && canWsReceive(ws, { id: operation.peerId, steamAccountId: owner.account })
          && wsAccessContext(ws, false).grant?.level === 'full'
          && ensureActiveSteamAccount()?.steamId === owner.account) sendWs(ws, { type: 'send_operation', operation });
      }
    },
    send: async input => {
      let authorizationError: unknown;
      const authorize = () => {
        try { input.authorize(); }
        catch (error) { authorizationError = error; throw error; }
      };
      authorize();
      try { checkSend(input.account); } catch (error) { throw Object.assign(error as object, { uncertain: false, retryable: true }); }
      if (!steamCommunity?.sendImageToUser) throw Object.assign(new Error('Steam 图片发送器不可用。'), { uncertain: false });
      const args = steamCommunity.sendImageToUser.length >= 4 ? [input.peerId, input.buffer, {}] : [input.peerId, input.buffer];
      try {
        const result = await sendSteamImageAttempt(steamCommunity,
          receiver => callMaybeCallback(steamCommunity.sendImageToUser!, receiver, args), {
            signal: input.signal, authorize, onPhase: input.phase, onTransport: input.transport,
            timeoutMs: Math.max(1, Math.min(30000, input.deadline - Date.now()))
          });
        const message = typeof result === 'string' ? result : isRecord(result) && typeof result.url === 'string' ? result.url : '';
        if (!message) throw Object.assign(new Error('Steam 未返回图片确认，结果未确认。'), { uncertain: true });
        const record: HistoryRecordInput = { imageSendSource: 'upload', type: 'image', echo: true, steamAccountId: input.account,
          id: input.peerId, name: await settleMetadata(getSelfName(input.account), 'Me'), message };
        return persistSent(record);
      } catch (error) {
        if (authorizationError) throw authorizationError;
        const info = { operationId: input.operationId, attempt: input.attempt, totalAttempts: input.totalAttempts,
          ...(isRecord(error) ? { phase: error.imageUploadPhase, uncertain: error.uncertain, eresult: error.eresult } : { phase: 'unknown' }) };
        logger.warn?.(`Steam image operation attempt failed ${JSON.stringify(info)}`, info);
        throw error;
      }
    } });
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
  const inventoryCache = new SteamInventoryCache({ dir: options.inventoryCacheDir || path.join(DATA_DIR, 'steam-inventory'), logger });
  const fetchImpl = options.fetchImpl;
  const authStore = options.authStore;
  const sessionManager = options.sessionManager;
  const steamLoginService = options.steamLoginService;
  const legacyAuth = createAuthChecker(config.auth);
  const clients = new Set<WsConnection>();
  const wsRequests = new Map<WsConnection, IncomingMessage>();
  const unansweredPings = new Set<WsConnection>();
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

  function steamStatusForSession(session: Pick<AppSession, 'user'> | null): SteamStatusSummary {
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    const grant = session && active ? authStore?.getSteamGrant(session.user.id, active.id) : null;
    const legacy = !sessionManager;
    const accessAllowed = legacy || Boolean(grant);
    return {
      ...status,
      qrLogin: session && authStore?.hasPermission(session.user, 'steam.manage') ? status.qrLogin : null,
      activeAccount: accessAllowed || (session && authStore?.hasPermission(session.user, 'steam.manage')) ? activeAccountSummary(active) : null,
      accessAllowed,
      accessRevision: grant ? createHash('sha256').update(JSON.stringify([grant.level, grant.scope, [...grant.peers].sort(), grant.expiresAt])).digest('hex').slice(0, 24) : undefined,
      steamGrant: grant ? { level: grant.level, scope: grant.scope, peerCount: grant.peers.size, expiresAt: grant.expiresAt, via: grant.via }
        : legacy ? { level: 'full', scope: 'all', peerCount: 0, expiresAt: null, via: 'all' } : null
    };
  }

  function requirePermission(req: IncomingMessage, permission: UserPermission): AppSession | null {
    if (!sessionManager || !authStore) return requireLegacyOrSession(req);
    const session = sessionManager.requireSession(req);
    if (!authStore.hasPermission(session.user, permission)) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return session;
  }

  function requireAnyPermission(req: IncomingMessage, permissions: UserPermission[]): AppSession | null {
    const session = requireLegacyOrSession(req);
    if (session && authStore && !permissions.some(permission => authStore.hasPermission(session.user, permission))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return session;
  }

  function requireUser(id: unknown): PublicUser {
    const user = authStore!.getUserById(id);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return user;
  }

  async function readManagementBody(req: IncomingMessage) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      throw Object.assign(new Error('JSON body is required'), { statusCode: 400 });
    }
    const parsed: unknown = JSON.parse(await readRequestBody(req));
    if (!isRecord(parsed) || Array.isArray(parsed)) throw Object.assign(new Error('JSON object is required'), { statusCode: 400 });
    return parsed;
  }

  function userGrants(id: unknown) {
    requireUser(id);
    return { steamAccounts: authStore!.listUserSteamAccounts(id), grants: authStore!.listUserSteamGrants(id) };
  }

  function userPermissions(id: unknown) {
    const user = requireUser(id);
    const details = authStore!.permissionDetails(id);
    return { roleId: user.roleId, overrides: authStore!.getPermissionOverrides(id), details };
  }

  async function handleRolesApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!authStore || !sessionManager) return false;
    if (url.pathname === '/api/steam/grants' && req.method === 'GET') {
      requireAnyPermission(req, ['steam.grant.manage', 'user.view']);
      jsonResponse(res, 200, authStore.listSteamGrantOverview());
      return true;
    }
    if (url.pathname === '/api/roles') {
      if (req.method === 'GET') {
        requireAnyPermission(req, ['user.view', 'role.manage']);
        jsonResponse(res, 200, { roles: authStore.listRoles(), permissions: ALL_PERMISSIONS });
        return true;
      }
      if (req.method === 'POST') {
        const session = requirePermission(req, 'role.manage');
        const body = await readManagementBody(req);
        const role = authStore.createRole(body, session?.user.id);
        jsonResponse(res, 201, { role });
        return true;
      }
    }
    const match = /^\/api\/roles\/([^/]+)$/.exec(url.pathname);
    if (match && ['PATCH', 'DELETE'].includes(req.method || '')) {
      const session = requirePermission(req, 'role.manage');
      const id = decodeURIComponent(match[1]);
      const before = authStore.getRole(id);
      if (!before) throw Object.assign(new Error('Role not found'), { statusCode: 404 });
      if (req.method === 'PATCH') {
        const role = authStore.updateRole(id, await readManagementBody(req), session?.user.id);
        jsonResponse(res, 200, { role });
      } else {
        authStore.deleteRole(id, session?.user.id);
        jsonResponse(res, 200, { ok: true });
      }
      return true;
    }
    return false;
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
    if (session && authStore && !authStore.hasPermission(session.user, 'chat.use')) {
      throw Object.assign(new Error('没有使用聊天的权限'), { statusCode: 403 });
    }
    if (needsOnline) requireSteamOnline();
    if (!sessionManager || !authStore) {
      const active = ensureActiveSteamAccount();
      return {
        session,
        activeAccount: active,
        steamAccountId: active?.steamId || currentSteamStatus().steamId || undefined,
        includeLegacy: true,
        grant: { level: 'full', scope: 'all', peers: new Set() }
      };
    }
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    if (!active) throw steamAccountUnavailable(status);
    const grant = authStore.getSteamGrant(session?.user.id, active.id);
    if (!grant) requireLevel({ grant: null }, 'read');
    authStore.markSteamAccountActive(active.id);
    return {
      session,
      activeAccount: active,
      steamAccountId: active.steamId,
      includeLegacy: Boolean(session && authStore.hasPermission(session.user, 'steam.account.all')),
      grant: grant ? { ...grant, peers: new Set(grant.peers) } : null
    };
  }

  function liveWsSession(ws: WsConnection): AppSession | null {
    if (!sessionManager) return null;
    const req = wsRequests.get(ws);
    const session = req ? sessionManager.getSession(req) : null;
    if (!session) ws.close(1008, 'Session expired or revoked');
    return session;
  }

  function recheckReadAccess(req: IncomingMessage, previous: SteamAccessContext, needsOnline = false) {
    const current = requireSteamAccountAccess(req, needsOnline);
    if (previous.steamAccountId !== current.steamAccountId) {
      throw Object.assign(new Error('Steam account changed during request'), { statusCode: 409 });
    }
    return current;
  }

  function wsAccessContext(ws: WsConnection, needsOnline: boolean): SteamAccessContext {
    const session = liveWsSession(ws);
    if (sessionManager && !session) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (session && authStore && !authStore.hasPermission(session.user, 'chat.use')) {
      throw Object.assign(new Error('没有使用聊天的权限'), { statusCode: 403 });
    }
    if (needsOnline) requireSteamOnline();
    if (!sessionManager || !authStore) {
      const active = ensureActiveSteamAccount();
      return { session, activeAccount: active, steamAccountId: active?.steamId || currentSteamStatus().steamId || undefined, includeLegacy: true,
        grant: { level: 'full', scope: 'all', peers: new Set() } };
    }
    const status = currentSteamStatus();
    const active = ensureActiveSteamAccount(status);
    if (!active) throw steamAccountUnavailable(status);
    const grant = session ? authStore.getSteamGrant(session.user.id, active.id) : null;
    if (!grant) requireLevel({ grant: null }, 'read');
    authStore.markSteamAccountActive(active.id);
    return { session, activeAccount: active, steamAccountId: active.steamId,
      includeLegacy: Boolean(session && authStore.hasPermission(session.user, 'steam.account.all')),
      grant: grant ? { ...grant, peers: new Set(grant.peers) } : null };
  }

  function canWsReceive(ws: WsConnection, item?: { id: string; steamAccountId?: string }): boolean {
    if (!sessionManager || !authStore) return true;
    const session = liveWsSession(ws);
    const active = ensureActiveSteamAccount();
    if (!session || !active || (item?.steamAccountId && item.steamAccountId !== active.steamId)) return false;
    const grant = authStore.getSteamGrant(session.user.id, active.id);
    return Boolean(grant && (!item || peerAllowed({ grant: { ...grant, peers: new Set(grant.peers) } }, item.id)));
  }

  function broadcast(payload: unknown, except?: WsConnection) {
    for (const ws of clients) {
      if (isRecord(payload) && payload.type === 'steam_status') {
        if (ws === except) continue;
        const session = liveWsSession(ws);
        if (sessionManager && !session) continue;
        sendWs(ws, { type: 'steam_status', ...steamStatusForSession(session),
          permissions: session && authStore ? authStore.effectivePermissions(session.user) : [],
          permissionDetails: session && authStore ? authStore.permissionDetails(session.user.id) : [] });
        continue;
      }
      const item = isRecord(payload) && payload.type === 'message' && typeof payload.id === 'string'
        ? { id: payload.id, steamAccountId: typeof payload.steamAccountId === 'string' ? payload.steamAccountId : undefined } : undefined;
      if (ws !== except && canWsReceive(ws, item)) sendWs(ws, payload);
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

  function requireSteamOnline() {
    steamLoginService?.ensureOnline?.();
  }

  function inventoryAccount(access: SteamAccessContext): string | undefined {
    const identities = [steamIdToString(steamUser?.steamID), steamIdToString(steamCommunity?.steamID), currentSteamStatus().steamId].filter(Boolean);
    const account = access.steamAccountId || identities[0] || undefined;
    if (identities.some(identity => identity !== account)) {
      throw Object.assign(new Error('Steam account changed during inventory request'), { statusCode: 409 });
    }
    return account;
  }

  async function readInventory(access: SteamAccessContext) {
    const account = inventoryAccount(access);
    const checkAccount = () => {
      const current = { ...access, steamAccountId: ensureActiveSteamAccount()?.steamId || currentSteamStatus().steamId || account };
      if (inventoryAccount(current) !== account) {
        throw Object.assign(new Error('Steam account changed during inventory refresh'), { statusCode: 409 });
      }
    };
    const fetchInventory = async (previousInventory: SteamInventory | undefined) => {
      requireSteamOnline();
      checkAccount();
      if (!options.getEmoticons && (!(steamUser?.getEmoticonList || steamUser?.chat?.getEmoticonList)
        || !steamCommunity?.getUserInventoryContents)) {
        throw Object.assign(new Error('Steam inventory sources are unavailable'), { statusCode: 503 });
      }
      const result = await getEmoticons({ steamUser, steamCommunity, waitForLogin, waitForWebSession, previousInventory, logger });
      checkAccount();
      // Historical injected helpers predate effects. Production must return all three arrays.
      return options.getEmoticons && result.effects === undefined ? { ...result, effects: [] } : result as EmoticonPayload & { effects: unknown[] };
    };
    // Identity-free test helpers get only a service-local memory entry, never a disk scope.
    if (!account && !options.getEmoticons) throw steamAccountUnavailable();
    return inventoryCache.get(account, fetchInventory);
  }

  function writeAuthError(req: IncomingMessage, res: ServerResponse, error: unknown) {
    if (isRecord(error) && error.legacyChallenge && !sessionManager) {
      legacyAuth.challenge(res);
      return;
    }
    jsonResponse(res, statusCodeForError(error), errorPayload(error));
  }

  function clientConfig() {
    return { wsPath: config.wsPath, ...(sessionManager && authStore ? { sendOperations: true, imageOperationUpload: true } : {}) };
  }

  function authMe(req: IncomingMessage) {
    const session = sessionManager?.getSession(req) || null;
    return {
      needsSetup: authStore?.requiresSetup?.() ?? false,
      user: session?.user || null,
      ok: true,
      permissions: session && authStore ? authStore.effectivePermissions(session.user) : [],
      permissionDetails: session && authStore ? authStore.permissionDetails(session.user.id) : [],
      steam: steamStatusForSession(session),
      config: clientConfig()
    };
  }

  async function handleAuthApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!authStore || !sessionManager) return false;

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      jsonResponse(res, 200, authMe(req), { 'Cache-Control': 'no-store' });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/setup') {
      const body = await readJsonBody(req);
      const user = authStore.createInitialAdmin(body);
      jsonResponse(res, 200, { ok: true, user, permissions: authStore.effectivePermissions(user), permissionDetails: authStore.permissionDetails(user.id),
        steam: steamStatusForSession({ user }) }, {
        'Set-Cookie': sessionManager.createSetCookie(user, req)
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      let user: PublicUser | null;
      try { user = authStore.authenticate(body.username, body.password, requestContext(req)); }
      catch (error) {
        if (isRecord(error) && error.statusCode === 423) throw Object.assign(new Error('账号已锁定，请在 15 分钟后重试或联系管理员解除锁定。'), { statusCode: 423, lockedUntil: authStore.getUserByUsername?.(body.username)?.lockedUntil });
        throw error;
      }
      if (!user) {
        const failed = authStore.getUserByUsername?.(body.username);
        const remainingAttempts = failed && !failed.disabled ? Math.max(0, FAILED_LOGIN_LOCK_THRESHOLD - failed.failedLoginCount) : undefined;
        throw Object.assign(new Error(remainingAttempts === undefined ? '账号或密码错误' : remainingAttempts > 0 ? `账号或密码错误，再失败 ${remainingAttempts} 次将锁定 15 分钟。` : '账号已锁定，请在 15 分钟后重试或联系管理员解除锁定。'), { statusCode: 401, remainingAttempts, lockedUntil: failed?.lockedUntil });
      }
      jsonResponse(res, 200, { ok: true, user, permissions: authStore.effectivePermissions(user), permissionDetails: authStore.permissionDetails(user.id),
        steam: steamStatusForSession({ user }) }, {
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
      const body = await readJsonBody(req);
      const keepCurrentSession = body.keepCurrentSession === true;
      const revoked = sessionManager.revokeUserSessions(session.user.id, session.user.id, keepCurrentSession ? session.sessionId : undefined);
      recordAudit(session, req, 'session.logout_all', 'user', session.user.id, { keepCurrentSession, revoked });
      jsonResponse(res, 200, { ok: true, revoked, keepCurrentSession }, keepCurrentSession ? {} : { 'Set-Cookie': sessionManager.createClearCookie(req) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/password') {
      const session = requirePermission(req, 'self.password.change')!;
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
    const unlockMatch = /^\/api\/users\/(\d+)\/unlock$/.exec(pathname);
    if (unlockMatch && req.method === 'POST') {
      const session = requirePermission(req, 'user.manage');
      await readManagementBody(req);
      const user = authStore.unlockUser(unlockMatch[1], session!.user.id);
      jsonResponse(res, 200, { ok: true, user });
      return true;
    }
    if (pathname === '/api/users') {
      if (req.method === 'GET') {
        requirePermission(req, 'user.view');
        jsonResponse(res, 200, {
          users: authStore.listUsers({
            query: url.searchParams.get('query'),
            roleId: url.searchParams.get('roleId') || url.searchParams.get('role'),
            status: url.searchParams.get('status')
          })
        });
        return true;
      }
      if (req.method === 'POST') {
        const session = requirePermission(req, 'user.manage');
        const body = await readManagementBody(req);
        const user = authStore.createUser({ ...body, createdBy: session?.user.id });
        recordAudit(session, req, 'user.create', 'user', user.id, { username: user.username, roleId: user.roleId, steamAccountIds: body.steamAccountIds, steamGrants: body.steamGrants });
        jsonResponse(res, 201, { ok: true, user });
        return true;
      }
      return false;
    }

    const permissionsMatch = /^\/api\/users\/(\d+)\/(permissions|permission-overrides)$/.exec(pathname);
    if (permissionsMatch) {
      if (req.method === 'GET' && permissionsMatch[2] === 'permissions') {
        requirePermission(req, 'user.view');
        jsonResponse(res, 200, userPermissions(permissionsMatch[1]));
        return true;
      }
      if (req.method === 'PUT' && permissionsMatch[2] === 'permission-overrides') {
        const session = requirePermission(req, 'role.manage');
        requireUser(permissionsMatch[1]);
        const body = await readManagementBody(req);
        authStore.setPermissionOverrides(permissionsMatch[1], body.overrides, session?.user.id);
        const after = userPermissions(permissionsMatch[1]);
        jsonResponse(res, 200, { ok: true, ...after });
        return true;
      }
    }

    const sessionsMatch = pathname.match(/^\/api\/users\/(\d+)\/sessions$/);
    if (sessionsMatch) {
      const session = requirePermission(req, 'session.manage');
      if (req.method === 'GET') {
        jsonResponse(res, 200, { sessions: authStore.listUserSessions(sessionsMatch[1]).map(item => ({ ...item, current: item.id === session?.sessionId })) });
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
      if (req.method === 'GET') {
        requirePermission(req, 'user.view');
        jsonResponse(res, 200, userGrants(steamAccountsMatch[1]));
        return true;
      }
      if (req.method === 'PUT') {
        const session = requirePermission(req, 'steam.grant.manage');
        const body = await readManagementBody(req);
        requireUser(steamAccountsMatch[1]);
        if (Object.hasOwn(body, 'grants')) {
          authStore.replaceUserSteamGrants(steamAccountsMatch[1], body.grants, session?.user.id);
        } else {
          if (!Array.isArray(body.steamAccountIds)) throw Object.assign(new Error('steamAccountIds or grants is required'), { statusCode: 400 });
          authStore.replaceUserSteamAccounts(steamAccountsMatch[1], body.steamAccountIds, session?.user.id);
        }
        jsonResponse(res, 200, { ok: true, ...userGrants(steamAccountsMatch[1]) });
        return true;
      }
    }

    const passwordMatch = pathname.match(/^\/api\/users\/(\d+)\/password$/);
    if (passwordMatch && req.method === 'POST') {
      const session = requirePermission(req, 'user.manage');
      const body = await readJsonBody(req);
      const user = authStore.setPassword(passwordMatch[1], body.password, { forcePasswordChange: body.forcePasswordChange, actorId: session?.user.id });
      recordAudit(session, req, 'user.password.reset', 'user', user.id, { forcePasswordChange: body.forcePasswordChange });
      jsonResponse(res, 200, { ok: true, user });
      return true;
    }

    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
      if (req.method === 'GET') {
        requirePermission(req, 'user.view');
        const { passwordHash: _passwordHash, ...user } = requireUser(userMatch[1]) as PublicUser & { passwordHash?: string };
        jsonResponse(res, 200, { user });
        return true;
      }
      const session = requirePermission(req, 'user.manage');
      if (req.method === 'PATCH') {
        const body = await readManagementBody(req);
        const user = authStore.updateUser(userMatch[1], body, session?.user.id);
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

    if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/steam/login/qr') {
      const session = requirePermission(req, 'steam.manage');
      const operation = req.method === 'POST' ? steamLoginService.startQrLogin : steamLoginService.cancelQrLogin;
      if (!operation) throw Object.assign(new Error('Steam QR login is unavailable'), { statusCode: 503 });
      operation.call(steamLoginService);
      recordAudit(session, req, req.method === 'POST' ? 'steam_account.qr_start' : 'steam_account.qr_cancel', 'steam_account', 'pending');
      jsonResponse(res, 200, steamStatusForSession(session), { 'Cache-Control': 'no-store' });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/steam/status') {
      const session = requireLegacyOrSession(req);
      jsonResponse(res, 200, steamStatusForSession(session), { 'Cache-Control': 'no-store' });
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
        category: url.searchParams.get('category'),
        query: url.searchParams.get('query'),
        limit: url.searchParams.get('limit')
      })
    });
    return true;
  }

  let webSessionRefresh: Promise<unknown> | undefined;
  async function refreshSharedWebSession() {
    if (!webSessionRefresh) {
      const pending = Promise.resolve().then(() => refreshWebSession());
      webSessionRefresh = pending;
      void pending.finally(() => { if (webSessionRefresh === pending) webSessionRefresh = undefined; }).catch(() => {});
    }
    return webSessionRefresh;
  }

  async function withSteamRetry<T>(operation: () => Promise<T> | T, needsWebSession = false, retryErrors = true): Promise<T> {
    requireSteamOnline();
    await resolveWaiter(waitForLogin);
    if (needsWebSession) {
      await resolveWaiter(waitForWebSession);
    }
    try {
      return await operation();
    } catch (error) {
      if (isRecord(error) && [401, 403].includes(Number(error.statusCode))) throw error;
      if (!retryErrors) throw error;
      if (isSessionExpiredError(error) && !(needsWebSession && isRecord(error) && error.imageUploadPhase === 'commit')) {
        logger.warn?.('Steam web session rejected; refreshing before one retry');
        await refreshSharedWebSession();
        return operation();
      }
      // A timeout during image commit can mean Steam already sent it.
      if (!needsWebSession && isTransientSteamError(error)) {
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

  function httpSendAuthorization(req: IncomingMessage, access: SteamAccessContext, requested: unknown, level: SteamLevel, peer: unknown): (required?: SteamLevel) => void {
    checkAccountPrecondition(access, requested);
    requireLevel(access, level);
    requirePeer(access, peer);
    // Capture the pre-body account, and recheck access at every actual send attempt.
    return (required = level) => {
      const current = requireSteamAccountAccess(req, true);
      requireLevel(current, required);
      requirePeer(current, peer);
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

  // Storage cursors contain index keys (including peer IDs). Restricted readers
  // receive authenticated opaque tokens so empty filtered pages disclose no peers.
  function conversationCursorBinding(access: SteamAccessContext) {
    return Buffer.from(`${access.session?.user.id || ''}|${access.steamAccountId || ''}`);
  }

  function sealConversationCursor(access: SteamAccessContext, cursor: unknown): string | undefined {
    if (typeof cursor !== 'string' || !cursor) return undefined;
    if (access.grant?.scope !== 'some') return cursor;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', conversationCursorKey, iv);
    cipher.setAAD(conversationCursorBinding(access));
    const encrypted = Buffer.concat([cipher.update(cursor, 'utf8'), cipher.final()]);
    return `sc1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
  }

  function openConversationCursor(access: SteamAccessContext, cursor: unknown): string | undefined {
    if (cursor == null || cursor === '') return undefined;
    const value = String(cursor);
    if (!value.startsWith('sc1.')) return value; // Existing browser pagination remains usable.
    try {
      if (value.length > 8192) throw new Error('cursor too long');
      const bytes = Buffer.from(value.slice(4), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', conversationCursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28)); decipher.setAAD(conversationCursorBinding(access));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw Object.assign(new Error('Invalid conversation cursor; reload the conversation list'), { statusCode: 400 }); }
  }

  function historyQuery(access: SteamAccessContext, input: UnknownRecord) {
    const steamAccountId = historyAccount(access, input.steamAccountId);
    if (!input.id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
    requirePeer(access, input.id);
    return { steamAccountId, id: String(input.id), limit: input.limit == null ? undefined : Number(input.limit),
      before: input.before == null ? undefined : String(input.before),
      after: input.after == null ? undefined : String(input.after),
      at: input.at == null ? undefined : Number(input.at) };
  }

  async function storageHistory(access: SteamAccessContext, input: UnknownRecord) {
    if (input.id) return historyStorage!.history(historyQuery(access, input));
    const steamAccountId = historyAccount(access, input.steamAccountId);
    if (input.before || input.after || input.at != null) {
      throw Object.assign(new Error('id is required for paginated history'), { statusCode: 400 });
    }
    if (access.grant?.scope === 'some' && access.grant.peers.size === 0) return { items: [] as HistoryItem[] };
    const limit = limitFrom(input.limit);
    const conversations: ConversationSummary[] = [];
    let before: string | undefined;
    // At most `limit` visible conversations can contribute to the latest `limit` messages.
    do {
      const page = await historyStorage!.conversations({ steamAccountId, limit, before });
      conversations.push(...filterPeers(access, page.items));
      if (!page.nextCursor || page.nextCursor === before) break;
      before = page.nextCursor;
    } while (conversations.length < limit);
    const items: HistoryItem[] = [];
    for (const conversation of conversations.slice(0, limit)) {
      const page = await historyStorage!.history({ steamAccountId, id: conversation.id, limit });
      items.push(...page.items);
    }
    return { items: items.sort((a, b) => a.date.localeCompare(b.date)).slice(-limit) };
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
    try { return await historyStorage.append(record); }
    catch (error) {
      // Steam already accepted this send. A persistence failure must not invite a retry.
      logger.error?.('Sent message persistence failed', { error: errorMessage(error) });
      return { ...normalizeHistoryItem(record), persistence: { jsonl: 'failed', rocksdb: 'failed' } };
    }
  }

  function rejectGroupRecipient(id: unknown) {
    const value = String(id || '');
    if (/^\d{17}$/.test(value) && [7n, 8n].includes((BigInt(value) >> 52n) & 15n)) {
      throw Object.assign(new Error('群组频道尚未接入，不能使用私聊接口发送群消息'), { statusCode: 400 });
    }
  }

  async function sendTextMessage(id: unknown, msg: unknown, steamAccountId?: string, authorize?: (level?: SteamLevel) => void): Promise<HistoryItem> {
    rejectGroupRecipient(id);
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
    // Resolve the text classification before any waiter or retry can yield to a grant change.
    const level: SteamLevel = requiresFullLevel(message) ? 'full' : 'chat';
    authorize?.(level);
    let submitted = false;
    const result = await withSteamRetry(() => {
      authorize?.(level);
      checkSend(steamAccountId);
      const sender = steamUser.chat?.sendFriendMessage || steamUser.sendFriendMessage;
      const context = steamUser.chat?.sendFriendMessage ? steamUser.chat : steamUser;
      if (!sender) throw new Error('Steam chat sender is unavailable');
      submitted = true;
      return callMaybeCallback(sender, context, [id, message]);
    }, false, false).catch(error => {
      // Steam may deliver the message before its acknowledgement is lost. Text
      // submissions have no idempotency token, so retrying can send another copy.
      if (submitted && (isTransientSteamError(error) || /timed\s*out/i.test(errorMessage(error))
        || isRecord(error) && Number(error.eresult) === 16)) {
        throw Object.assign(new Error('文字发送结果未确认，请先检查聊天记录。', { cause: error }), { statusCode: 502, uncertain: true });
      }
      throw error;
    });
    const canonicalMessage = isRecord(result) && typeof result.modified_message === 'string'
      ? result.modified_message : message;
    if (/^\/sticker(?:\s|$)/i.test(message.trim()) && !/^\[sticker\b[^\]]*\]\s*\[\/sticker\]$/i.test(canonicalMessage.trim())) {
      throw Object.assign(new Error('Steam 未确认贴纸解析，请先检查官方客户端。'), { statusCode: 502, uncertain: true });
    }
    if (/^\/roomeffect(?:\s|$)/i.test(message.trim()) && !/^\[roomeffect\b[^\]]*\]\s*\[\/roomeffect\]$/i.test(canonicalMessage.trim())) {
      throw Object.assign(new Error('Steam 未确认聊天效果解析，请先检查官方客户端。'), { statusCode: 502, uncertain: true });
    }
    remember(recentSentText, `${id}:${canonicalMessage}`);
    const record: HistoryRecordInput = {
      type: 'message',
      echo: true,
      steamAccountId,
      id,
      name: await selfName,
      message: canonicalMessage
    };
    if (isRecord(result)) {
      if (typeof result.ordinal === 'string' || typeof result.ordinal === 'number') record.ordinal = result.ordinal;
      if (result.server_timestamp instanceof Date) record.sentAt = result.server_timestamp.toISOString();
      record.steamEventKey = steamEventKey(steamAccountId, String(id), true, canonicalMessage, result.server_timestamp, result.ordinal);
    }
    return persistSent(record);
  }

  async function sendImageMessage(id: unknown, body: ImageBody, steamAccountId?: string, authorize?: () => void): Promise<HistoryItem> {
    rejectGroupRecipient(id);
    steamAccountId = steamAccountId || ensureActiveSteamAccount()?.steamId || currentSteamStatus().steamId || undefined;
    checkSend(steamAccountId);
    const selfName = settleMetadata(getSelfName(steamAccountId), 'Me');
    if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
    if (!steamCommunity || typeof steamCommunity.sendImageToUser !== 'function') {
      throw new Error('Steam image sender is unavailable');
    }
    let imageBuffer: Buffer;
    let message = body.url || '';
    if (body.emoteId !== undefined) {
      imageBuffer = (await imageEmotes.read(body.emoteId)).buffer;
    } else if (body.img) {
      imageBuffer = decodeBase64Image(body.img);
    } else if (body.url) {
      const downloaded = await loadOrDownloadRemoteImage(body.url, { fetchImpl });
      imageBuffer = downloaded.buffer;
    } else {
      throw Object.assign(new Error('img or url is required'), { statusCode: 400 });
    }
    const imageArgs = steamCommunity.sendImageToUser.length >= 4 ? [id, imageBuffer, {}] : [id, imageBuffer];
    let authorizationError: unknown;
    const guard = () => {
      try { authorize?.(); checkSend(steamAccountId); }
      catch (error) { authorizationError = error; throw error; }
    };
    // Keep the installed SDK and its retry/uncertainty handling, but guard each
    // begin/PUT/commit on a private receiver so concurrent uploads stay isolated.
    const community: SteamCommunityLike = Object.create(steamCommunity);
    for (const key of ['httpRequest', 'httpRequestPost'] as const) {
      const original = steamCommunity[key];
      if (!original) continue;
      community[key] = (...args: unknown[]) => {
        try { guard(); }
        catch (error) {
          if (typeof args[1] === 'function') return args[1](error);
          throw error;
        }
        return original.apply(steamCommunity, args);
      };
    }
    const result = await withSteamRetry(async () => {
      try {
        return await sendSteamImage(community,
          receiver => callMaybeCallback(community.sendImageToUser!, receiver, imageArgs), { authorize: guard, logger });
      } catch (error) { throw authorizationError || error; }
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

  function sendOwner(req: IncomingMessage): SendOwner {
    if (!sessionManager || !authStore) throw Object.assign(new Error('Session authentication required'), { statusCode: 401 });
    requirePermission(req, 'chat.use');
    const access = requireSteamAccountAccess(req, false);
    requireLevel(access, 'full');
    if (!access.session || !access.steamAccountId) throw steamAccountUnavailable();
    return { userId: access.session.user.id, sessionId: access.session.sessionId, account: access.steamAccountId };
  }

  function sendAuthorization(req: IncomingMessage, owner: SendOwner, peerId: string) {
    return () => {
      const live = sendOwner(req);
      requirePeer(requireSteamAccountAccess(req, false), peerId);
      if (live.account !== owner.account || live.sessionId !== owner.sessionId || live.userId !== owner.userId) {
        throw Object.assign(new Error('原账号或登录会话已改变。'), { statusCode: 409 });
      }
      return currentSteamStatus().status === 'online';
    };
  }

  async function operationImage(body: UnknownRecord): Promise<Buffer> {
    if ([body.img, body.url, body.emoteId].filter(value => value !== undefined).length !== 1) throw Object.assign(new Error('Provide exactly one image source'), { statusCode: 400 });
    let buffer: Buffer;
    if (body.emoteId !== undefined) buffer = (await imageEmotes.read(body.emoteId)).buffer;
    else if (typeof body.img === 'string') buffer = decodeBase64Image(body.img);
    else if (typeof body.url === 'string') buffer = (await loadOrDownloadRemoteImage(body.url, { fetchImpl })).buffer;
    else throw Object.assign(new Error('Invalid image source'), { statusCode: 400 });
    let size;
    try { size = require('image-size').imageSize(buffer); }
    catch { throw Object.assign(new Error('无法识别图片格式。'), { statusCode: 400 }); }
    if (!['png', 'jpg', 'gif', 'webp'].includes(size.type) || !size.width || !size.height || size.width * size.height > 40000000) {
      throw Object.assign(new Error('图片格式或尺寸不支持。'), { statusCode: 400 });
    }
    return buffer;
  }

  async function handleSendOperations(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith('/api/send-operations')) return false;
    const owner = sendOwner(req);
    const upload = url.pathname === '/api/send-operations/upload';
    if ((url.pathname === '/api/send-operations' || upload) && req.method === 'POST') {
      if (currentSteamStatus().status !== 'online') throw Object.assign(new Error('Steam 尚未在线，暂不能创建发送任务。'), { statusCode: 503 });
      const body = await readJsonBody(req);
      if (body.kind !== 'image' || typeof body.id !== 'string' || !/^\d{17}$/.test(body.id)) throw Object.assign(new Error('Invalid image recipient'), { statusCode: 400 });
      const authorize = sendAuthorization(req, owner, body.id);
      authorize();
      rejectGroupRecipient(body.id);
      validateAccountPrecondition(body.steamAccountId);
      if (body.steamAccountId !== undefined && body.steamAccountId !== owner.account) throw Object.assign(new Error('Steam account changed'), { statusCode: 409 });
      if (body.previousOperationId !== undefined && (typeof body.previousOperationId !== 'string' || !/^[a-f0-9]{32}$/.test(body.previousOperationId))) {
        throw Object.assign(new Error('Invalid previous operation'), { statusCode: 400 });
      }
      if (upload && (typeof body.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(body.operationId))) {
        throw Object.assign(new Error('Invalid operation ID'), { statusCode: 400 });
      }
      const operation = sendOperations.prepare(owner, body.id, typeof body.name === 'string' ? body.name : '图片', authorize,
        body.previousOperationId as string | undefined, upload ? body.operationId as string : undefined);
      if (upload) {
        // Reserve the ID before asynchronous image loading so concurrent requests
        // share one operation and a timed-out caller can query it immediately.
        const started = await sendOperations.loadAndStart(operation.id, owner, async () => {
          const buffer = await operationImage(body);
          authorize();
          return buffer;
        });
        jsonResponse(res, 202, started, { 'Cache-Control': 'no-store' });
      } else jsonResponse(res, 201, operation, { 'Cache-Control': 'no-store' });
      return true;
    }
    const match = /^\/api\/send-operations\/([a-f0-9]{32})(?:\/(start|retry|expedite|cancel|image))?$/.exec(url.pathname);
    if (!match) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    const [, id, action] = match;
    const operation = sendOperations.get(id, owner);
    const authorize = sendAuthorization(req, owner, operation.peerId);
    authorize();
    if (req.method === 'GET' && !action) jsonResponse(res, 200, operation, { 'Cache-Control': 'no-store' });
    else if (req.method === 'GET' && action === 'image') {
      const buffer = sendOperations.image(id, owner);
      const size = require('image-size').imageSize(buffer);
      textResponse(res, 200, buffer, { 'Content-Type': `image/${size.type === 'jpg' ? 'jpeg' : size.type}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    } else if (req.method === 'POST' && action === 'start') {
      const started = await sendOperations.loadAndStart(id, owner, async () => {
        const body = await readJsonBody(req);
        authorize();
        const buffer = await operationImage(body);
        authorize();
        return buffer;
      });
      jsonResponse(res, 202, started, { 'Cache-Control': 'no-store' });
    } else if (req.method === 'POST' && action) {
      sendOperations.get(id, owner);
      const body = await readJsonBody(req);
      authorize();
      if (action === 'cancel') jsonResponse(res, 200, sendOperations.cancel(id, owner), { 'Cache-Control': 'no-store' });
      else if (action === 'retry' || action === 'expedite') {
        if (!Number.isInteger(body.expectedVersion)) throw Object.assign(new Error('expectedVersion required'), { statusCode: 400 });
        jsonResponse(res, 202, action === 'retry' ? sendOperations.retry(id, owner, body.expectedVersion as number) : sendOperations.expedite(id, owner, body.expectedVersion as number), { 'Cache-Control': 'no-store' });
      } else throw Object.assign(new Error('Method not allowed'), { statusCode: 405 });
    } else throw Object.assign(new Error('Method not allowed'), { statusCode: 405 });
    return true;
  }

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
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
      if (await handleRolesApi(req, res, url)) return;
      if (await handleSteamApi(req, res, url)) return;
      if (await handleUsersApi(req, res, url)) return;
      if (await handleAuditApi(req, res, url)) return;
      if (await handleSendOperations(req, res, url)) return;

      if (url.pathname === '/api/bilibili/resolve') {
        if (!sessionManager) throw Object.assign(new Error('Session authentication required'), { statusCode: 401 });
        requirePermission(req, 'chat.use');
        if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
        const result = await resolveBilibiliLink(url.searchParams.get('url'), fetchImpl);
        requirePermission(req, 'chat.use');
        jsonResponse(res, 200, result, { 'Cache-Control': 'private, no-store' });
        return;
      }

      if (url.pathname === '/api/image-emotes' || url.pathname.startsWith('/api/image-emotes/file/')) {
        if (!sessionManager) throw Object.assign(new Error('Session authentication required'), { statusCode: 401 });
        if (req.method === 'GET') {
          requirePermission(req, 'chat.use');
          if (url.pathname === '/api/image-emotes') {
            jsonResponse(res, 200, await imageEmotes.list());
          } else {
            const image = await imageEmotes.read(url.pathname.slice('/api/image-emotes/file/'.length));
            textResponse(res, 200, image.buffer, { 'Content-Type': image.item.contentType,
              'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/image-emotes') {
          requirePermission(req, 'emote.manage');
          const body = await readJsonBody(req);
          requirePermission(req, 'emote.manage');
          const result = await imageEmotes.mutate(body);
          jsonResponse(res, 200, result);
          return;
        }
        jsonResponse(res, 405, { error: 'Method not allowed' });
        return;
      }

      requireLegacyOrSession(req);

      if (url.pathname === '/api/message-reactions') {
        const access = requireSteamAccountAccess(req, true);
        if (!steamUser || !access.steamAccountId) throw Object.assign(new Error('Steam is not online'), { statusCode: 503 });
        if (req.method === 'GET') {
          const authorize = httpSendAuthorization(req, access, url.searchParams.get('steamAccountId') || undefined, 'read', url.searchParams.get('id'));
          authorize();
          const result = await readMessageReactions(steamUser, access.steamAccountId, url.searchParams.get('id') || '', url.searchParams.get('before'));
          authorize();
          jsonResponse(res, 200, result, { 'Cache-Control': 'no-store' });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const authorize = httpSendAuthorization(req, access, body.steamAccountId, 'full', body.id);
          authorize();
          const result = await updateMessageReaction(steamUser, body);
          authorize();
          jsonResponse(res, 200, result, { 'Cache-Control': 'no-store' });
          return;
        }
        jsonResponse(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (req.method === 'GET') {
        if (url.pathname === '/api/messages/sync') {
          if (!sessionManager || !authStore) throw Object.assign(new Error('Session authentication required'), { statusCode: 401 });
          const access = requireSteamAccountAccess(req, false);
          const requestedAccount = url.searchParams.get('steamAccountId') ?? undefined;
          validateAccountPrecondition(requestedAccount);
          const steamAccountId = historyAccount(access, requestedAccount);
          const mode = url.searchParams.get('mode') ?? undefined;
          if (mode !== undefined && mode !== 'history') throw Object.assign(new Error('Invalid sync mode'), { statusCode: 400 });
          if (!historyStorage) throw Object.assign(new Error('History storage unavailable'), { statusCode: 503 });
          const page = await historyStorage.sync({ steamAccountId, mode,
            cursor: url.searchParams.has('cursor') ? url.searchParams.get('cursor')! : undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined });
          const current = requireSteamAccountAccess(req, false);
          historyAccount(current, steamAccountId);
          jsonResponse(res, 200, { ...page, items: filterPeers(current, page.items) }, { 'Cache-Control': 'no-store' });
          return;
        }
        if (url.pathname === '/api/config') {
          jsonResponse(res, 200, clientConfig(), { 'Cache-Control': 'no-store' });
          return;
        }
        if (url.pathname === '/api/emoticons') {
          const access = requireSteamAccountAccess(req, false);
          const account = inventoryAccount(access);
          const data = await readInventory(access);
          if (inventoryAccount(recheckReadAccess(req, access)) !== account) {
            throw Object.assign(new Error('Steam account changed during inventory request'), { statusCode: 409 });
          }
          jsonResponse(res, 200, data, { 'Cache-Control': 'no-store' });
          return;
        }
        if (url.pathname === '/api/friends') {
          const access = requireSteamAccountAccess(req, true);
          const friends = await listFriends(steamUser);
          jsonResponse(res, 200, filterPeers(recheckReadAccess(req, access, true), friends));
          return;
        }
        if (url.pathname === '/api/groups') {
          const access = requireSteamAccountAccess(req, true);
          const groups = access.grant?.scope === 'some' ? [] : await listGroups(steamUser);
          jsonResponse(res, 200, recheckReadAccess(req, access, true).grant?.scope === 'some' ? [] : groups);
          return;
        }
        if (url.pathname === '/api/history/status') {
          requirePermission(req, 'chat.use');
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
            ? await storageHistory(access, input)
            : await historyStorage.conversations({ steamAccountId: historyAccount(access, input.steamAccountId),
              limit: input.limit == null ? undefined : Number(input.limit), before: openConversationCursor(access, input.before) });
          const current = requireSteamAccountAccess(req, false);
          historyAccount(current, access.steamAccountId);
          if (url.pathname.endsWith('/history') && input.id) requirePeer(current, input.id);
          const filtered = { ...page, items: page.items.filter(item => peerAllowed(current, item.id)) };
          if (!url.pathname.endsWith('/history')) filtered.nextCursor = sealConversationCursor(current, page.nextCursor);
          jsonResponse(res, 200, url.pathname.startsWith('/api/') ? filtered : filtered.items);
          return;
        }
        if (url.pathname === '/history' || url.pathname === '/api/history') {
          const access = requireSteamAccountAccess(req, false);
          const id = url.searchParams.get('id');
          if (id) requirePeer(access, id);
          const items = await readHistory({
            logPath,
            id: url.searchParams.get('id'),
            limit: url.searchParams.get('limit'),
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            logger
          });
          const current = recheckReadAccess(req, access);
          if (id) requirePeer(current, id);
          jsonResponse(res, 200, filterPeers(current, items));
          return;
        }
        if (url.pathname === '/conversations' || url.pathname === '/api/conversations') {
          const access = requireSteamAccountAccess(req, false);
          const items = await buildConversations({
            logPath,
            limit: url.searchParams.get('limit'),
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            getUserInfo,
            logger
          });
          jsonResponse(res, 200, filterPeers(recheckReadAccess(req, access), items));
          return;
        }
        if (url.pathname.startsWith('/proxy/sticker/')) {
          const access = requireSteamAccountAccess(req, false);
          const type = decodeURIComponent(url.pathname.slice('/proxy/sticker/'.length));
          let sticker;
          try {
            sticker = await loadOrDownloadSticker(type, { fetchImpl });
          } catch (error) {
            if (!isRecord(error) || error.upstreamStatus !== 404) throw error;
            const canonical = await resolveStickerAlias(type, { fetchImpl });
            if (!canonical || canonical === type) throw error;
            sticker = await loadOrDownloadSticker(canonical, { fetchImpl });
          }
          recheckReadAccess(req, access);
          textResponse(res, 200, sticker.buffer, { 'Content-Type': sticker.contentType, 'Cache-Control': 'public, max-age=86400' });
          return;
        }
        if (url.pathname === '/proxy/image') {
          const access = requireSteamAccountAccess(req, false);
          const source = url.searchParams.get('url') || '';
          const image = await loadOrDownloadRemoteImage(source, { fetchImpl });
          recheckReadAccess(req, access);
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
        const authorize = httpSendAuthorization(req, access, body.steamAccountId, requiresFullLevel(body.msg) ? 'full' : 'chat', body.id);
        authorize();
        const item = await sendTextMessage(body.id, body.msg, access.steamAccountId, authorize);
        jsonResponse(res, 200, { ok: true, item });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/image' || url.pathname === '/img')) {
        const access = requireSteamAccountAccess(req, true);
        const body = await readJsonBody(req);
        const authorize = httpSendAuthorization(req, access, body.steamAccountId, 'full', body.id);
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
        if (responseAccount) {
          const access = wsAccessContext(ws, false);
          historyAccount(access, responseAccount);
          if (typeof payload.id === 'string') requirePeer(access, payload.id);
          if (Array.isArray(message.items)) message.items = filterPeers(access, message.items as HistoryItem[]);
          if (Array.isArray(message.conversations)) message.conversations = filterPeers(access, message.conversations as ConversationSummary[]);
          if (Array.isArray(message.friends)) message.friends = filterPeers(access, message.friends as FriendSummary[]);
          if (Array.isArray(message.groups) && access.grant?.scope === 'some') message.groups = [];
          if (message.type === 'conversations_page') message.nextCursor = sealConversationCursor(access, message.nextCursor);
        }
      }
      sendWs(ws, requestId ? { requestId, ...message } : message);
    };
    try {
      if (sessionManager && !liveWsSession(ws)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      if (type === 'ping') {
        reply({ type: 'pong' });
        return;
      }
      if (type === 'get_steam_status' || type === 'steam_status') {
        const session = liveWsSession(ws);
        reply({ type: 'steam_status', ...steamStatusForSession(session),
          permissions: session && authStore ? authStore.effectivePermissions(session.user) : [],
          permissionDetails: session && authStore ? authStore.permissionDetails(session.user.id) : [] });
        return;
      }
      if (sessionManager) responseAccount = wsAccessContext(ws, false).steamAccountId;
      if (type === 'send_message' || type === 'msg') {
        const access = wsAccessContext(ws, true);
        const text = payload.msg || payload.message || '';
        const level = requiresFullLevel(text) ? 'full' : 'chat';
        checkAccountPrecondition(access, payload.steamAccountId);
        requireLevel(access, level);
        requirePeer(access, payload.id);
        const item = await sendTextMessage(payload.id, text, access.steamAccountId, (required = level) => {
          const current = wsAccessContext(ws, true);
          requireLevel(current, required);
          requirePeer(current, payload.id);
          checkAccountPrecondition(current, payload.steamAccountId);
          if (sessionManager) historyAccount(current, access.steamAccountId);
        });
        reply({ type: 'message_sent', item });
        return;
      }
      if (type === 'send_image' || type === 'img') {
        const access = wsAccessContext(ws, true);
        requireLevel(access, 'full');
        requirePeer(access, payload.id);
        checkAccountPrecondition(access, payload.steamAccountId);
        const item = await sendImageMessage(payload.id, payload, access.steamAccountId,
          () => {
            const current = wsAccessContext(ws, true);
            requireLevel(current, 'full');
            requirePeer(current, payload.id);
            checkAccountPrecondition(current, payload.steamAccountId);
            if (sessionManager) historyAccount(current, access.steamAccountId);
          });
        reply({ type: 'image_sent', item });
        return;
      }
      if (historyStorage && ['get_history', 'history', 'get_history_page', 'get_conversations', 'conversations', 'get_conversations_page'].includes(String(type))) {
        const access = wsAccessContext(ws, false);
        const isHistory = String(type).includes('history');
        const page = isHistory
          ? await storageHistory(access, payload)
          : await historyStorage.conversations({ steamAccountId: historyAccount(access, payload.steamAccountId),
            limit: payload.limit == null ? undefined : Number(payload.limit),
            before: openConversationCursor(access, payload.before) });
        reply(String(type).endsWith('_page')
          ? { type: isHistory ? 'history_page' : 'conversations_page', ...page }
          : isHistory ? { type: 'history', items: page.items } : { type: 'conversations', conversations: page.items });
        return;
      }
      if (type === 'get_history' || type === 'history') {
        const access = wsAccessContext(ws, false);
        if (payload.id) requirePeer(access, payload.id);
        reply({
          type: 'history',
          items: filterPeers(access, await readHistory({
            logPath,
            id: payload.id,
            limit: payload.limit,
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            logger
          }))
        });
        return;
      }
      if (type === 'get_conversations' || type === 'conversations') {
        const access = wsAccessContext(ws, false);
        reply({
          type: 'conversations',
          conversations: filterPeers(access, await buildConversations({
            logPath,
            limit: payload.limit,
            steamAccountId: access.steamAccountId,
            includeLegacy: access.includeLegacy,
            getUserInfo,
            logger
          }))
        });
        return;
      }
      if (type === 'get_emoticons' || type === 'emoticons') {
        const access = wsAccessContext(ws, false);
        const account = inventoryAccount(access);
        const data = await readInventory(access);
        const current = wsAccessContext(ws, false);
        if (current.steamAccountId !== access.steamAccountId || inventoryAccount(current) !== account) {
          throw Object.assign(new Error('Steam account changed during inventory request'), { statusCode: 409 });
        }
        reply({ type: 'emoticons', ...data });
        return;
      }
      if (type === 'get_friends' || type === 'friends') {
        const access = wsAccessContext(ws, true);
        reply({ type: 'friends', friends: filterPeers(access, await listFriends(steamUser)) });
        return;
      }
      if (type === 'get_groups' || type === 'groups') {
        const access = wsAccessContext(ws, true);
        reply({ type: 'groups', groups: access.grant?.scope === 'some' ? [] : await listGroups(steamUser) });
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
    ws.on('pong', () => unansweredPings.delete(ws));
    ws.on('message', (raw: RawData) => {
      unansweredPings.delete(ws);
      if (!stopping) void track(handleWsMessage(ws, raw));
    });
    ws.on('close', () => {
      clients.delete(ws);
      wsRequests.delete(ws);
      unansweredPings.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
      wsRequests.delete(ws);
      unansweredPings.delete(ws);
    });
  });

  // Server pings keep proxy/NAT mappings alive while a sleeping phone cannot run its own ping timer,
  // and drop half-open sockets that missed a whole interval so they stop absorbing sync hints.
  const heartbeat = config.wsHeartbeatMs > 0 ? setInterval(() => {
    for (const ws of clients) {
      if (unansweredPings.has(ws)) {
        unansweredPings.delete(ws);
        ws.terminate();
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN) continue;
      unansweredPings.add(ws);
      ws.ping();
    }
  }, config.wsHeartbeatMs) : null;
  heartbeat?.unref?.();

  const disposeStorageMessages = historyStorage?.onMessage((item) => {
    for (const ws of clients) {
      if (!canWsReceive(ws, item)) continue;
      sendWs(ws, { type: 'message', ...item });
    }
  });

  const disposeDurableMessages = historyStorage?.onDurable((item) => {
    // Sync is session-only even when the service also supports legacy Web access.
    if (!sessionManager || !authStore) return;
    for (const ws of clients) {
      if (!canWsReceive(ws, item)) continue;
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
      if (heartbeat) clearInterval(heartbeat);
      await inventoryCache.close();
      await sendOperations.close();
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

async function defaultGetEmoticons({ steamUser, steamCommunity, waitForLogin, waitForWebSession, previousInventory, logger }: GetEmoticonsOptions): Promise<EmoticonPayload> {
  await resolveWaiter(waitForLogin);
  const result: EmoticonPayload = { emoticons: [], stickers: [], effects: [] };
  const failed = new Set<'emoticons' | 'stickers' | 'effects'>();
  // SDK/web inventory and reward catalog requests fail independently. Bound each
  // branch below the outer cache deadline so a working branch can still be saved.
  async function bounded<T>(work: () => Promise<T>, timeoutMs = 12_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Steam inventory source timed out')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function fail(categories: ('emoticons' | 'stickers' | 'effects')[], error: unknown) {
    for (const category of categories) failed.add(category);
    // Log only fixed local diagnoses. Upstream errors may contain cookies or bodies.
    const messages: Record<string, string> = {
      'Incomplete Steam emoticon inventory': 'INVALID_EMOTICONS',
      'Incomplete Steam community inventory': 'INCOMPLETE_DESCRIPTIONS',
      'Incomplete sticker catalog for owned inventory': 'UNRESOLVED_OWNED_ALIAS',
      'Unresolvable owned sticker inventory': 'INVALID_OWNED_ALIAS',
      'Sticker catalog timed out': 'CATALOG_TIMEOUT',
      'Steam inventory source timed out': 'SOURCE_TIMEOUT',
      'This profile is private.': 'WEB_SESSION_PRIVATE',
      'Incomplete sticker catalog': 'INCOMPLETE_CATALOG',
      'Incomplete sticker catalog: page limit reached': 'CATALOG_PAGE_LIMIT'
    };
    const code = error instanceof Error ? messages[error.message] ?? 'UPSTREAM_FAILURE' : 'UPSTREAM_FAILURE';
    logger?.warn?.(`Steam inventory ${categories.join('/')} refresh failed [${code}]; preserving cached materials`);
  }
  const emoticonTask = bounded(async () => {
    const source = steamUser?.getEmoticonList || steamUser?.chat?.getEmoticonList;
    const context = steamUser?.getEmoticonList ? steamUser : steamUser?.chat;
    const response = source ? await callMaybeCallback(source, context, []) : null;
    const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    if (source && (!isRecord(response) || (!Array.isArray(response.emoticons ?? response.emoticon_list)
      && !isRecord(response.emoticons ?? response.emoticon_list)))) throw new Error('Incomplete Steam emoticon inventory');
    return { emoticons: isRecord(response) ? entries(response.emoticons ?? response.emoticon_list) : [],
      stickers: isRecord(response) ? entries(response.stickers ?? response.sticker_list) : [] };
  }).then(data => { result.emoticons = data.emoticons; return data; }, (error): undefined => { fail(['emoticons'], error); return undefined; });
  const communityTask = bounded(async () => {
    const steamId = steamUser?.steamID || steamCommunity?.steamID;
    if (!steamCommunity?.getUserInventoryContents || !steamId) return undefined;
    await resolveWaiter(waitForWebSession);
    // The SDK joins descriptions and follows every ownership page.
    const inventory = await callMaybeCallback(steamCommunity.getUserInventoryContents, steamCommunity, [steamId, 753, 6, false]);
    if (!Array.isArray(inventory)) throw new Error('Incomplete Steam community inventory');
    return inventory;
  }, 8_000).then(async inventory => {
    if (!inventory) return;
    const { resolveStickerInventory } = await import('./sticker-inventory.js');
    await Promise.all((['stickers', 'effects'] as const).map(async category => {
      try {
        result[category] = await resolveStickerInventory(inventory, {
          itemClass: category === 'stickers' ? 11 : 12, previousInventory: previousInventory?.[category]
        });
      } catch (error) { fail([category], error); }
    }));
  }, error => { fail(['stickers', 'effects'], error); });
  const [emoticonData] = await Promise.all([emoticonTask, communityTask]);
  if (!steamCommunity?.getUserInventoryContents && emoticonData) result.stickers = emoticonData.stickers;
  if (failed.size) result.failedCategories = [...failed];
  return result;
}

// Steam reports names only for non-Steam games; Steam apps are resolved from PICS app info.
// Names practically never change, so hits are kept for the process lifetime and misses retried later.
const APP_NAME_WAIT_MS = 3000;
const APP_NAME_RETRY_MS = 10 * 60 * 1000;
const appNames = new Map<number, string>();
const appNameRetryAt = new Map<number, number>();
const appNameLookups = new Map<number, Promise<void>>();

function appNameFromInfo(appinfo: unknown): string {
  const common = isRecord(appinfo) && isRecord(appinfo.common) ? appinfo.common : null;
  if (!common) return '';
  const localized = isRecord(common.name_localized) ? common.name_localized : {};
  const name = [localized.schinese, localized.tchinese, common.name].find((value) => typeof value === 'string' && value.trim());
  return typeof name === 'string' ? name.trim() : '';
}

async function resolveAppNames(steamUser: SteamUserLike, appIds: number[]): Promise<void> {
  const wanted = [...new Set(appIds)];
  const now = Date.now();
  const missing = wanted.filter((id) => !appNames.has(id) && !appNameLookups.has(id) && (appNameRetryAt.get(id) || 0) <= now);
  if (missing.length && typeof steamUser.getProductInfo === 'function') {
    const lookup = callMaybeCallback(steamUser.getProductInfo, steamUser, [missing, [], false]).then((result) => {
      const apps = isRecord(result) && isRecord(result.apps) ? result.apps : {};
      for (const id of missing) {
        const entry = apps[String(id)];
        const name = appNameFromInfo(isRecord(entry) ? entry.appinfo : null);
        if (name) {
          appNames.set(id, name);
          appNameRetryAt.delete(id);
        } else {
          appNameRetryAt.set(id, Date.now() + APP_NAME_RETRY_MS);
        }
      }
    }, () => {
      for (const id of missing) appNameRetryAt.set(id, Date.now() + APP_NAME_RETRY_MS);
    }).finally(() => {
      for (const id of missing) appNameLookups.delete(id);
    });
    for (const id of missing) appNameLookups.set(id, lookup);
  }
  const pending = [...new Set(wanted.map((id) => appNameLookups.get(id)).filter((lookup): lookup is Promise<void> => Boolean(lookup)))];
  if (!pending.length) return;
  // A slow lookup must not hold up the friend list; late names still fill the cache for the next request.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, APP_NAME_WAIT_MS); })
  ]);
  clearTimeout(timer);
}

async function listFriends(steamUser?: SteamUserLike): Promise<FriendSummary[]> {
  if (!steamUser) return [];
  const friends = isRecord(steamUser.myFriends) ? steamUser.myFriends : {};
  const ids = Object.keys(friends);
  const users = steamUser.users || {};
  const nicknames = isRecord(steamUser.myNicknames) ? steamUser.myNicknames : {};
  const summaries = ids.map((id): FriendSummary => {
    const persona = users[id] || {};
    const state = persona.persona_state ?? persona.personaState ?? friends[id];
    const appId = Number(persona.game_played_app_id);
    return {
      id,
      name: persona.player_name || persona.personaName || persona.name || id,
      avatar: persona.avatar_url_full || persona.avatar_url_medium || persona.avatar_url_icon || persona.avatar || '',
      personaState: state,
      online: Number(state || 0) > 0,
      gameName: persona.game_name || persona.gameName || '',
      nickname: typeof nicknames[id] === 'string' ? nicknames[id] as string : '',
      gameAppId: Number.isSafeInteger(appId) && appId > 0 ? appId : 0,
      richPresence: typeof persona.rich_presence_string === 'string' ? persona.rich_presence_string : '',
      lastOnline: personaDate(persona.last_seen_online) || personaDate(persona.last_logoff)
    };
  });
  const unnamed = summaries.filter((friend) => friend.gameAppId && !friend.gameName);
  if (unnamed.length) {
    await resolveAppNames(steamUser, unnamed.map((friend) => friend.gameAppId));
    for (const friend of unnamed) friend.gameName = appNames.get(friend.gameAppId) || '';
  }
  return summaries.sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
}

function groupFromUnknown(group: unknown, fallbackId = ''): GroupSummary {
  if (!isRecord(group)) {
    const id = fallbackId || steamIdToString(group);
    return { id, clanId: '', name: id };
  }
  const id = steamIdToString(group.steamID || group.id || fallbackId || group);
  const clanId = typeof group.clanid === 'string'
    ? group.clanid
    : typeof group.clanID === 'string'
      ? group.clanID
      : '';
  const name = isRecord(group.name_info) && typeof group.name_info.clan_name === 'string'
    ? group.name_info.clan_name
    : typeof group.name === 'string'
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
  const metadata = isRecord(steamUser.groups) ? steamUser.groups : {};
  return Object.entries(groups).filter(([, group]) => typeof group !== 'number' || group === 3)
    .map(([id, group]) => groupFromUnknown(isRecord(metadata[id]) ? metadata[id] : group, id));
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
