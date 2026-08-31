/* Evolve PWA service worker — offline support + fast repeat loads.
   Strategy: network-first for the HTML app shell (always fresh when online),
   cache-first for static assets (icons, manifests, fonts), stale-while-revalidate
   for the CDN libs the apps already depend on. */
'use strict';

const CACHE = 'evolve-v9';
const APP_SHELL = ['./index.html', './coach.html'];
const STATIC = [
  './manifest-client.json',
  './manifest-coach.json',
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
      .then(() => self.clients.matchAll())
      .then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'FORCE_RELOAD' }));
      })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // CDN/other origins: let the browser handle it

  // HTML navigations: network-first, fall back to a cached shell for offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)).catch(() => {});
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

  // Static assets: cache-first.
  if (STATIC.some((s) => url.pathname.endsWith(s))) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        const fallback = fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        });
        return hit || fallback;
      })
    );
  }
});
