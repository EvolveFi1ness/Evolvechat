/* Evolve PWA service worker — offline support + fast repeat loads.
   Strategy: network-first for the HTML app shell (always fresh when online),
   cache-first for release catalogs and fonts, stale-while-revalidate for other
   static assets. Catalogs are downloaded only when used. */
'use strict';

const CACHE = 'evolve-v10';
const APP_SHELL = ['./index.html', './coach.html'];
const STATIC = [
  './manifest-client.json',
  './manifest-coach.json',
  './design-tokens.css?v=9',
  './shared.js?v=9',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/coach-icon-192.png',
  './icons/coach-icon-512.png',
  './icons/coach-icon-maskable-512.png',
  './icons/coach-apple-touch-icon.png',
  './data/workouts.json',
  './data/workouts.js',
  './data/nutr-foods.json',
  './data/foods.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Catalogs load when needed; installing the worker must not download both
      // apps' food databases or race the page's exercise request.
      Promise.allSettled([...APP_SHELL, ...STATIC.filter(url => !url.startsWith('./data/'))].map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isGoogleFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isGoogleFont) return;

  // HTML navigations: network-first, fall back to a cached shell for offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          const candidates = [url.pathname, url.pathname + 'index.html', './index.html', './coach.html'];
          return caches.match(url.pathname)
            .then((hit) => hit || Promise.all(candidates.map((c) => caches.match(c))).then((r) => r.find(Boolean)));
        })
    );
    return;
  }

  // Static assets: cache-first with stale-while-revalidate for CSS/JS.
  // NOTE: STATIC entries are './'-prefixed, pathnames are '/'-prefixed —
  // normalize before comparing or this branch never matches (it didn't).
  const _norm = (s) => s.replace(/^\.\//, '/').split('?')[0];
  if (STATIC.some((s) => url.pathname.endsWith(_norm(s)))) {
    // Bundled catalogs change with the release cache version. Reuse them until
    // the next release instead of downloading megabytes on every cache hit.
    if (/\/data\/(?:workouts\.(?:json|js)|(?:nutr-)?foods\.json)$/.test(url.pathname)) {
      event.respondWith(caches.match(event.request).then(async hit => {
        if (hit) return hit;
        const res = await fetch(event.request, { cache: 'no-cache' });
        if (res.ok) {
          const copy = res.clone();
          await caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      }));
      return;
    }
    const refresh = fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        return caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {}).then(() => res);
      }
      return res;
    });
    // Handle offline refresh failures even when a cached response wins.
    event.waitUntil(refresh.then(() => {}, () => {}));
    event.respondWith(
      caches.match(event.request).then((hit) => hit || refresh)
    );
    return;
  }

  // Google Fonts: cache-first with long TTL
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((res) => {
          const copy = res.clone();
          if (res.ok || res.type === 'opaque') caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        });
      })
    );
    return;
  }
});
