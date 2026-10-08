const videoHosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const shortHosts = new Set(['b23.tv', 'www.b23.tv']);

function parsedUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return url;
  } catch { return null; }
}

function videoUrl(url: URL): string {
  if (!videoHosts.has(url.hostname)) return '';
  const match = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (!match) return '';
  const page = url.searchParams.get('p') || '1';
  if (!/^[1-9]\d{0,3}$/.test(page) || Number(page) > 1000) return '';
  return `https://www.bilibili.com/video/${match[1]}?p=${page}`;
}

/** Resolve public video share links without fetching any video or arbitrary redirect target. */
export async function resolveBilibiliLink(value: unknown, fetchImpl: typeof fetch = fetch): Promise<{ url: string }> {
  let url = parsedUrl(value);
  if (!url) throw Object.assign(new Error('Invalid Bilibili video link'), { statusCode: 400 });
  const visited = new Set<string>();
  const signal = AbortSignal.timeout(8000);
  for (let hop = 0; hop < 5; hop++) {
    const direct = videoUrl(url);
    if (direct) return { url: direct };
    if (!shortHosts.has(url.hostname) || !/^\/[A-Za-z0-9]{1,32}\/?$/.test(url.pathname) || visited.has(url.href)) {
      throw Object.assign(new Error('The share link is not a supported Bilibili video'), { statusCode: 400 });
    }
    url = new URL(`https://b23.tv${url.pathname}`);
    if (visited.has(url.href)) throw Object.assign(new Error('Bilibili share link redirect loop'), { statusCode: 502 });
    visited.add(url.href);
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal });
    } catch {
      throw Object.assign(new Error('Bilibili share link could not be resolved'), { statusCode: 502 });
    }
    // Only headers are needed; do not download the redirected page body.
    void response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw Object.assign(new Error('Bilibili share link did not redirect to a video'), { statusCode: 502 });
    }
    try { url = parsedUrl(new URL(location, url).href); }
    catch { url = null; }
    if (!url) throw Object.assign(new Error('Invalid Bilibili share link redirect'), { statusCode: 502 });
  }
  throw Object.assign(new Error('Too many Bilibili share link redirects'), { statusCode: 502 });
}
