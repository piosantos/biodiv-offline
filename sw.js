// sw.js (root paths, cache bump)
const CACHE = 'biodiversity-offline-v4';
const CORE = [
  './',
  './index.html',
  './src/utils/sanitizeLabel.js',
  './tf.min.js',
  './mobilenet.min.js',
  './chart.umd.min.js',
  './html2canvas.min.js',
  './jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE.filter(Boolean)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  e.respondWith(
    caches.match(req).then(cached =>
      cached ||
      fetch(req).then(res => {
        if (req.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
