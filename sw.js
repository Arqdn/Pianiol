// Pianiol service worker — offline app shell.
const VERSION = 'pianiol-v3';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/engine.js',
  './js/synth.js',
  './js/midi.js',
  './js/library.js',
  './js/songs-data.js',
  './js/search.js',
  './js/share.js',
  './js/finder.js',
  './js/ai.js',
  './js/transcribe.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Navigations (including share-target GETs with query params) → cached shell,
  // refreshed in the background.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(cached => {
        const fresh = fetch(e.request)
          .then(res => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then(c => c.put('./index.html', copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  // Static assets → stale-while-revalidate.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      const fresh = fetch(e.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
