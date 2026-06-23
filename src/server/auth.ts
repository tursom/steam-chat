'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AuthConfig } from '../types';

const crypto = require('node:crypto');
const { isLocalOrLanIp, normalizeIp } = require('./network');

type AuthChecker = {
  enabled: boolean;
  realm: string;
  isAuthorized: (req: IncomingMessage) => boolean;
  challenge: (res: ServerResponse) => void;
  challengeUpgrade: (socket: Socket) => void;
};

function parseForwardedFor(headerValue: unknown): string {
  const match = String(headerValue || '').match(/(?:^|;)\s*for="?([^";,]+)"?/i);
  return match ? match[1] : '';
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function getClientIp(req: IncomingMessage, authConfig: AuthConfig): string {
  if (authConfig.trustProxy) {
    const forwarded = parseForwardedFor(req.headers.forwarded);
    if (forwarded) return normalizeIp(forwarded);
    const xff = headerText(req.headers['x-forwarded-for']).split(',')[0].trim();
    if (xff) return normalizeIp(xff);
    const realIp = headerText(req.headers['x-real-ip']);
    if (realIp) return normalizeIp(realIp);
  }
  return normalizeIp(req.socket?.remoteAddress || '');
}

function timingSafeTextEqual(left: unknown, right: unknown): boolean {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createAuthChecker(authConfig: AuthConfig = {}, defaults: Pick<AuthConfig, 'realm'> = {}): AuthChecker {
  const enabled = Boolean(authConfig.username && authConfig.password);
  const realm = authConfig.realm || defaults.realm || 'Steam Chat';
  return {
    enabled,
    realm,
    isAuthorized(req: IncomingMessage) {
      if (!enabled) return true;
      if (isLocalOrLanIp(getClientIp(req, authConfig))) return true;
      const header = headerText(req.headers.authorization);
      if (!header.startsWith('Basic ')) return false;
      let username = '';
      let password = '';
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const splitAt = decoded.indexOf(':');
        username = splitAt === -1 ? decoded : decoded.slice(0, splitAt);
        password = splitAt === -1 ? '' : decoded.slice(splitAt + 1);
      } catch (_) {
        return false;
      }
      return timingSafeTextEqual(username, authConfig.username) && timingSafeTextEqual(password, authConfig.password);
    },
    challenge(res: ServerResponse) {
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': `Basic realm="${realm.replace(/"/g, '')}", charset="UTF-8"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    },
    challengeUpgrade(socket: Socket) {
      socket.write([
        'HTTP/1.1 401 Unauthorized',
        `WWW-Authenticate: Basic realm="${realm.replace(/"/g, '')}", charset="UTF-8"`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));
      socket.destroy();
    }
  };
}

module.exports = {
  createAuthChecker,
  getClientIp,
  parseForwardedFor,
  timingSafeTextEqual
};
