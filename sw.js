// sw.js (root paths, cache bump)
const CACHE_PREFIX = 'biodiversity-offline-';
const CACHE = `${CACHE_PREFIX}v17`;
const REQUIRED_CORE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './src/utils/sanitizeLabel.js',
  './src/utils/assessment.js',
  './src/utils/observationRecord.js',
  './src/utils/surveyStore.js',
  './src/utils/biodiversity.js',
  './src/utils/diversityInterpretation.js',
  './src/utils/classificationSession.js'
];
const OPTIONAL_FEATURE_ASSETS = [
  './tf.min.js',
  './mobilenet.min.js',
  './chart.umd.min.js',
  './html2canvas.min.js',
  './jspdf.umd.min.js'
];

function isCacheableRuntimeResponse(request, response) {
  if (!request || request.method !== 'GET' || !response) return false;
  if (new URL(request.url).origin !== self.location.origin) return false;
  if (!response.ok || response.status === 206) return false;
  return response.type === 'basic' || response.type === 'default';
}

async function installApplicationShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(REQUIRED_CORE);
  await Promise.all(OPTIONAL_FEATURE_ASSETS.map(async (asset) => {
    try {
      await cache.add(asset);
    } catch (_) {
      // Optional features report their own unavailable state in the application.
    }
  }));
  await self.skipWaiting();
}

async function activateApplicationShell() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key))
  );
  await self.clients.claim();
}

self.addEventListener('install', (event) => {
  event.waitUntil(installApplicationShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(activateApplicationShell());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let cacheWrite = Promise.resolve();
  const response = caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;

    const networkResponse = await fetch(request);
    if (isCacheableRuntimeResponse(request, networkResponse)) {
      cacheWrite = cache.put(request, networkResponse.clone()).catch(() => undefined);
    }
    return networkResponse;
  });

  event.respondWith(response);
  event.waitUntil(response.then(() => cacheWrite).catch(() => undefined));
});
