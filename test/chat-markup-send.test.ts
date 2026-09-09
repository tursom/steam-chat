import { strict as assert } from 'node:assert';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { steamEventKey } from '../src/storage/history-message';
import type { HistoryRecordInput } from '../src/types';

const SteamUser = require('steam-user');
const { createChatService } = require('../src/server/chat-service');
const account = '76561198000000002';
const peer = '76561198000000001';
const logger = { info() {}, warn() {}, error() {} };
const cases = [
  { input: '/sticker Show Love', wire: '/sticker Show Love', canonical: '[sticker type="Show Love" limit="0"][/sticker]' },
  { input: ':Khappy:', wire: ':Khappy:', canonical: '[emoticon]Khappy[/emoticon]' },
  { input: '[sticker type="Show Love" limit="0"][/sticker]', wire: '\\[sticker type="Show Love" limit="0"]\\[/sticker]', canonical: '\\[sticker type="Show Love" limit="0"]\\[/sticker]' },
  { input: '[emoticon]Khappy[/emoticon]', wire: '\\[emoticon]Khappy\\[/emoticon]', canonical: '\\[emoticon]Khappy\\[/emoticon]' },
  { input: 'ordinary [text]', wire: 'ordinary \\[text]', canonical: 'ordinary \\[text]' }
];

for (const { input, wire, canonical } of cases) {
  test(`SDK default wire format and canonical server reply: ${input}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'steam-chat-markup-'));
    const logPath = join(directory, 'chat.jsonl');
    const user = new SteamUser({ autoRelogin: false });
    const packets: Array<{ method: string; payload: unknown }> = [];
    // Model Steam's reply explicitly; command requests are not canonical BBCode.
    user._sendUnified = (method: string, payload: unknown, callback: (body: unknown, header: unknown) => void) => {
      packets.push({ method, payload });
      callback({ modified_message: canonical, server_timestamp: 1700000000, ordinal: 1 }, { proto: { eresult: 1 } });
    };
    const service = createChatService({ steamUser: user, logPath, logger,
      config: { host: '127.0.0.1', port: 0, wsPath: '/ws' } });
    t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/ws`);
    t.after(() => ws.terminate());
    await once(ws, 'message'); // Ready precedes send broadcasts.
    const broadcast = once(ws, 'message');
    const item = await service.sendTextMessage(peer, input, account);
    assert.deepEqual(packets, [{ method: 'FriendMessages.SendMessage#1', payload: {
      steamid: peer, chat_entry_type: 1, message: wire, contains_bbcode: true
    } }]);
    assert.equal(item.message, canonical);
    assert.equal(item.ordinal, 1);
    assert.equal(JSON.parse(String((await broadcast)[0])).message, canonical);
    const history = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].message, canonical);
  });
}

for (const reply of [undefined, { modified_message: '' }, { modified_message: '/sticker CatchHeart' }]) {
  test(`unparsed sticker response is uncertain, not archived or automatically resent: ${JSON.stringify(reply)}`, async t => {
    let sends = 0;
    let appends = 0;
    const user = Object.assign(new EventEmitter(), {
      sendFriendMessage(_id: string, _message: string, callback: (error: null, reply: unknown) => void) {
        sends++; callback(null, reply);
      }
    });
    const service = createChatService({ steamUser: user, logger, historyStorage: {
      canSend: () => true, append() { appends++; },
      onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
    } });
    t.after(() => service.stop());
    await assert.rejects(service.sendTextMessage(peer, '/sticker CatchHeart', account),
      (error: { statusCode?: number; uncertain?: boolean }) => error.statusCode === 502 && error.uncertain === true);
    assert.equal(sends, 1);
    assert.equal(appends, 0);
  });
}

for (const result of [undefined, { ordinal: 7 }, { modified_message: '[sticker type="happy" limit="0"][/sticker]' }, { modified_message: '' }]) {
  test(`canonical event identity and legacy reply fallback: ${JSON.stringify(result)}`, async t => {
    const records: HistoryRecordInput[] = [];
    const timestamp = new Date(1700000000000);
    const reply = result === undefined ? undefined : { server_timestamp: timestamp, ordinal: 7, ...result };
    const user = Object.assign(new EventEmitter(), {
      sendFriendMessage(id: string, message: string, callback: (error: null, reply: unknown) => void) {
        assert.equal(id, peer);
        assert.equal(message, 'legacy text');
        callback(null, reply);
      }
    });
    const service = createChatService({ steamUser: user, logger, historyStorage: {
      canSend: () => true,
      append(record: HistoryRecordInput) { records.push(record); return record; },
      onMessage: () => () => {}, onStatus: () => () => {}, onDurable: () => () => {}
    } });
    t.after(() => service.stop());
    const item = await service.sendTextMessage(peer, 'legacy text', account);
    const canonical = result && 'modified_message' in result ? result.modified_message : 'legacy text';
    assert.equal(item.message, canonical);
    assert.equal(records.length, 1);
    assert.equal(records[0].message, canonical);
    assert.equal(records[0].steamEventKey, reply ? steamEventKey(account, peer, true, canonical, timestamp, 7) : undefined);
    if (reply && canonical !== 'legacy text') {
      assert.notEqual(records[0].steamEventKey, steamEventKey(account, peer, true, 'legacy text', timestamp, 7));
    }
  });
}
