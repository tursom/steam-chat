'use strict';

import type { IncomingMessage } from 'node:http';
import type { PublicUser, PublicUserSession } from './store';
import { isRecord } from '../types';

const crypto = require('node:crypto');

type AuthStoreLike = {
  createSession: (userId: unknown, input: { expiresAt: string; ip?: string | null; userAgent?: string | null }) => PublicUserSession;
  getOrCreateSessionSecret: () => string;
  getUserById: (id: unknown) => (PublicUser & { passwordHash?: string }) | null;
  revokeSession: (sessionId: unknown, revokedBy?: unknown) => boolean;
  revokeUserSessions: (userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown) => number;
  touchSession: (sessionId: unknown, userId: unknown, context?: { ip?: string | null; userAgent?: string | null }) => PublicUserSession | null;
};

type SessionPayload = {
  sid: string;
  uid: number;
  role: 'admin' | 'user';
  sv: number;
  iat: number;
  exp: number;
};

export type AppSession = {
  payload: SessionPayload;
  sessionId: string;
  user: PublicUser;
};

type SessionManagerOptions = {
  store: AuthStoreLike;
  cookieName?: string;
  maxAgeMs?: number;
  getClientIp?: (req: IncomingMessage) => string;
};

const DEFAULT_COOKIE_NAME = 'steam_chat_session';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeTextEqual(left: unknown, right: unknown): boolean {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(header: unknown): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function secureCookieFor(req?: IncomingMessage): boolean {
  if (!req) return false;
  const socket = req.socket as IncomingMessage['socket'] & { encrypted?: boolean };
  if (socket?.encrypted) return true;
  const forwardedProto = req.headers['x-forwarded-proto'];
  return String(Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || '').split(',')[0].trim() === 'https';
}

function serializeCookie(name: string, value: string, options: {
  maxAge?: number;
  expires?: Date;
  secure?: boolean;
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function userToPublic(user: PublicUser & { passwordHash?: string }): PublicUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function requestContext(req?: IncomingMessage, getClientIp?: (req: IncomingMessage) => string) {
  if (!req) return {};
  return {
    ip: getClientIp ? getClientIp(req) : req.socket?.remoteAddress || null,
    userAgent: headerText(req.headers['user-agent']) || null
  };
}

function createSessionManager(options: SessionManagerOptions) {
  const store = options.store;
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
  const secret = store.getOrCreateSessionSecret();
  const getRequestClientIp = options.getClientIp;

  function encode(payload: SessionPayload): string {
    const encoded = base64urlJson(payload);
    return `${encoded}.${sign(encoded, secret)}`;
  }

  function decode(raw: unknown): SessionPayload | null {
    const text = String(raw || '');
    const index = text.lastIndexOf('.');
    if (index <= 0) return null;
    const encoded = text.slice(0, index);
    const signature = text.slice(index + 1);
    if (!timingSafeTextEqual(signature, sign(encoded, secret))) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (!isRecord(parsed)) return null;
      const payload: SessionPayload = {
        sid: typeof parsed.sid === 'string' ? parsed.sid : '',
        uid: Number(parsed.uid || 0),
        role: parsed.role === 'admin' ? 'admin' : 'user',
        sv: Number(parsed.sv || 0),
        iat: Number(parsed.iat || 0),
        exp: Number(parsed.exp || 0)
      };
      if (!payload.sid || !payload.uid || !payload.sv || !payload.iat || !payload.exp) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  function getSession(req: IncomingMessage): AppSession | null {
    const raw = parseCookieHeader(req.headers.cookie)[cookieName];
    const payload = decode(raw);
    if (!payload || payload.exp <= Date.now()) return null;
    const user = store.getUserById(payload.uid);
    if (!user || user.disabled || user.sessionVersion !== payload.sv || user.role !== payload.role) return null;
    const session = store.touchSession(payload.sid, user.id, requestContext(req, getRequestClientIp));
    if (!session) return null;
    return { payload, sessionId: session.id, user: userToPublic(user) };
  }

  function createSetCookie(user: PublicUser, req?: IncomingMessage) {
    const iat = Date.now();
    const exp = iat + maxAgeMs;
    const session = store.createSession(user.id, {
      ...requestContext(req, getRequestClientIp),
      expiresAt: new Date(exp).toISOString()
    });
    const payload: SessionPayload = {
      sid: session.id,
      uid: user.id,
      role: user.role,
      sv: user.sessionVersion,
      iat,
      exp
    };
    return serializeCookie(cookieName, encode(payload), {
      maxAge: maxAgeMs / 1000,
      expires: new Date(payload.exp),
      secure: secureCookieFor(req)
    });
  }

  function revokeCurrentSession(req: IncomingMessage, revokedBy?: unknown): boolean {
    const raw = parseCookieHeader(req.headers.cookie)[cookieName];
    const payload = decode(raw);
    return payload ? store.revokeSession(payload.sid, revokedBy ?? payload.uid) : false;
  }

  function revokeUserSessions(userId: unknown, revokedBy?: unknown, exceptSessionId?: unknown): number {
    return store.revokeUserSessions(userId, revokedBy, exceptSessionId);
  }

  function createClearCookie(req?: IncomingMessage) {
    return serializeCookie(cookieName, '', {
      maxAge: 0,
      expires: new Date(0),
      secure: secureCookieFor(req)
    });
  }

  function requireSession(req: IncomingMessage): AppSession {
    const session = getSession(req);
    if (!session) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    return session;
  }

  function requireAdmin(req: IncomingMessage): AppSession {
    const session = requireSession(req);
    if (session.user.role !== 'admin') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return session;
  }

  return {
    cookieName,
    createClearCookie,
    createSetCookie,
    decode,
    encode,
    getSession,
    maxAgeMs,
    requireAdmin,
    requireSession,
    revokeCurrentSession,
    revokeUserSessions
  };
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  DEFAULT_MAX_AGE_MS,
  createSessionManager,
  parseCookieHeader,
  secureCookieFor,
  serializeCookie,
  timingSafeTextEqual
};
