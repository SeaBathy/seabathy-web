// Start-up: the chart, the things drawn on it, and the buttons round it.

import { Map as ChartMap, ScaleControl, setWorkerUrl } from '../vendor/maplibre-gl.js';
import * as db from './db.js';
import * as files from './files.js';
import * as tiles from './tiles.js';
import * as offline from './offline.js';
import * as charts from './charts.js';
import * as basemap from './basemap.js';
import * as waypoints from './waypoints.js';
import * as gps from './gps.js';
import * as panels from './panels.js';
import * as terrain from './terrain.js';
import * as seabed from './seabed.js';
import * as install from './install.js';
import * as updates from './updates.js';
import { $, card, toast, wireSheet, sheetIsOpen } from './ui.js';

const HOLD_MS = 600;
const HOLD_SLOP_PX = 10;

/** Degrees and decimal minutes, as on a plotter: 20°17.123′S 148°57.456′E. */
function formatPosition(lat, lng) {
  const part = (value, positive, negative, width) => {
    const abs = Math.abs(value);
    let degrees = Math.floor(abs);
    let minutes = (abs - degrees) * 60;
    if (minutes >= 59.9995) {
      degrees += 1;
      minutes = 0;
    }
    return `${String(degrees).padStart(width, '0')}°${minutes.toFixed(3).padStart(6, '0')}′${value < 0 ? negative : positive}`;
  };
  return `${part(lat, 'N', 'S', 2)} ${part(lng, 'E', 'W', 3)}`;
}

function formatDepth(metres) {
  if (metres > 0) return `${metres.toFixed(metres < 10 ? 1 : 0)} m above the water`;
  const depth = -metres;
  return `${depth.toFixed(depth < 100 ? 1 : 0)} m`;
}

/** A finger held still on the chart adds a waypoint there (a right-click does on a computer). */
function wireHold(map) {
  let timer = 0;
  let start = null;
  let lastAdd = 0;
  const add = (lngLat) => {
    if (Date.now() - lastAdd < 1000 || sheetIsOpen()) return;
    lastAdd = Date.now();
    waypoints.addAt(lngLat.lng, lngLat.lat);
  };
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  const canvas = map.getCanvasContainer();
  canvas.addEventListener('touchstart', (event) => {
    cancel();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
    timer = setTimeout(() => {
      if (!start) return;
      const box = canvas.getBoundingClientRect();
      add(map.unproject([start.x - box.left, start.y - box.top]));
      start = null;
    }, HOLD_MS);
  }, { passive: true });
  canvas.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (start && (event.touches.length !== 1 || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > HOLD_SLOP_PX)) cancel();
  }, { passive: true });
  canvas.addEventListener('touchend', cancel, { passive: true });
  canvas.addEventListener('touchcancel', cancel, { passive: true });
  map.on('contextmenu', (event) => add(event.lngLat));
}

/** The position under the crosshair, and the depth there when a chart has one. */
function wireReadout(map) {
  let depthTimer = 0;
  let cameraTimer = 0;
  let asked = 0;
  const position = $('#readout-pos');
  const depth = $('#readout-depth');
  const showPosition = () => {
    const centre = map.getCenter().wrap();
    position.textContent = formatPosition(centre.lat, centre.lng);
  };
  const showDepth = async () => {
    const mine = ++asked;
    const centre = map.getCenter().wrap();
    const found = await charts.depthAt(map.project(map.getCenter()), centre).catch(() => null);
    if (mine !== asked) return;
    // On a contour chart the crosshair is on a line of that depth, which is all the chart says.
    depth.textContent = found ? `${formatDepth(found.depth)}${found.line ? ' line' : ''}` : '';
    depth.hidden = !found;
  };
  map.on('move', () => {
    showPosition();
    clearTimeout(depthTimer);
    depthTimer = setTimeout(showDepth, 180);
  });
  map.on('idle', showDepth);
  map.on('moveend', () => {
    clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => {
      const centre = map.getCenter().wrap();
      db.setting.set('camera', { center: [centre.lng, centre.lat], zoom: map.getZoom() }).catch(() => {});
    }, 500);
  });
  showPosition();
}

async function boot() {
  wireSheet();
  // Nothing in use that loading the page again would lose: no panel or card open, 3D closed,
  // GPS off, and no chart held only in memory.
  await updates.start(() => !sheetIsOpen() && !terrain.isOpen() && !gps.isOn() && !document.querySelector('.overlay') && !charts.list().some((c) => c.session));
  // The first start shows the whole world; after that, where the chart was left.
  const camera = await db.setting.get('camera', { center: [20, 5], zoom: 1 });
  setWorkerUrl(new URL('../vendor/maplibre-gl-worker.js', import.meta.url).href);
  tiles.install();
  const map = new ChartMap({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'sb-bg', type: 'background', paint: { 'background-color': '#0b1220' } }] },
    center: camera.center,
    zoom: camera.zoom,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    fadeDuration: 0
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ScaleControl({ unit: 'nautical', maxWidth: 110 }), 'bottom-right');

  await offline.start();
  // The 3D button comes and goes with the depth surveys on screen.
  let view3d = null;
  await charts.start(map, {
    labelFont: basemap.labelFont,
    changed: () => {
      view3d?.changed();
      basemap.refreshCredits();
    }
  });
  await waypoints.start(map);
  gps.begin(map);
  panels.begin(map);
  view3d = await terrain.start(map);
  await basemap.start(map, {
    installed: () => {
      charts.addAll();
      gps.installLayers();
    },
    message: toast,
    credits: charts.credits
  });

  $('#btn-menu').addEventListener('click', panels.openMenu);
  $('#btn-add').addEventListener('click', () => {
    const centre = map.getCenter().wrap();
    waypoints.addAt(centre.lng, centre.lat);
  });
  wireHold(map);
  wireReadout(map);
  // The credit line is short on a phone: a tap shows every credit in full.
  $('#credits').addEventListener('click', () => {
    if (document.querySelector('.overlay')) return;
    card({
      title: 'Map and depth credits', subtitle: 'Not for navigation.', paragraphs: basemap.creditParts(), dismissable: true,
      fine: 'More about each source: Menu, About.', actions: [{ id: 'ok', label: 'Close', primary: true, domId: 'credits-close' }]
    });
  });

  // For the tests, and for looking into a problem from the browser's console.
  window.seabathy = { map, charts, waypoints, offline, basemap, files, db, gps, terrain, seabed, updates, version: install.VERSION };
  document.body.classList.add('ready');

  await install.showInstallIfNeeded();
  await install.showTermsIfNeeded();
  await updates.askIfNeeded();
  updates.noteVersion(install.VERSION);
  // Ask the phone, once the app is in use, not to clear its data when space runs short.
  files.keep();
}

boot().catch((error) => {
  console.error(error);
  const fatal = $('#fatal');
  fatal.hidden = false;
  $('#fatal-text').textContent = /webgl/i.test(String(error?.message))
    ? "This browser can't draw the chart (WebGL is off or not supported)."
    : `The app couldn't start: ${error?.message || error}`;
});
