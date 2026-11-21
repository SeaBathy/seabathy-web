// Keeps the app itself on the phone so it opens with no signal. Only the app's own files are
// kept here: charts live in the app's file storage, and map tiles from other servers are either
// fetched live or saved by "Save for offline".
//
// Raise VERSION with every change to any file in FILES: that is what makes phones fetch the new copy.

const VERSION = '0.4.0';
const CACHE = `seabathy-${VERSION}`;
// Zones, names and ramps: each is kept the first time it is fetched, and stays through app
// updates. Raise the number when a file in data/ changes.
const DATA = 'seabathy-data-1';
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'css/app.css',
  'js/app.js',
  'js/areapicker.js',
  'js/backup.js',
  'js/basemap.js',
  'js/charts.js',
  'js/composite.js',
  'js/contours.js',
  'js/datafile.js',
  'js/db.js',
  'js/depth.js',
  'js/files.js',
  'js/gps.js',
  'js/gpx.js',
  'js/install.js',
  'js/marks.js',
  'js/offline.js',
  'js/overseas.js',
  'js/opfs-worker.js',
  'js/panels.js',
  'js/photos.js',
  'js/places.js',
  'js/routes.js',
  'js/seabed.js',
  'js/survey.js',
  'js/terrain.js',
  'js/tiles.js',
  'js/tools.js',
  'js/ui.js',
  'js/units.js',
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
    // A fresh copy of every file, and all from this release. While a new version is being
    // published the web host can for a moment hand out the older copy of a file under its
    // plain address. Asking with the version in the address gets round any such copy, and the
    // check below refuses a mix: a failed install is simply tried again later.
    await Promise.all(FILES.map(async (file) => {
      const response = await fetch(`${file}?v=${VERSION}`, { cache: 'reload' });
      if (!response.ok) throw new Error(`${file} answered ${response.status}`);
      await cache.put(new Request(file), response);
    }));
    const stamp = await (await cache.match('js/install.js')).text();
    if (!stamp.includes(`VERSION = '${VERSION}'`)) {
      await caches.delete(CACHE);
      throw new Error('The files on the server are from another release');
    }
    // The very first install takes over at once; an update waits until the app says to switch
    // (at its next start with automatic updates, or after a tap).
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('seabathy-') && name !== CACHE && name !== DATA) await caches.delete(name);
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
  if (url.pathname.includes('/data/')) {
    event.respondWith((async () => {
      const kept = await caches.open(DATA);
      const hit = await kept.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) await kept.put(request, response.clone());
      return response;
    })());
    return;
  }
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
