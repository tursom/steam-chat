'use strict';

const net = require('node:net');

function normalizeIp(raw: unknown): string {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const portIndex = ip.lastIndexOf(':');
  if (portIndex > -1 && ip.indexOf(':') === portIndex) ip = ip.slice(0, portIndex);
  return ip;
}

function isLocalOrLanIp(raw: unknown): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (ip === 'localhost' || ip === '::1') return true;
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  if (net.isIP(ip) !== 4) return false;
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

module.exports = {
  isLocalOrLanIp,
  normalizeIp
};
