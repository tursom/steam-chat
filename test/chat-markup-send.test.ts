import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SteamUser = require('steam-user');
const { createChatService } = require('../src/server/chat-service');

for (const message of ['[sticker type="show love" limit="0"][/sticker]', '[emoticon]steamhappy[/emoticon]', 'ordinary [text]']) {
  test(`installed Steam SDK preserves the intended wire format: ${message}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'steam-chat-markup-'));
    const user = new SteamUser({ autoRelogin: false });
    const packets: Array<{ message: string; contains_bbcode: boolean }> = [];
    user._sendUnified = (_method: string, payload: { message: string; contains_bbcode: boolean }, callback: (body: unknown, header: unknown) => void) => {
      packets.push(payload);
      callback({ modified_message: payload.message, server_timestamp: 1700000000, ordinal: 1 }, { proto: { eresult: 1 } });
    };
    const service = createChatService({ steamUser: user, logPath: join(directory, 'chat.jsonl'),
      logger: { info() {}, warn() {}, error() {} } });
    t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
    await service.sendTextMessage('76561198000000001', message);
    assert.equal(packets.length, 1);
    const formatted = !message.startsWith('ordinary');
    assert.equal(packets[0].message, formatted ? message : 'ordinary \\[text]');
    assert.equal(packets[0].contains_bbcode, !formatted);
  });
}
