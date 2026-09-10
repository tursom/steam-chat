import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SteamImageAliases } from '../src/storage/history-steam-alias';
import { normalizeStoredMessage } from '../src/storage/history-message';

const key = 'a'.repeat(64);
const input = { steamAccountId: '76561198000000001', id: '76561198000000002', echo: true,
  type: 'image', message: 'https://media.example.test/image', sentAt: '2026-09-10T08:26:37.283Z' };

test('image alias sidecar survives reopen, retries immutable writes and rejects conflicts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-image-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aliases = new SteamImageAliases(path.join(root, 'aliases'));
  assert.equal(await aliases.get(key), undefined);
  const item = normalizeStoredMessage(input);
  await aliases.put(key, item);
  const reopened = new SteamImageAliases(path.join(root, 'aliases'));
  await reopened.put(key, item);
  assert.deepEqual(await reopened.get(key), item);
  await assert.rejects(reopened.put(key, normalizeStoredMessage(input)), /alias conflict/);
  assert.deepEqual(await reopened.get(key), item);
  assert.deepEqual(await fs.readdir(path.join(root, 'aliases', 'aa')), [`${key}.json`]);
});

test('image alias sidecar treats malformed records as errors, never as absent aliases', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-image-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aliases = new SteamImageAliases(root);
  const filename = path.join(root, 'aa', `${key}.json`);
  await aliases.put(key, normalizeStoredMessage(input));
  await fs.writeFile(filename, JSON.stringify({ version: 1, item: input }));
  await assert.rejects(aliases.get(key), /Invalid Steam image alias record/);
  await fs.writeFile(filename, JSON.stringify({ version: 2, item: input }));
  await assert.rejects(aliases.get(key), /Unsupported Steam image alias version/);
  await assert.rejects(aliases.get('../invalid'), /Invalid Steam image alias/);
});
