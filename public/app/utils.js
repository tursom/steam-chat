export function formatConversationTime(value) {
  if (!value) {
    return '';
  }
  return String(value).slice(5, 16);
}

export function parseDateString(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7] || 0),
  );
}

export function sameDay(left, right) {
  return left && right
    && left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatDayLabel(value) {
  const date = parseDateString(value);
  if (!date) {
    return value || '';
  }

  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

export function formatTimeLabel(value) {
  const date = parseDateString(value);
  if (!date) {
    return value || '';
  }

  return String(date.getHours()).padStart(2, '0') + ':'
    + String(date.getMinutes()).padStart(2, '0');
}

export function extractStickerType(message) {
  const match = String(message || '').match(/\[sticker\s+type="([^"]+)"/i);
  return match ? match[1] : null;
}

export function extractEmoticonNames(message) {
  const content = String(message || '');
  const names = new Set();

  for (const match of content.matchAll(/\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?/gi)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }

  for (const match of content.matchAll(/\[emoticon\]([^\[]+)\[\/emoticon\]/gi)) {
    if (match[1]) {
      names.add(match[1].trim());
    }
  }

  for (const match of content.matchAll(/(^|\s):([a-z0-9_][a-z0-9_\-]*):(?=\s|$|[!?,.])/gi)) {
    if (match[2]) {
      names.add(match[2]);
    }
  }

  return [...names];
}

export function extractImageUrls(message) {
  const content = String(message || '');
  const urls = new Set();

  for (const match of content.matchAll(/\[img\](https?:\/\/[^\s\[\]]+?)\[\/img\]/gi)) {
    if (match[1]) {
      urls.add(match[1]);
    }
  }

  for (const match of content.matchAll(/<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    if (match[1]) {
      urls.add(match[1]);
    }
  }

  for (const match of content.matchAll(/https?:\/\/\S+?(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/gi)) {
    if (match[0]) {
      urls.add(match[0]);
    }
  }

  return [...urls];
}

export function parseBbCodeAttributes(rawAttributes) {
  const attrs = {};
  const content = String(rawAttributes || '');
  const attributeRegex = /([a-z][a-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'=<>`]+))/gi;
  let match;

  while ((match = attributeRegex.exec(content)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = value.replace(/\\(["'])/g, '$1');
  }

  return attrs;
}

export function extractOpenGraphEmbeds(message) {
  const content = String(message || '');
  const embeds = [];

  for (const match of content.matchAll(/\[og\s+([^\]]+)\]([\s\S]*?)\[\/og\]/gi)) {
    const attrs = parseBbCodeAttributes(match[1] || '');
    const fallbackUrl = String(match[2] || '').trim();

    embeds.push({
      url: attrs.url || fallbackUrl,
      img: attrs.img || null,
      title: attrs.title || '',
    });
  }

  return embeds.filter((item) => item.url);
}

export function buildSteamEmoticonUrl(name, large = true) {
  const normalized = String(name || '').trim().replace(/^:+|:+$/g, '');
  if (!normalized) {
    return '';
  }

  return 'https://steamcommunity-a.akamaihd.net/economy/' + (large ? 'emoticonlarge' : 'emoticon') + '/' + encodeURIComponent(normalized);
}

export function buildCachedImageUrl(url) {
  return location.origin + '/proxy/image?url=' + encodeURIComponent(String(url || ''));
}

export function buildSteamStickerCandidateUrls(type) {
  const normalized = String(type || '').trim();
  if (!normalized) {
    return [];
  }

  return [
    'https://steamcommunity-a.akamaihd.net/economy/sticker/' + encodeURIComponent(normalized),
    'https://steamcommunity-a.akamaihd.net/economy/stickerlarge/' + encodeURIComponent(normalized),
    'https://steamcommunity.com/economy/sticker/' + encodeURIComponent(normalized),
    'https://steamcommunity.com/economy/stickerlarge/' + encodeURIComponent(normalized),
  ];
}
