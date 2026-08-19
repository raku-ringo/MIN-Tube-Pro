// MIN-Tube-Pro Service Worker
const CACHE_NAME = 'min-tube-pro-v1.5.0';
const PRECACHE = [
  '/youtube-pro',
  '/min-img.png'
];

const SKIP_CACHE = [
  '/api/',
  '/video/',
  '/rapid/',
  '/sia-dl/',
  '/ai-fetch/',
  '/360/',
  '/short-check/',
  '/stream/',
  '/get-other/',
  '/check-version'
];

function shouldBypass(url) {
  try {
    const u = new URL(url);
    return SKIP_CACHE.some((p) => u.pathname === p || u.pathname.startsWith(p));
  } catch {
    return true;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (shouldBypass(event.request.url)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/youtube-pro') || caches.match('/');
          }
          return cached;
        });
      return cached || networked;
    })
  );
});
