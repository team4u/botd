// Service Worker for botd (Static assets ONLY, NEVER cache API / private data)
const CACHE_NAME = 'botd-static-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Pre-caching static assets non-fatal error:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // STRICT RULE: Never cache any API requests, SSE streams, WebSockets, or non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.includes('/events') ||
    event.request.headers.get('accept')?.includes('text/event-stream')
  ) {
    // Direct network passthrough without caching
    return;
  }

  // Only handle same-origin static requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-first strategy for index.html / navigation, cache-first for hashed static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Network failed, return cached response if present
        return cachedResponse;
      });

      // If we have a cached static asset and it's not navigation, return it immediately
      if (cachedResponse && event.request.mode !== 'navigate') {
        return cachedResponse;
      }
      return fetchPromise;
    })
  );
});
