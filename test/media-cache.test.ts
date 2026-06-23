'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_REMOTE_IMAGE_BYTES,
  cacheKeyForUrl,
  fetchBuffer,
  loadOrDownloadRemoteImage,
  loadOrDownloadSticker,
  stickerUrlForType
} = require('../src/storage/media-cache');

function exactArrayBuffer(bytes: number[]): ArrayBuffer {
  const data = Uint8Array.from(bytes);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function responseWith(bytes: number[], contentType = 'image/png'): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? contentType : '';
      }
    },
    async arrayBuffer() {
      return exactArrayBuffer(bytes);
    }
  } as Response;
}

test('loadOrDownloadRemoteImage shares in-flight downloads and reads later cache hits', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-image-cache-'));
  const url = 'https://example.com/unit-image';
  const key = cacheKeyForUrl(url);
  let calls = 0;
  let userAgent = '';
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    userAgent = String((init?.headers as Record<string, string>)?.['User-Agent'] || '');
    await gate;
    return responseWith([1, 2, 3], 'image/jpeg');
  }) as typeof fetch;

  const first = loadOrDownloadRemoteImage(url, { cacheDir, fetchImpl });
  const second = loadOrDownloadRemoteImage(url, { cacheDir, fetchImpl });
  release();

  const [firstImage, secondImage] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(userAgent, 'steam-chat/1.0');
  assert.equal(firstImage.fromCache, false);
  assert.equal(secondImage.fromCache, false);
  assert.deepEqual([...firstImage.buffer], [1, 2, 3]);
  assert.equal(firstImage.contentType, 'image/jpeg');

  const cached = await loadOrDownloadRemoteImage(url, {
    cacheDir,
    fetchImpl: (async () => {
      throw new Error('cache hit should not fetch');
    }) as typeof fetch
  });
  assert.equal(cached.fromCache, true);
  assert.deepEqual([...cached.buffer], [1, 2, 3]);
  assert.equal(cached.contentType, 'image/jpeg');
  assert.equal(await fs.readFile(path.join(cacheDir, `${key}.json`), 'utf8').then((raw: string) => JSON.parse(raw).url), url);
});

test('fetchBuffer rejects failed responses and oversized images with status metadata', async () => {
  await assert.rejects(
    fetchBuffer('https://example.com/missing.png', {
      fetchImpl: (async () => ({
        ok: false,
        status: 404,
        headers: { get() { return ''; } },
        async arrayBuffer() { return exactArrayBuffer([]); }
      } as unknown as Response)) as typeof fetch
    }),
    /Remote request failed with HTTP 404/
  );

  await assert.rejects(
    fetchBuffer('https://example.com/large.png', {
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: { get() { return 'image/png'; } },
        async arrayBuffer() { return new ArrayBuffer(MAX_REMOTE_IMAGE_BYTES + 1); }
      } as unknown as Response)) as typeof fetch
    }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /too large/);
      return true;
    }
  );
});

test('loadOrDownloadSticker encodes remote URL and stores a reusable cache file', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-sticker-cache-'));
  const type = 'fun sticker/one';
  let requestedUrl = '';
  let calls = 0;
  const fetchImpl = (async (url: RequestInfo | URL) => {
    calls += 1;
    requestedUrl = String(url);
    return responseWith([9, 8, 7], 'image/webp');
  }) as typeof fetch;

  const first = await loadOrDownloadSticker(type, { cacheDir, fetchImpl });
  const second = await loadOrDownloadSticker(type, {
    cacheDir,
    fetchImpl: (async () => {
      throw new Error('sticker cache hit should not fetch');
    }) as typeof fetch
  });

  assert.equal(requestedUrl, stickerUrlForType(type));
  assert.equal(calls, 1);
  assert.equal(first.fromCache, false);
  assert.equal(first.contentType, 'image/webp');
  assert.equal(second.fromCache, true);
  assert.equal(second.contentType, 'image/png');
  assert.deepEqual([...second.buffer], [9, 8, 7]);
});
