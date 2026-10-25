// Injected only into dist/web/sw.js by scripts/build-web.cjs.
const BUILD = null /* BUILD_MANIFEST */;
const CACHE_PREFIX = 'steam-chat-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD.version;
const resources = new Map(BUILD.resources.map(entry => [entry.url, entry]));

async function fetchVerified(entry) {
  // Public build assets only; never send credentials or follow redirects to login pages.
  const response = await fetch(new URL(entry.url, self.location.origin).href, {
    credentials: 'omit', cache: 'no-store', redirect: 'error'
  });
  if (!response.ok || response.redirected) throw new Error(`Cannot precache ${entry.url}`);
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
  if (hash !== entry.hash) throw new Error(`Build changed while fetching ${entry.url}`);
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Verify the complete build before writing anything. A partial deployment leaves
    // the existing worker intact and a later browser update check can try again.
    const entries = Array.from(resources.values());
    const responses = await Promise.all(entries.map(fetchVerified));
    const cache = await caches.open(CACHE_NAME);
    try {
      for (let index = 0; index < entries.length; index++) {
        await cache.put(entries[index].url, responses[index]);
      }
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
  // No skipWaiting: existing tabs must finish using their matching HTML/JS/CSS.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
  })());
  // No clients.claim: an already loaded, uncontrolled page may be another build.
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = url.pathname + url.search;
  const isShell = key === '/' || key === '/index.html';
  if (isShell && request.mode !== 'navigate') return;
  const entry = resources.get(isShell ? '/index.html' : key);
  if (!entry) return; // Auth APIs, user images, arbitrary queries and unknown URLs use network only.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Serve HTML and assets from one build, even online. Browser SW update checks
    // install the next build; it activates after all old controlled tabs close.
    return await cache.match(entry.url) || fetchVerified(entry);
  })());
});
