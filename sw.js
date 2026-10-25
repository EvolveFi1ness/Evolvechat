/* Evolve PWA service worker — offline support + fast repeat loads.
   Strategy: network-first for the HTML app shell (always fresh when online),
   cache-first for static assets (icons, manifests, fonts, CSS), stale-while-revalidate
   for the CDN libs the apps already depend on. */
'use strict';

const CACHE = 'evolve-v7';
const APP_SHELL = ['./index.html', './coach.html'];
const STATIC = [
  './manifest-client.json',
  './manifest-coach.json',
  './design-tokens.css?v=7',
  './shared.js?v=7',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/coach-icon-192.png',
  './icons/coach-icon-512.png',
  './icons/coach-icon-maskable-512.png',
  './icons/coach-apple-touch-icon.png',
  './data/workouts.json',
  './data/nutr-foods.json',
  './data/foods.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled([...APP_SHELL, ...STATIC].map((url) => cache.add(url).catch(() => {})))
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
