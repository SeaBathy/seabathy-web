// Keeps the app itself on the phone so it opens with no signal. Only the app's own files are
// kept here: charts live in the app's file storage, and map tiles from other servers are either
// fetched live or saved by "Save for offline".
//
// Raise VERSION with every change to any file in FILES: that is what makes phones fetch the new copy.

const VERSION = '0.3.2';
const CACHE = `seabathy-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'css/app.css',
  'js/app.js',
  'js/areapicker.js',
  'js/basemap.js',
  'js/charts.js',
  'js/db.js',
  'js/depth.js',
  'js/files.js',
  'js/gps.js',
  'js/gpx.js',
  'js/install.js',
  'js/offline.js',
  'js/opfs-worker.js',
  'js/panels.js',
  'js/seabed.js',
  'js/survey.js',
  'js/terrain.js',
  'js/tiles.js',
  'js/ui.js',
  'js/updates.js',
  'js/waypoints.js',
  '3d/index.html',
  '3d/terrain.css',
  '3d/main.js',
  '3d/terrain3d.js',
  '3d/imagery.js',
  '3d/chunks.js',
  '3d/contours.js',
  '3d/grid.js',
  '3d/palette.js',
  'vendor/geotiff.js',
  'vendor/maplibre-gl.css',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl-worker.js',
  'vendor/pmtiles.js',
  'vendor/proj4.js',
  'vendor/three.module.min.js',
  'vendor/three-OrbitControls.js',
  'vendor/three-CSS2DRenderer.js',
  'glyphs/Open Sans Regular/0-255.pbf',
  'glyphs/LICENSE.txt',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Straight from the server, not from the browser's own cache: a fresh copy of every file.
    await cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })));
    // The very first install takes over at once; an update waits until the app says to switch
    // (at its next start with automatic updates, or after a tap).
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('seabathy-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  // The app asks a waiting copy which version it is.
  if (event.data === 'version') event.ports[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Other servers (map tiles, web charts) and part-file requests go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (error) {
      // Opening the app at any address inside it, with no signal: the app's page.
      if (request.mode === 'navigate') {
        const page = await cache.match('index.html');
        if (page) return page;
      }
      throw error;
    }
  })());
});
