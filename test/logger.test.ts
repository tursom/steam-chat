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

test('readHistory normalizes, filters, limits, sorts, and skips invalid JSONL lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await fs.writeFile(logPath, [
    '{"id":"2","name":"B","message":"later","date":"2026-06-23 10:12:00.000","ordinal":2}',
    'not json',
    '{"id":"1","name":"A","message":"first","date":"2026-06-23 10:10:00.000","ordinal":1}',
    '{"id":"1","name":"A","message":"second","date":"2026-06-23 10:10:00.000","ordinal":2}'
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
  assert.equal(history[1].message, 'second');
});

test('appendLog and buildConversations generate previews and newest-first summaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-chat-log-'));
  const logPath = path.join(dir, 'chat.jsonl');
  await appendLog({
    id: '1',
    name: 'Alice',
    message: ':wave:',
    date: '2026-06-23 10:00:00.000'
  }, { logPath });
  await appendLog({
    id: '2',
    name: 'Bob',
    message: '[sticker type="happy" limit="0"][/sticker]',
    date: '2026-06-23 10:02:00.000'
  }, { logPath });
  await appendLog({
    type: 'image',
    id: '1',
    name: 'Alice',
    imageUrl: 'https://example.com/a.png',
    date: '2026-06-23 10:03:00.000'
  }, { logPath });

  assert.equal(previewForMessage({ type: 'message', message: '[og url="https://e.test" title="OG Title"]x[/og]' }), 'OG Title');

  const conversations = await buildConversations({ logPath });
  assert.equal(conversations[0].id, '1');
  assert.equal(conversations[0].preview, '[图片]');
  assert.equal(conversations[1].preview, '[贴纸] happy');
});
