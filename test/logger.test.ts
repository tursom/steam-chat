'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  appendLog,
  buildConversations,
  previewForMessage,
  readHistory
} = require('../src/storage/chat-log');

function keysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

test('readHistory normalizes, filters, limits, sorts, and skips invalid JSONL lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await fs.writeFile(logPath, [
    '{"id":"2","name":"B","message":"later","date":"2026-06-23 10:12:00.000","ordinal":3}',
    'not json',
    '{"id":"1","name":"A","message":"second","date":"2026-06-23 10:10:00.000","ordinal":2}',
    '{"id":"1","name":"A","message":"first","date":"2026-06-23 10:10:00.000","ordinal":1}'
  ].join('\n'));

  const history = await readHistory({
    logPath,
    id: '1',
    limit: 10,
    logger: { warn() {} }
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].type, 'message');
  assert.equal(history[0].message, 'first');
  assert.equal(history[0].ordinal, 1);
  assert.equal(history[1].message, 'second');
  assert.equal(history[1].ordinal, 2);
});

test('readHistory folds legacy imageUrl into image message content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await fs.writeFile(logPath, '{"id":"1","name":"A","imageUrl":"https://example.com/old.png","date":"2026-06-23 10:10:00.000"}\n');

  const history = await readHistory({ logPath, id: '1', limit: 10 });

  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'image');
  assert.equal(history[0].message, 'https://example.com/old.png');
  assert.equal(history[0].ordinal, 0);
  assert.equal(Object.hasOwn(history[0], 'imageUrl'), false);
});

test('appendLog assigns missing ordinals without overwriting provided ordinals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await appendLog({
    id: '1',
    name: 'Alice',
    message: 'first generated',
    date: '2026-06-23 10:00:00.000'
  }, { logPath });
  await appendLog({
    id: '1',
    name: 'Alice',
    message: 'second generated',
    date: '2026-06-23 10:00:00.000'
  }, { logPath });
  await appendLog({
    id: '1',
    name: 'Alice',
    message: 'provided ordinal',
    ordinal: 9,
    date: '2026-06-23 10:00:00.000'
  }, { logPath });

  const rawLines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  const rawItems = rawLines.map((line: string) => JSON.parse(line));
  assert.equal(rawLines.some((line: string) => line.includes('"ordinal":null')), false);
  assert.deepEqual(rawItems.map((item: { ordinal: number }) => item.ordinal), [0, 1, 9]);
  assert.deepEqual(keysOf(rawItems[0]), ['date', 'echo', 'id', 'name', 'message', 'ordinal']);
});

test('appendLog and buildConversations generate previews and newest-first summaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await appendLog({
    id: '1',
    name: 'Alice',
    message: ':wave:',
    ordinal: 1,
    date: '2026-06-23 10:00:00.000'
  }, { logPath });
  await appendLog({
    id: '2',
    name: 'Bob',
    message: '[sticker type="happy" limit="0"][/sticker]',
    ordinal: 1,
    date: '2026-06-23 10:02:00.000'
  }, { logPath });
  await appendLog({
    id: '1',
    name: 'Alice',
    message: '[img src=https://example.com/a.png][url=https://example.com/a.png]https://example.com/a.png[/url][/img]',
    ordinal: 2,
    date: '2026-06-23 10:03:00.000'
  }, { logPath });

  assert.equal(previewForMessage({ type: 'message', message: '[og url="https://e.test" title="OG Title"]x[/og]' }), 'OG Title');
  const rawLines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  const rawItems = rawLines.map((line: string) => JSON.parse(line));
  assert.equal(rawLines.some((line: string) => line.includes('imageUrl')), false);
  assert.equal(rawLines.some((line: string) => line.includes('sentAt')), false);
  assert.equal(rawLines.some((line: string) => line.includes('"type":"image"')), false);
  assert.deepEqual(rawItems.map((item: { ordinal: number }) => item.ordinal), [1, 1, 2]);
  assert.deepEqual(keysOf(rawItems[0]), ['date', 'echo', 'id', 'name', 'message', 'ordinal']);
  assert.deepEqual(keysOf(rawItems[2]), ['date', 'echo', 'id', 'name', 'message', 'ordinal']);

  const conversations = await buildConversations({ logPath });
  assert.equal(conversations[0].id, '1');
  assert.equal(conversations[0].preview, '[图片]');
  assert.equal(conversations[1].preview, '[贴纸] happy');
});

for (const incomingFirst of [false, true]) {
  test(`conversation name ${incomingFirst ? 'preserves incoming peer name after outgoing messages' : 'falls back to peer ID for outgoing-only messages'}`, async (t: import('node:test').TestContext) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'chat.jsonl');
    const peer = '76561198000000002';
    if (incomingFirst) {
      await appendLog({ id: peer, name: 'Friend', message: 'hello', echo: false,
        date: '2026-06-23 10:00:00.000' }, { logPath });
    }
    for (const minute of ['01', '02']) {
      await appendLog({ id: peer, name: 'tursom', message: 'reply', echo: true,
        date: `2026-06-23 10:${minute}:00.000` }, { logPath });
      const summaries = await buildConversations({ logPath });
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].id, peer);
      assert.equal(summaries[0].name, incomingFirst ? 'Friend' : peer);
      assert.equal(summaries[0].preview, 'reply');
      assert.equal(summaries[0].lastEcho, true);
    }
    const history = await readHistory({ logPath });
    assert.equal(history.at(-1).name, 'tursom');
  });
}

test('readHistory and buildConversations filter by steam account and keep legacy rows admin-only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await appendLog({
    steamAccountId: '76561198000000000',
    id: '1',
    name: 'Alice',
    message: 'account one',
    ordinal: 1,
    date: '2026-06-23 10:00:00.000'
  }, { logPath });
  await appendLog({
    steamAccountId: '76561198000000001',
    id: '1',
    name: 'Alice',
    message: 'account two',
    ordinal: 1,
    date: '2026-06-23 10:01:00.000'
  }, { logPath });
  await appendLog({
    id: '2',
    name: 'Legacy',
    message: 'legacy',
    ordinal: 1,
    date: '2026-06-23 10:02:00.000'
  }, { logPath });

  const accountHistory = await readHistory({ logPath, steamAccountId: '76561198000000000', limit: 10 });
  assert.deepEqual(accountHistory.map((item: { message: string }) => item.message), ['account one']);

  const adminHistory = await readHistory({ logPath, steamAccountId: '76561198000000000', includeLegacy: true, limit: 10 });
  assert.deepEqual(adminHistory.map((item: { message: string }) => item.message), ['account one', 'legacy']);

  const conversations = await buildConversations({ logPath, steamAccountId: '76561198000000001' });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].preview, 'account two');
});
