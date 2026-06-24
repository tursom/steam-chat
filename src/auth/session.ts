'use strict';

import type { IncomingMessage } from 'node:http';
import type { PublicUser } from './store';
import { isRecord } from '../types';

const crypto = require('node:crypto');

type AuthStoreLike = {
  getOrCreateSessionSecret: () => string;
  getUserById: (id: unknown) => (PublicUser & { passwordHash?: string }) | null;
};

type SessionPayload = {
  uid: number;
  role: 'admin' | 'user';
  sv: number;
  iat: number;
  exp: number;
};

export type AppSession = {
  payload: SessionPayload;
  user: PublicUser;
};

type SessionManagerOptions = {
  store: AuthStoreLike;
  cookieName?: string;
  maxAgeMs?: number;
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

function createSessionManager(options: SessionManagerOptions) {
  const store = options.store;
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
  const secret = store.getOrCreateSessionSecret();

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
        uid: Number(parsed.uid || 0),
        role: parsed.role === 'admin' ? 'admin' : 'user',
        sv: Number(parsed.sv || 0),
        iat: Number(parsed.iat || 0),
        exp: Number(parsed.exp || 0)
      };
      if (!payload.uid || !payload.sv || !payload.iat || !payload.exp) return null;
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
    return { payload, user: userToPublic(user) };
  }

  function createSetCookie(user: PublicUser, req?: IncomingMessage) {
    const iat = Date.now();
    const payload: SessionPayload = {
      uid: user.id,
      role: user.role,
      sv: user.sessionVersion,
      iat,
      exp: iat + maxAgeMs
    };
    return serializeCookie(cookieName, encode(payload), {
      maxAge: maxAgeMs / 1000,
      expires: new Date(payload.exp),
      secure: secureCookieFor(req)
    });
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
    requireSession
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
