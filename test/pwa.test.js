import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${rootPath}manifest.json`, 'utf8'));
const serviceWorkerSource = readFileSync(`${rootPath}sw.js`, 'utf8');
const indexSource = readFileSync(`${rootPath}index.html`, 'utf8');
const readmeSource = readFileSync(`${rootPath}README.md`, 'utf8');
const shellScriptSource = readFileSync(`${rootPath}get_libs.sh`, 'utf8');
const powershellScriptSource = readFileSync(`${rootPath}get_libs.ps1`, 'utf8');

function response({ status = 200, type = 'basic', value = 'network' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    value,
    clone() {
      return response({ status, type, value });
    }
  };
}

function request(url, method = 'GET') {
  return { method, url };
}

function createWorkerEnvironment(options = {}) {
  const listeners = new Map();
  const cacheStores = new Map();
  const missingAssets = new Set(options.missingAssets || []);
  const fetchCalls = [];
  const openCalls = [];
  const deleteCalls = [];
  let claimCalls = 0;
  let skipWaitingCalls = 0;

  function keyFor(value) {
    return typeof value === 'string' ? value : value.url;
  }

  function cacheFor(name) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    const entries = cacheStores.get(name);
    return {
      async add(asset) {
        if (missingAssets.has(asset)) throw new Error(`missing:${asset}`);
        entries.set(asset, response({ value: asset }));
      },
      async addAll(assets) {
        if (assets.some(asset => missingAssets.has(asset))) {
          throw new Error('required_asset_missing');
        }
        assets.forEach(asset => entries.set(asset, response({ value: asset })));
      },
      async match(value) {
        return entries.get(keyFor(value));
      },
      async put(value, cachedResponse) {
        if (options.rejectCacheWrite) throw new Error('cache_write_failed');
        entries.set(keyFor(value), cachedResponse);
      }
    };
  }

  for (const [name, entries] of Object.entries(options.initialCaches || {})) {
    cacheStores.set(name, new Map(Object.entries(entries)));
  }

  let resolveClaim;
  const claimPromise = options.deferClaim
    ? new Promise(resolve => { resolveClaim = resolve; })
    : Promise.resolve();
  const self = {
    location: { origin: 'https://example.test' },
    clients: {
      claim() {
        claimCalls += 1;
        return claimPromise;
      }
    },
    skipWaiting() {
      skipWaitingCalls += 1;
      return Promise.resolve();
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
  const caches = {
    async delete(name) {
      deleteCalls.push(name);
      return cacheStores.delete(name);
    },
    async keys() {
      return Array.from(cacheStores.keys());
    },
    async open(name) {
      openCalls.push(name);
      return cacheFor(name);
    }
  };
  const fetch = async requested => {
    fetchCalls.push(requested);
    return typeof options.fetchResponse === 'function'
      ? options.fetchResponse(requested)
      : (options.fetchResponse || response());
  };

  runInNewContext(serviceWorkerSource, {
    Promise,
    URL,
    caches,
    console,
    fetch,
    self
  });

  function dispatch(type, requestValue) {
    const waited = [];
    let responsePromise;
    let respondWithCalls = 0;
    const event = {
      request: requestValue,
      respondWith(value) {
        respondWithCalls += 1;
        responsePromise = Promise.resolve(value);
      },
      waitUntil(value) {
        waited.push(Promise.resolve(value));
      }
    };
    listeners.get(type)(event);
    return {
      done: Promise.all(waited),
      get respondWithCalls() { return respondWithCalls; },
      get response() { return responsePromise; },
      waited
    };
  }

  return {
    cacheStores,
    deleteCalls,
    dispatch,
    fetchCalls,
    get claimCalls() { return claimCalls; },
    get skipWaitingCalls() { return skipWaitingCalls; },
    openCalls,
    resolveClaim
  };
}

function readPngDimensions(fileName) {
  const bytes = readFileSync(`${rootPath}${fileName}`);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

describe('PWA release assets', () => {
  it.each([
    ['icon-192.png', 192],
    ['icon-512.png', 512]
  ])('ships %s at its declared square dimensions', (fileName, size) => {
    expect(readPngDimensions(fileName)).toEqual({ width: size, height: size });
  });

  it('keeps manifest icon declarations aligned with the PNG files', () => {
    expect(manifest.icons).toEqual([
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
    ]);
  });

  it('precaches the manifest and both icons under cache generation v17', () => {
    expect(serviceWorkerSource).toContain("const CACHE_PREFIX = 'biodiversity-offline-'");
    expect(serviceWorkerSource).toContain("const CACHE = `${CACHE_PREFIX}v17`");
    expect(serviceWorkerSource).toContain("'./manifest.json'");
    expect(serviceWorkerSource).toContain("'./icon-192.png'");
    expect(serviceWorkerSource).toContain("'./icon-512.png'");
  });

  it('documents eight suites and the required/optional installation split', () => {
    expect(readmeSource).toContain('The eight Vitest suites');
    expect(readmeSource).toContain('PWA/service-worker release behavior');
    expect(readmeSource).toContain('required application shell');
    expect(readmeSource).toContain('Available optional');
    expect(readmeSource).toContain('`./get_libs.sh`');
    expect(readmeSource).toContain('biodiversity-offline-v17');
  });

  it('keeps fallback messaging accurate when optional features are unavailable', () => {
    expect(indexSource).toContain('library lokal tidak lengkap');
    expect(indexSource).toContain('Model tidak tersedia saat ini.');
    expect(indexSource).toContain('Library chart lokal belum tersedia.');
    expect(indexSource).toContain('Library PDF lokal belum tersedia.');
  });

  it('resolves recovery checks relative to each script location', () => {
    expect(shellScriptSource).toContain('BASH_SOURCE[0]');
    expect(shellScriptSource).toContain('"$SCRIPT_DIR/$file"');
    expect(powershellScriptSource).toContain('$PSScriptRoot');
    expect(powershellScriptSource).toContain('Join-Path');
  });
});

describe('service-worker install lifecycle', () => {
  it('fails installation when required index.html is missing', async () => {
    const worker = createWorkerEnvironment({ missingAssets: ['./index.html'] });
    const install = worker.dispatch('install');

    await expect(install.done).rejects.toThrow('required_asset_missing');
    expect(worker.skipWaitingCalls).toBe(0);
  });

  it('fails installation when a required utility module is missing', async () => {
    const worker = createWorkerEnvironment({
      missingAssets: ['./src/utils/assessment.js']
    });

    await expect(worker.dispatch('install').done).rejects.toThrow('required_asset_missing');
    expect(worker.skipWaitingCalls).toBe(0);
  });

  it('continues installation when MobileNet is unavailable and caches other optional assets', async () => {
    const worker = createWorkerEnvironment({ missingAssets: ['./mobilenet.min.js'] });
    await worker.dispatch('install').done;

    const installed = worker.cacheStores.get('biodiversity-offline-v17');
    expect(installed.has('./index.html')).toBe(true);
    expect(installed.has('./tf.min.js')).toBe(true);
    expect(installed.has('./chart.umd.min.js')).toBe(true);
    expect(installed.has('./html2canvas.min.js')).toBe(true);
    expect(installed.has('./jspdf.umd.min.js')).toBe(true);
    expect(installed.has('./mobilenet.min.js')).toBe(false);
    expect(worker.skipWaitingCalls).toBe(1);
  });
});

describe('service-worker activation lifecycle', () => {
  it('removes old biodiversity caches and preserves unrelated origin caches', async () => {
    const worker = createWorkerEnvironment({
      initialCaches: {
        'biodiversity-offline-v15': {},
        'biodiversity-offline-v16': {},
        'biodiversity-offline-v17': {},
        'school-portal-v3': {}
      }
    });

    await worker.dispatch('activate').done;

    expect(worker.deleteCalls).toEqual([
      'biodiversity-offline-v15',
      'biodiversity-offline-v16'
    ]);
    expect(Array.from(worker.cacheStores.keys())).toEqual([
      'biodiversity-offline-v17',
      'school-portal-v3'
    ]);
  });

  it('keeps clients.claim inside the awaited activation lifecycle', async () => {
    const worker = createWorkerEnvironment({
      deferClaim: true,
      initialCaches: { 'biodiversity-offline-v17': {} }
    });
    let settled = false;
    const activation = worker.dispatch('activate');
    activation.done.then(() => { settled = true; });
    for (let attempt = 0; attempt < 10 && worker.claimCalls === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(worker.claimCalls).toBe(1);
    expect(settled).toBe(false);

    worker.resolveClaim();
    await activation.done;
    expect(settled).toBe(true);
  });
});

describe('service-worker runtime caching', () => {
  it('returns a current-cache hit without fetching', async () => {
    const cached = response({ value: 'current-cache' });
    const worker = createWorkerEnvironment({
      initialCaches: {
        'biodiversity-offline-v17': {
          'https://example.test/current.js': cached
        }
      }
    });
    const fetchEvent = worker.dispatch(
      'fetch',
      request('https://example.test/current.js')
    );

    await expect(fetchEvent.response).resolves.toBe(cached);
    await fetchEvent.done;
    expect(worker.fetchCalls).toEqual([]);
  });

  it('does not use an entry from an unrelated cache', async () => {
    const network = response({ value: 'network' });
    const worker = createWorkerEnvironment({
      fetchResponse: network,
      initialCaches: {
        'biodiversity-offline-v17': {},
        'school-portal-v3': {
          'https://example.test/shared.js': response({ value: 'unrelated' })
        }
      }
    });
    const fetchEvent = worker.dispatch(
      'fetch',
      request('https://example.test/shared.js')
    );

    await expect(fetchEvent.response).resolves.toBe(network);
    await fetchEvent.done;
    expect(worker.fetchCalls).toHaveLength(1);
  });

  it.each([404, 500, 206])('does not cache an HTTP %s response', async (status) => {
    const url = `https://example.test/status-${status}`;
    const worker = createWorkerEnvironment({
      fetchResponse: response({ status }),
      initialCaches: { 'biodiversity-offline-v17': {} }
    });
    const fetchEvent = worker.dispatch('fetch', request(url));

    await expect(fetchEvent.response).resolves.toMatchObject({ status });
    await fetchEvent.done;
    expect(worker.cacheStores.get('biodiversity-offline-v17').has(url)).toBe(false);
  });

  it('does not intercept or cache a POST request', () => {
    const worker = createWorkerEnvironment();
    const fetchEvent = worker.dispatch(
      'fetch',
      request('https://example.test/submission', 'POST')
    );

    expect(fetchEvent.respondWithCalls).toBe(0);
    expect(fetchEvent.waited).toHaveLength(0);
    expect(worker.openCalls).toEqual([]);
    expect(worker.fetchCalls).toEqual([]);
  });

  it.each([
    'https://external.test/resource.js',
    'https://example.test.evil/resource.js'
  ])('does not cache a cross-origin GET from %s', async (url) => {
    const worker = createWorkerEnvironment({
      fetchResponse: response({ type: 'basic' }),
      initialCaches: { 'biodiversity-offline-v17': {} }
    });
    const fetchEvent = worker.dispatch('fetch', request(url));

    await fetchEvent.response;
    await fetchEvent.done;
    expect(worker.cacheStores.get('biodiversity-offline-v17').has(url)).toBe(false);
  });

  it('caches a successful same-origin GET and attaches the write to waitUntil', async () => {
    const url = 'https://example.test/new.js';
    const worker = createWorkerEnvironment({
      fetchResponse: response({ status: 200, type: 'basic' }),
      initialCaches: { 'biodiversity-offline-v17': {} }
    });
    const fetchEvent = worker.dispatch('fetch', request(url));

    expect(fetchEvent.waited).toHaveLength(1);
    await fetchEvent.response;
    await fetchEvent.done;
    expect(worker.cacheStores.get('biodiversity-offline-v17').has(url)).toBe(true);
  });

  it('returns a valid network response when the cache write rejects', async () => {
    const network = response({ status: 200, value: 'still-valid' });
    const worker = createWorkerEnvironment({
      fetchResponse: network,
      initialCaches: { 'biodiversity-offline-v17': {} },
      rejectCacheWrite: true
    });
    const fetchEvent = worker.dispatch(
      'fetch',
      request('https://example.test/cache-write-failure.js')
    );

    await expect(fetchEvent.response).resolves.toBe(network);
    await expect(fetchEvent.done).resolves.toBeDefined();
  });
});
