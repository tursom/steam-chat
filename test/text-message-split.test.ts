import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TEXT_MESSAGE_BYTES, splitTextMessage, textMessageLimit, textMessageSize, validateTextMessage
} from '../src/server/text-message-limit';

function split(message: string, limited = false): string[] {
  const parts = splitTextMessage(message, limited);
  assert.equal(parts.join(''), message, 'must preserve every original UTF-16 code unit');
  for (let i = 0; i < parts.length; i++) {
    assert.ok(parts[i].trim().length, 'each emitted long-message part must contain text');
    assert.ok(textMessageSize(parts[i]) <= textMessageLimit(limited));
    assert.doesNotThrow(() => validateTextMessage(parts[i], limited));
    if (i > 0) {
      assert.doesNotMatch(parts[i], /^\s*\//, 'must not introduce a command');
      assert.ok(!(parts[i - 1].endsWith('\r') && parts[i].startsWith('\n')), 'CRLF is atomic');
    }
  }
  return parts;
}

function cannotSplit(message: string, limited = false, explanation?: RegExp): void {
  assert.throws(() => splitTextMessage(message, limited), (error: unknown) => {
    assert.ok(error instanceof Error);
    const details = error as Error & { statusCode: number; code: string; uncertain: boolean };
    assert.equal(details.statusCode, 400);
    assert.equal(details.code, 'message_cannot_split');
    assert.equal(details.uncertain, false);
    assert.match(details.message, /消息无法安全分段/);
    if (explanation) assert.match(details.message, explanation);
    return true;
  });
}

test('exports both budgets and preserves measurement, validation and literal backslashes', () => {
  assert.equal(MAX_TEXT_MESSAGE_BYTES, 6340);
  assert.equal(textMessageLimit(), 6340);
  assert.equal(textMessageLimit(true), 1945);
  for (const value of ['\\', '\\[', '\\\\[中😀', '\r\n\r\n\n', '\ud800x\udc00', '👩🏽‍💻', '[\r\n[']) {
    const lines = value.replace(/\[/g, '\\[').split(/\r\n?|\n/);
    const expected = lines.reduce((sum, line) => sum + Buffer.byteLength(line), (lines.length - 1) * 61);
    assert.equal(textMessageSize(value), expected);
  }
  assert.throws(() => validateTextMessage('a'.repeat(6341)), { code: 'message_too_long' });
  split('\\['.repeat(5000));
});

test('short input is returned exactly, including empty text, whitespace and commands', () => {
  for (const message of ['', ' \t\r\n ', '中文😀\\[', '/sticker 123', '  /roomeffect 42', 'a'.repeat(6340)]) {
    assert.deepEqual(splitTextMessage(message), [message]);
  }
  assert.deepEqual(splitTextMessage('a'.repeat(1945), true), ['a'.repeat(1945)]);
});

test('Chinese and long single lines use greedy grapheme-safe hard boundaries', () => {
  assert.deepEqual(split('中'.repeat(5000)).map(part => part.length), [2113, 2113, 774]);
  assert.deepEqual(split('a'.repeat(20000)).map(part => part.length), [6340, 6340, 6340, 980]);
});

test('the last feasible newline wins even over much later sentence and space boundaries', () => {
  const prefix = '开头\n第二行\n';
  const message = prefix + 'a'.repeat(5000) + '。 ' + 'b'.repeat(3000);
  assert.equal(split(message)[0], prefix);
  assert.equal(split('a'.repeat(100) + '\n' + 'b'.repeat(7000))[0], 'a'.repeat(100) + '\n');
});

test('weighted newline boundaries include the newline when it fits, otherwise retain it in the next part', () => {
  for (const ending of ['\r\n', '\r', '\n']) {
    const fits = split('a'.repeat(6279) + ending + 'b'.repeat(100));
    assert.equal(fits[0], 'a'.repeat(6279) + ending);
    assert.equal(textMessageSize(fits[0]), 6340);
    const before = split('a'.repeat(6280) + ending + 'b'.repeat(100));
    assert.equal(before[0], 'a'.repeat(6280));
    assert.equal(before[1], ending + 'b'.repeat(100));
  }
});

test('CRLF stays atomic across many weighted lines', () => {
  const parts = split(('行\r\n').repeat(300) + '结尾');
  assert.ok(parts.length > 2);
  assert.ok(parts.slice(0, -1).every((part, i) => part.endsWith('\r\n') || parts[i + 1].startsWith('\r\n')));
});

test('sentence boundaries beat spaces and spaces beat hard cuts on a single line', () => {
  for (const punctuation of ['。', '！', '？', '.', '!', '?', '…']) {
    const prefix = 'a'.repeat(100) + punctuation;
    assert.equal(split(prefix + 'b'.repeat(3000) + ' ' + 'c'.repeat(4000))[0], prefix);
  }
  const prefix = 'a'.repeat(100) + ' \t';
  assert.equal(split(prefix + 'b'.repeat(7000))[0], prefix);
});

test('bracket escaping and newline costs determine feasible boundaries', () => {
  assert.deepEqual(split('['.repeat(3170) + 'x'), ['['.repeat(3170), 'x']);
  const prefix = '['.repeat(3139) + '\n';
  assert.equal(textMessageSize(prefix), 6339);
  assert.equal(split(prefix + '中'.repeat(100))[0], prefix);
});

test('emoji, surrogate pairs and combining graphemes never split internally', () => {
  for (const grapheme of ['😀', '👨‍👩‍👧‍👦', '👩🏽‍💻', '🇨🇳', 'e\u0301', 'क्‍ष']) {
    const prefix = 'a'.repeat(6339);
    assert.deepEqual(split(prefix + grapheme + 'z'.repeat(100)), [prefix, grapheme + 'z'.repeat(100)]);
  }
});

test('normal HTTP(S) URLs and Steam emoticons are atomic at the budget boundary', () => {
  for (const token of ['https://example.com/path?q=[abc]&next=/foo#section',
    'http://example.org/a-b_c?x=1', 'HTTPS://example.com/路径', ':smile:', ':steam_happy_123:']) {
    const prefix = 'a'.repeat(6338);
    const parts = split(prefix + token + ' tail');
    assert.equal(parts[0], prefix);
    assert.ok(parts[1].startsWith(token));
    assert.equal(parts.filter(part => part.includes(token)).length, 1);
  }
});

test('a protected token fitting exactly can be sent as one complete part', () => {
  const url = 'https://example.com/' + 'a'.repeat(6340 - 'https://example.com/'.length);
  assert.deepEqual(split('before ' + url + ' after'), ['before ', url, ' after']);
});

test('oversized links and emoticons fail with a useful, certain client error', () => {
  cannotSplit('https://example.com/' + 'x'.repeat(6340), false, /链接|表情/);
  cannotSplit(':' + 'a'.repeat(6340) + ':', false, /链接|表情/);
  cannotSplit('https://example.com/' + 'x'.repeat(1945), true, /1945/);
});

test('leading, trailing, repeated whitespace and blank lines reconstruct exactly', () => {
  const message = ' \t\r\n\n' + '甲'.repeat(2200) + '  \t\n\r\n' + '乙'.repeat(2300) + '\r\n \t  ';
  split(message);
  split('a' + ' '.repeat(8000) + 'b');
  split(' '.repeat(2000) + 'a'.repeat(5000) + ' '.repeat(2000));
  split('a'.repeat(6300) + '\n\n\n\n');
});

test('whitespace-only overflow and whitespace that cannot accompany text fail safely', () => {
  cannotSplit(' '.repeat(6341));
  cannotSplit('a' + ' '.repeat(6341));
  cannotSplit(' '.repeat(6341) + 'a');
});

test('limited accounts use 1945 for every weighted part', () => {
  assert.deepEqual(split('中'.repeat(1400), true).map(part => part.length), [648, 648, 104]);
  const prefix = 'a'.repeat(1884) + '\r\n';
  assert.equal(split(prefix + 'b'.repeat(2000), true)[0], prefix);
  split('['.repeat(3000) + '👩🏽‍💻', true);
});

test('new parts cannot start slash commands, including after newlines and indentation', () => {
  for (const separator of ['', ' ', '\n', '\r\n \t']) {
    const prefix = 'a'.repeat(6340);
    const parts = split(prefix + separator + '/sticker 42');
    assert.equal(parts[0], 'a'.repeat(6339));
    assert.equal(parts[1], 'a' + separator + '/sticker 42');
  }
  split('中'.repeat(2113) + '\n /arbitrary-command ' + 'z'.repeat(7000));
});

test('command safety can shift a whole protected token or grapheme backward', () => {
  const emoji = '👩🏽‍💻';
  const prefix = 'x'.repeat(6340 - textMessageSize(emoji));
  assert.deepEqual(split(prefix + emoji + '\n /foo'), [prefix, emoji + '\n /foo']);
  const token = ':smile:';
  const before = 'x'.repeat(6340 - textMessageSize(token));
  assert.deepEqual(split(before + token + ' /foo'), [before, token + ' /foo']);
});

test('unavoidable new slash commands fail instead of being submitted', () => {
  cannotSplit('a' + ' '.repeat(6340) + '/sticker 42');
  cannotSplit('a' + '/'.repeat(7000));
});

test('long original sticker and room-effect commands are never split', () => {
  for (const command of ['/sticker', '/roomeffect', ' \t/STICKER']) {
    cannotSplit(command + ' ' + 'x'.repeat(6340), false, /命令过长/);
    cannotSplit(command + ' ' + 'x'.repeat(1945), true, /命令过长/);
  }
});

test('malformed surrogates preserve original code units and their replacement-byte costs', () => {
  const message = 'x'.repeat(6338) + '\ud800' + 'abc\udc00' + '😀'.repeat(2000);
  const parts = split(message);
  assert.equal(parts[0], 'x'.repeat(6338));
  assert.ok(parts[1].startsWith('\ud800abc\udc00'));
});

test('an oversized combining grapheme fails without fragmenting the cluster', () => {
  cannotSplit('a' + '\u0301'.repeat(4001), false, /字素|组合字符/);
  cannotSplit('x'.repeat(2000) + 'e' + '\u0301'.repeat(1000), true, /字素|组合字符/);
});

test('large inputs with many early newline choices complete with exact reconstruction', () => {
  const message = ('a\n' + '中'.repeat(700) + '。 ').repeat(100);
  assert.ok(split(message).length > 30);
});
