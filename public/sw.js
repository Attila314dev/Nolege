const CACHE = 'nolege-shell-3.1.0';
const FILES = ['/offline.html', '/offline.js', '/style.css', '/themes.css', '/experience.css', '/theme.js', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
const STATIC = new Set(FILES);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('nolege-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const { request } = event, url = new URL(request.url);
  // Room state, authentication, admin data and writes always reach the server.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || request.headers.has('authorization')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html'))); return;
  }
  if (!STATIC.has(url.pathname)) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy))); }
    return response;
  }).catch(() => caches.match(url.pathname)));
});
