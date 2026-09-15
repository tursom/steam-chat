// Network-only: never cache conversations, authenticated API responses or user images.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET'
    || new URL(event.request.url).origin !== self.location.origin
    || !['/', '/index.html'].includes(new URL(event.request.url).pathname)) return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steam Chat · 无法连接</title><body><h1>暂时无法连接 Steam Chat</h1>
<p>请检查网络连接。恢复连接后重新打开应用。</p><a href="/">重新连接</a></body></html>`, {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  })));
});
