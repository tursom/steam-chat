// Steam's budget includes UTF-8, BBCode escaping and an extra cost for newlines.
// Reference: ArchiSteamFarm/Steam/Integration/SteamChatMessage.cs
export const MAX_TEXT_MESSAGE_BYTES = 6340;
const LIMITED_TEXT_MESSAGE_BYTES = 1945;

export function textMessageLimit(limited = false): number {
  return limited ? LIMITED_TEXT_MESSAGE_BYTES : MAX_TEXT_MESSAGE_BYTES;
}

export function textMessageSize(message: string): number {
  let size = 0;
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    if (code === 13 || code === 10) {
      size += 61;
      if (code === 13 && message.charCodeAt(i + 1) === 10) i++;
    } else if (code < 0x80) {
      size += code === 91 ? 2 : 1; // The SDK escapes '[' only; literal backslashes stay literal.
    } else if (code < 0x800) {
      size += 2;
    } else if (code >= 0xd800 && code <= 0xdbff &&
      message.charCodeAt(i + 1) >= 0xdc00 && message.charCodeAt(i + 1) <= 0xdfff) {
      size += 4;
      i++;
    } else {
      size += 3; // Includes UTF-8 replacement bytes for an unpaired surrogate.
    }
  }
  return size;
}

export function validateTextMessage(message: string, limited = false): void {
  const limit = textMessageLimit(limited);
  const size = textMessageSize(message);
  if (size > limit) {
    throw Object.assign(new Error(`消息过长（发送长度 ${size}/${limit}，中文、表情和换行会占用更多长度），请缩短或分段发送。`), {
      statusCode: 400, code: 'message_too_long', uncertain: false
    });
  }
}

function cannotSplit(reason: string): never {
  throw Object.assign(new Error(`消息无法安全分段：${reason}`), {
    statusCode: 400, code: 'message_cannot_split', uncertain: false
  });
}

// Index immediately after the last value <= target (also works for prefix sums).
function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function splitTextMessage(message: string, limited = false): string[] {
  const limit = textMessageLimit(limited);
  if (textMessageSize(message) <= limit) return [message];
  if (/^\s*\/(?:sticker|roomeffect)(?=\s|$)/i.test(message)) {
    cannotSplit('/sticker 和 /roomeffect 命令过长，不能拆成多条消息，请缩短命令。');
  }

  // Conservatively include URL punctuation: never cut a normal link or Steam emoticon.
  const protectedRanges: Array<{ start: number; end: number }> = [];
  const tokens = /https?:\/\/[^\s<>"'`]+|:[\p{L}\p{N}_+-]+:/giu;
  for (const match of message.matchAll(tokens)) {
    if (textMessageSize(match[0]) > limit) {
      cannotSplit(`单个链接或 Steam 表情超过 ${limit} 的发送长度，请缩短链接或表情。`);
    }
    protectedRanges.push({ start: match.index!, end: match.index! + match[0].length });
  }

  const offsets = [0];
  const costs = [0];
  const visibleCounts = [0];
  const visible: boolean[] = [];
  const slash: boolean[] = [];
  const newline: boolean[] = [];
  const sentence: boolean[] = [];
  const whitespace: boolean[] = [];
  let rangeIndex = 0;
  let protectedEnd = 0;
  let start = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const grapheme of segmenter.segment(message)) {
    const end = grapheme.index + grapheme.segment.length;
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].start < end) {
      protectedEnd = Math.max(protectedEnd, protectedRanges[rangeIndex++].end);
    }
    if (end < protectedEnd) continue;
    const unit = message.slice(start, end);
    const cost = textMessageSize(unit);
    if (cost > limit) cannotSplit(`单个字素（组合字符或表情）超过 ${limit} 的发送长度，请缩短组合字符。`);
    const hasText = unit.trim().length > 0;
    offsets.push(end);
    costs.push(costs[costs.length - 1] + cost);
    visibleCounts.push(visibleCounts[visibleCounts.length - 1] + Number(hasText));
    visible.push(hasText);
    slash.push(/^\s*\//u.test(unit));
    newline.push(/^[\r\n]+$/.test(unit));
    sentence.push(/[.!?。！？…][\p{M}\uFE0F]*$/u.test(unit));
    whitespace.push(/^\s+$/u.test(unit));
    start = end;
  }

  const count = visible.length;
  const nextVisible: number[] = new Array(count + 1);
  nextVisible[count] = count;
  for (let i = count - 1; i >= 0; i--) nextVisible[i] = visible[i] ? i : nextVisible[i + 1];

  // Sorted boundary indexes let every split find the last feasible choice without
  // rescanning a long suffix. Unsafe slash boundaries shift back to a safe unit.
  const hard: number[] = [];
  const lines: number[] = [];
  const sentences: number[] = [];
  const spaces: number[] = [];
  let safe = 0;
  for (let i = 1; i < count; i++) {
    const next = nextVisible[i];
    if (next < count && !slash[next] && costs[next + 1] - costs[i] <= limit) {
      safe = i;
      hard.push(i);
    }
    if (!safe) continue;
    if (newline[i - 1] || newline[i]) lines.push(safe);
    if (sentence[i - 1]) sentences.push(safe);
    if (whitespace[i - 1]) spaces.push(safe);
  }

  const parts: string[] = [];
  start = 0;
  while (costs[count] - costs[start] > limit) {
    const max = upperBound(costs, costs[start] + limit) - 1;
    let end = start;
    for (const boundaries of [lines, sentences, spaces, hard]) {
      const candidate = boundaries[upperBound(boundaries, max) - 1];
      if (candidate > start && visibleCounts[candidate] > visibleCounts[start]) {
        end = candidate;
        break;
      }
    }
    if (end === start) cannotSplit('无法在长度限制内保留有效文字并避免产生新的斜杠命令，请缩短消息或调整空白和命令位置。');
    parts.push(message.slice(offsets[start], offsets[end]));
    start = end;
  }
  if (visibleCounts[count] === visibleCounts[start]) {
    cannotSplit('剩余内容只有空白，无法生成有效消息，请缩短空白内容。');
  }
  parts.push(message.slice(offsets[start]));
  return parts;
}
