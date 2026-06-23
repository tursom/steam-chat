'use strict';

import type { IncomingMessage } from 'node:http';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAuthChecker,
  getClientIp,
  parseForwardedFor,
  timingSafeTextEqual
} = require('../src/server/auth');
const {
  isLocalOrLanIp,
  normalizeIp
} = require('../src/server/network');

function requestWith(headers: Record<string, string | string[] | undefined>, remoteAddress = ''): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress }
  } as IncomingMessage;
}

test('normalizeIp strips wrappers and ports without breaking IPv6 literals', () => {
  assert.equal(normalizeIp(' 8.8.8.8:443 '), '8.8.8.8');
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeIp('::ffff:192.168.1.20'), '192.168.1.20');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
});

test('isLocalOrLanIp identifies local, private, link-local, and public addresses', () => {
  assert.equal(isLocalOrLanIp(''), true);
  assert.equal(isLocalOrLanIp('localhost'), true);
  assert.equal(isLocalOrLanIp('10.1.2.3'), true);
  assert.equal(isLocalOrLanIp('172.16.0.1'), true);
  assert.equal(isLocalOrLanIp('172.31.255.255'), true);
  assert.equal(isLocalOrLanIp('172.32.0.1'), false);
  assert.equal(isLocalOrLanIp('192.168.1.1'), true);
  assert.equal(isLocalOrLanIp('169.254.1.2'), true);
  assert.equal(isLocalOrLanIp('fd00::1'), true);
  assert.equal(isLocalOrLanIp('fe80::1'), true);
  assert.equal(isLocalOrLanIp('8.8.8.8'), false);
});

test('getClientIp trusts Forwarded, X-Forwarded-For, and X-Real-IP only when configured', () => {
  assert.equal(parseForwardedFor('for="203.0.113.10:8443";proto=https'), '203.0.113.10:8443');
  assert.equal(getClientIp(requestWith({
    forwarded: 'for="203.0.113.10:8443";proto=https',
    'x-forwarded-for': '198.51.100.1',
    'x-real-ip': '198.51.100.2'
  }, '127.0.0.1'), { trustProxy: true }), '203.0.113.10');
  assert.equal(getClientIp(requestWith({
    'x-forwarded-for': '198.51.100.1, 198.51.100.2'
  }, '127.0.0.1'), { trustProxy: true }), '198.51.100.1');
  assert.equal(getClientIp(requestWith({
    'x-real-ip': '198.51.100.2'
  }, '127.0.0.1'), { trustProxy: true }), '198.51.100.2');
  assert.equal(getClientIp(requestWith({
    'x-forwarded-for': '198.51.100.1'
  }, '127.0.0.1'), { trustProxy: false }), '127.0.0.1');
});

test('auth checker sanitizes challenges and uses constant-shape credential comparison', () => {
  const auth = createAuthChecker({
    username: 'user',
    password: 'pass',
    realm: 'Steam "Chat"',
    trustProxy: true
  });

  assert.equal(timingSafeTextEqual('same', 'same'), true);
  assert.equal(timingSafeTextEqual('same', 'different length'), false);
  assert.equal(auth.isAuthorized(requestWith({
    'x-forwarded-for': '8.8.8.8',
    authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`
  }, '127.0.0.1')), true);
  assert.equal(auth.isAuthorized(requestWith({
    'x-forwarded-for': '8.8.8.8',
    authorization: `Basic ${Buffer.from('user:wrong').toString('base64')}`
  }, '127.0.0.1')), false);

  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body = '';
  auth.challenge({
    writeHead(code: number, nextHeaders: Record<string, string>) {
      statusCode = code;
      headers = nextHeaders;
    },
    end(nextBody: string) {
      body = nextBody;
    }
  });

  assert.equal(statusCode, 401);
  assert.equal(headers['WWW-Authenticate'], 'Basic realm="Steam Chat", charset="UTF-8"');
  assert.deepEqual(JSON.parse(body), { error: 'Unauthorized' });
});
