// Financial Books service worker: makes the app installable and keeps the static files (CSS, JS, icons)
// on hand. Pages, PDFs, downloads and every write always go to the server; nothing financial is cached.
const CACHE = 'fb-static-v2';
const STATIC = ['/public/app.css', '/public/app.js', '/public/manifest.webmanifest', '/public/icons/icon-192.png', '/public/icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Static files: network first (so updates show at once), the cached copy when the network is slow or down.
// Everything else is left alone and goes straight to the server.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(cache => fetch(event.request)
    .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
    .catch(async () => (await cache.match(event.request)) ?? Response.error())));
});
