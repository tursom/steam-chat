import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

// Captured from Steam's public rewards directory, definition 103182.
const definition = { appid: 637310, defid: 103182, community_item_class: 11, community_item_type: 37,
  internal_description: 'Cat talking',
  community_item_data: { item_name: 'Cat Cam talking', item_title: 'Cat Cam talking' } };
const rumi = { appid: 400910, defid: 264296, community_item_class: 11, community_item_type: 50,
  internal_description: ':rbrb_rumi_sigh:',
  community_item_data: { item_name: 'Rumi : Why...?', item_title: 'Rumi : Why...?' } };

test('legacy sticker proxy names resolve through official metadata and real misses remain 404', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-sticker-proxy-'));
  const previousDataDir = process.env.STEAM_CHAT_DATA_DIR;
  process.env.STEAM_CHAT_DATA_DIR = directory;
  const { createChatService } = require('../src/server/chat-service');
  const requested: string[] = [];
  const service = createChatService({
    config: { host: '127.0.0.1', port: 0 }, logPath: join(directory, 'chat.jsonl'),
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      requested.push(url.href);
      if (url.hostname === 'api.steampowered.com') {
        return Response.json({ response: { definitions: [definition, rumi], count: 2, total_count: 2 } });
      }
      if (['/sticker/Cat Cam talking', '/sticker/Cat talking', '/sticker/:rbrb_rumi_sigh:']
        .some(path => decodeURIComponent(url.pathname).endsWith(path))) {
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    }
  });
  t.after(async () => {
    await service.stop();
    if (previousDataDir === undefined) delete process.env.STEAM_CHAT_DATA_DIR;
    else process.env.STEAM_CHAT_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const repaired = await fetch(`${base}/proxy/sticker/${encodeURIComponent('Cat Cam talking (Sticker)-37')}`);
  assert.equal(repaired.status, 200);
  assert.equal(repaired.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await repaired.arrayBuffer())], [137, 80, 78, 71]);
  assert.ok(requested.some(url => url.includes('/sticker/Cat%20talking')));
  const plain = await fetch(`${base}/proxy/sticker/${encodeURIComponent('Rumi : Why...?')}`);
  assert.equal(plain.status, 200);
  assert.ok(requested.some(url => decodeURIComponent(new URL(url).pathname).endsWith('/sticker/:rbrb_rumi_sigh:')));
  const stripped = await fetch(`${base}/proxy/sticker/rbrb_rumi_sigh`);
  assert.equal(stripped.status, 404);
  const missing = await fetch(`${base}/proxy/sticker/${encodeURIComponent('Missing (Sticker)-999')}`);
  assert.equal(missing.status, 404);
});
