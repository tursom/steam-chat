import { SocksProxyAgent } from 'socks-proxy-agent';

export type SteamProxyOptions = { httpProxy?: string; socksProxy?: string };

export function getSteamProxyOptions(env: NodeJS.ProcessEnv = process.env): SteamProxyOptions {
  const value = env.STEAM_CHAT_PROXY?.trim();
  if (!value) return {};

  // Do not include the URL in errors: it may contain proxy credentials.
  const invalid = () => new Error('Invalid STEAM_CHAT_PROXY: expected an HTTP, HTTPS or SOCKS proxy URL');
  let url: URL;
  try { url = new URL(value); }
  catch { throw invalid(); }
  if (!url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw invalid();
  if (['http:', 'https:'].includes(url.protocol)) return { httpProxy: value };
  if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
    // socks-proxy-agent v7 needs an explicit port when given a URL.
    if (!url.port) url.port = '1080';
    return { socksProxy: url.href };
  }
  throw invalid();
}

export function getSteamCommunityProxyOptions(proxy: SteamProxyOptions) {
  if (proxy.httpProxy) return { proxy: proxy.httpProxy };
  if (proxy.socksProxy) {
    // request must not apply HTTP_PROXY on top of the SOCKS agent.
    return { proxy: null, agent: new SocksProxyAgent(proxy.socksProxy) };
  }
  return {};
}
