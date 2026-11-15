// Service worker: lets the survey app open and work without signal.
//
// - The app's own files, data layers and libraries are stored on the first online visit.
//   They are fetched fresh whenever there is signal (so updates arrive), and taken from storage
//   when there is none.
// - Map tiles, fonts and icons are stored as they are viewed, or all at once with
//   "Simpan peta offline", and then served from storage.
// - Survey data is not handled here: it lives in IndexedDB (see app.js).
//
// Change APP_VERSION when the list of app files changes.
const APP_VERSION = 'v6';
const APP_CACHE = `survei-app-${APP_VERSION}`;
const TILE_CACHE = 'survei-tiles';

const APP_FILES = [
  './',
  'index.html',
  'app.js',
  'map.js',
  'dom.js',
  'excel.js',
  'app.css',
  'config.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/kecamatan.geojson',
  'data/desa.geojson',
  'data/flood_observed.geojson',
  'data/lulc_2025.png',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.mjs',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.css',
  'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs'
];

// Map hosts whose files never change at a given address: tiles, fonts and sprites.
const TILE_HOSTS = ['tiles.openfreemap.org', 'tiles.maps.eox.at'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // One file that fails (for example a library on a slow line) does not stop the rest.
    await Promise.all(APP_FILES.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('survei-app-') && name !== APP_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// Network first, with a time limit so a weak signal does not leave the page waiting; the stored
// copy is used when the network fails or is too slow.
async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const stored = await cache.match(request, { ignoreSearch: true });
    if (stored) return stored;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const stored = await cache.match(request);
  if (stored) return stored;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    // The street map's tile addresses include a version that changes every few weeks. Offline,
    // any stored version of the same tile is better than an empty map.
    const tile = /\/(\d+)\/(\d+)\/(\d+)\.(pbf|png|jpg)$/.exec(new URL(request.url).pathname);
    if (tile) {
      const suffix = `/${tile[1]}/${tile[2]}/${tile[3]}.${tile[4]}`;
      const host = new URL(request.url).host;
      const match = (await cache.keys()).find((r) => r.url.endsWith(suffix) && new URL(r.url).host === host);
      if (match) return cache.match(match);
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // uploads go straight to the network
  const url = new URL(request.url);

  if (TILE_HOSTS.includes(url.host)) {
    // Style and tile index files say which tile version is current: fresh when possible.
    const isIndex = url.pathname.endsWith('.json') && !url.pathname.includes('/sprites/') || !/\.\w+$/.test(url.pathname);
    event.respondWith(isIndex ? networkFirst(request, TILE_CACHE) : cacheFirst(request, TILE_CACHE));
    return;
  }
  if (url.host === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, APP_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, APP_CACHE));
  }
});
