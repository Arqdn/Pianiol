// Pianiol service worker — offline app shell.
const VERSION = 'pianiol-v5';
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
  './js/coach.js',
  './js/midi-input.js',
  './js/transcribe.js',
  './js/transcribe-ml.js',
  './js/pcm-worklet.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const SHARE_CACHE = 'pianiol-share';

// Web Share Target (POST): links arrive as form fields, shared audio/video as a file.
// Stash the file in a cache and bounce to the app with query params it already understands.
async function handleShare(request) {
  const url = new URL(request.url);
  const base = url.pathname.replace(/share$/, '');
  const params = new URLSearchParams();
  try {
    const fd = await request.formData();
    for (const k of ['title', 'text', 'url']) {
      const v = fd.get(k);
      if (typeof v === 'string' && v.trim()) params.set(k, v.trim());
    }
    const file = fd.get('media');
    if (file && typeof file === 'object' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('shared-media', new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name || 'shared'),
        },
      }));
      params.set('shared-file', '1');
    }
  } catch (err) {
    params.set('share-error', '1');
  }
  const qs = params.toString();
  return Response.redirect(url.origin + base + (qs ? '?' + qs : ''), 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

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
