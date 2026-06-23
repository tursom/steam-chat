'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { IMAGE_CACHE_DIR, STICKER_CACHE_DIR } = require('../paths');
const { isLocalOrLanIp } = require('../server/network');
import { isRecord } from '../types';

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const imageDownloads = new Map<string, Promise<CachedImage>>();
const stickerDownloads = new Map<string, Promise<CachedImage>>();

type CacheOptions = {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
};

type CachedImage = {
  buffer: Buffer;
  contentType: string;
  fromCache?: boolean;
};

function isAllowedRemoteImageUrl(value: unknown): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ''));
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isLocalOrLanIp(host)) return false;
  return true;
}

function inferImageContentType(url: unknown, fallback = ''): string {
  const pathname = (() => {
    try {
      return new URL(String(url || '')).pathname.toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (fallback && /^image\//i.test(fallback)) return fallback;
  return 'image/png';
}

function cacheKeyForUrl(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex');
}

async function fetchBuffer(url: string, options: CacheOptions = {}): Promise<CachedImage> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is not available in this Node runtime');
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'steam-chat/1.0'
    }
  });
  if (!response.ok) {
    throw new Error(`Remote request failed with HTTP ${response.status}`);
  }
  const type = response.headers?.get?.('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
    throw Object.assign(new Error('Remote image is too large'), { statusCode: 413 });
  }
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: inferImageContentType(url, type)
  };
}

async function loadOrDownloadRemoteImage(url: string, options: CacheOptions = {}): Promise<CachedImage> {
  if (!isAllowedRemoteImageUrl(url)) {
    throw Object.assign(new Error('Remote image URL is not allowed'), { statusCode: 400 });
  }
  const cacheDir = options.cacheDir || IMAGE_CACHE_DIR;
  const key = cacheKeyForUrl(url);
  const binPath = path.join(cacheDir, `${key}.bin`);
  const metaPath = path.join(cacheDir, `${key}.json`);

  try {
    const [buffer, metaRaw] = await Promise.all([
      fs.readFile(binPath),
      fs.readFile(metaPath, 'utf8')
    ]);
    const meta: unknown = JSON.parse(metaRaw);
    const contentType = isRecord(meta) && typeof meta.contentType === 'string'
      ? meta.contentType
      : inferImageContentType(url);
    return { buffer, contentType, fromCache: true };
  } catch (_) {
    // Cache misses fall through to a single shared download promise.
  }

  if (!imageDownloads.has(url)) {
    imageDownloads.set(url, (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      const downloaded = await fetchBuffer(url, options);
      await Promise.all([
        fs.writeFile(binPath, downloaded.buffer),
        fs.writeFile(metaPath, JSON.stringify({
          url,
          contentType: downloaded.contentType,
          cachedAt: new Date().toISOString()
        }, null, 2))
      ]);
      return { ...downloaded, fromCache: false };
    })().finally(() => imageDownloads.delete(url)));
  }
  const pending = imageDownloads.get(url);
  if (!pending) throw new Error('Remote image download was not queued');
  return pending;
}

function stickerUrlForType(type: string): string {
  return `https://steamcommunity-a.akamaihd.net/economy/sticker/${encodeURIComponent(type)}`;
}

function safeCacheName(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

async function loadOrDownloadSticker(type: string, options: CacheOptions = {}): Promise<CachedImage> {
  if (!type) throw Object.assign(new Error('Sticker type is required'), { statusCode: 400 });
  const cacheDir = options.cacheDir || STICKER_CACHE_DIR;
  const cachePath = path.join(cacheDir, `${safeCacheName(type)}.bin`);
  try {
    return { buffer: await fs.readFile(cachePath), contentType: 'image/png', fromCache: true };
  } catch (_) {
    // Cache miss.
  }
  if (!stickerDownloads.has(type)) {
    stickerDownloads.set(type, (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      const downloaded = await fetchBuffer(stickerUrlForType(type), options);
      await fs.writeFile(cachePath, downloaded.buffer);
      return { buffer: downloaded.buffer, contentType: downloaded.contentType, fromCache: false };
    })().finally(() => stickerDownloads.delete(type)));
  }
  const pending = stickerDownloads.get(type);
  if (!pending) throw new Error('Sticker download was not queued');
  return pending;
}

module.exports = {
  IMAGE_CACHE_DIR,
  MAX_REMOTE_IMAGE_BYTES,
  STICKER_CACHE_DIR,
  cacheKeyForUrl,
  fetchBuffer,
  inferImageContentType,
  isAllowedRemoteImageUrl,
  loadOrDownloadRemoteImage,
  loadOrDownloadSticker,
  stickerUrlForType
};
