import test from 'node:test';
import assert from 'node:assert/strict';
import { steamReplayIdentity } from '../src/storage/history-message';

const event = { steamAccountId: '76561198000000001', id: '76561198000000002',
  echo: false, sentAt: '2026-01-02T03:04:05.000Z', ordinal: 4 };

test('replayed Steam text, emoticons and previews share identity only with validated plain representations', () => {
  for (const [plain, rich] of [
    ['before :happy: after', 'before [emoticon]happy[/emoticon] after'],
    ['https://example.test/a', '[url=https://example.test/a]https://example.test/a[/url]'],
    ['https://example.test/photo', '[img src="https://example.test/photo" thumbnail_src="https://example.test/thumb"]https://example.test/photo[/img]'],
    ['https://example.test/a', '[og url="https://example.test/a" title="Title"]https://example.test/a[/og]'],
  ]) {
    const identity = steamReplayIdentity({ ...event, message: plain });
    assert.equal(steamReplayIdentity({ ...event, message: rich }), identity);
    assert.notEqual(steamReplayIdentity({ ...event, message: rich, ordinal: 5 }), identity);
  }
});

test('literal markup, different destinations and image attributes cannot erase distinct event bodies', () => {
  for (const [left, right] of [
    ['[code]https://example.test/a[/code]', '[code][url]https://example.test/a[/url][/code]'],
    ['https://example.test/a', '[url=https://other.test/a]https://example.test/a[/url]'],
    ['https://example.test/a', '[img src="https://other.test/a"]https://example.test/a[/img]'],
    ['https://example.test/a', '[og url="https://example.test/a" unknown="1"]https://example.test/a[/og]'],
    ['a', 'a\n'],
  ]) assert.notEqual(steamReplayIdentity({ ...event, message: left }), steamReplayIdentity({ ...event, message: right }));
});
