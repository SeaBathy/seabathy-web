// The 3D seabed view. The viewer itself is the Android app's (the page in 3d/), shown in a
// frame over the chart. This is the app's side of it, the part the Android app writes in
// Kotlin (terrain/Terrain3DScreen.kt): it reads the survey's depths into a grid for the
// viewer, hands over map tiles to lay on the seabed, and answers the viewer's requests: close,
// isolate a depth range, more or less detail, waypoints, the boat from GPS.

import * as survey from './survey.js';
import * as charts from './charts.js';
import * as basemap from './basemap.js';
import * as offline from './offline.js';
import * as waypoints from './waypoints.js';
import * as gps from './gps.js';
import * as db from './db.js';
import * as files from './files.js';
import { paletteById, normalised } from './depth.js';
import { el, toast, progressCard, holdScreenOn, closeSheet } from './ui.js';

/** Drawing resolution at each "lighter" level, in screen pixels per CSS pixel. */
const PIXEL_RATIOS = [2, 1.5, 1.25, 1];
const MAX_SAFETY = 3;
const MIN_DETAIL = 128;
const DEFAULT_DETAIL = 512;
/**
 * Grid cells the viewer is asked to hold. A web page isn't told how much memory the phone
 * has, so this is the Android app's figure for a mid-range phone.
 */
const CELLS = 1_000_000;
const DRAPE_SIZE = 1536;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320;
const MS_TO_KNOTS = 1.943844;
/** The most tiles "Save this area offline" fetches from the 3D view. */
const SAVE_TILES = 4000;

let map = null;
let state = null;
let detail = DEFAULT_DETAIL;
let customDrapes = [];

export const isOpen = () => state !== null;

/** The depth surveys 3D can show now: on the chart and not hidden. */
export const surveysInView = () => {
  const view = map.getBounds();
  return charts.list().filter((c) => c.kind === 'geotiff' && c.visible !== false &&
    c.bounds[0] < view.getEast() && c.bounds[2] > view.getWest() && c.bounds[1] < view.getNorth() && c.bounds[3] > view.getSouth());
};

const hex = (n) => `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
const cosMid = (b) => Math.max(0.01, Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180));

/** The most cells along the longer side the viewer is given for [bounds] at this level. */
function detailLimit(bounds) {
  const cells = CELLS / 2 ** Math.max(0, state.safety - 1);
  const wide = (bounds[2] - bounds[0]) * cosMid(bounds);
  const tall = bounds[3] - bounds[1];
  const aspect = Math.max(wide, tall) / Math.max(1e-9, Math.min(wide, tall));
  return Math.max(MIN_DETAIL, Math.floor(Math.sqrt(cells * aspect)));
}

/**
 * The survey's depths over [bounds] as a grid for the viewer, with square-ish cells in metres.
 * Depths outside [range] ({ deep, shallow }) are left out. Null when nothing there has data.
 */
async function buildGrid(bounds, range) {
  const chart = state.chart;
  const widthM = (bounds[2] - bounds[0]) * M_PER_DEG_LNG * cosMid(bounds);
  const heightM = (bounds[3] - bounds[1]) * M_PER_DEG_LAT;
  if (!(widthM > 0) || !(heightM > 0)) return null;
  const maxDim = Math.min(detail, detailLimit(bounds));
  let cols = widthM >= heightM ? maxDim : Math.max(2, Math.round((maxDim * widthM) / heightM));
  let rows = widthM >= heightM ? Math.max(2, Math.round((maxDim * heightM) / widthM)) : maxDim;
  // No point sampling much finer than the survey itself.
  const whole = chart.bounds;
  const sourceCols = (chart.tiff.width * (bounds[2] - bounds[0])) / (whole[2] - whole[0]);
  const sourceRows = (chart.tiff.height * (bounds[3] - bounds[1])) / (whole[3] - whole[1]);
  const scale = Math.min(1, Math.max((sourceCols * 2) / cols, (sourceRows * 2) / rows));
  cols = Math.max(2, Math.round(cols * scale));
  rows = Math.max(2, Math.round(rows * scale));

  const values = await survey.sampleRegion(chart, bounds, cols, rows);
  if (!values) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== v) continue;
    if (range && (v < range.deep || v > range.shallow)) {
      values[i] = NaN;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return null;
  return { bounds, cols, rows, values, min, max };
}

/** The part of a grid whose depths fall inside [range], with a little room round it; null when none do. */
function boundsWithin(grid, range) {
  let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const v = grid.values[r * grid.cols + c];
      if (v !== v || v < range.deep || v > range.shallow) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return null;
  const pad = Math.max(2, Math.round(Math.max(c1 - c0, r1 - r0) * 0.03));
  const [west, south, east, north] = grid.bounds;
  const perCol = (east - west) / grid.cols;
  const perRow = (north - south) / grid.rows;
  return [
    Math.max(west, west + (c0 - pad) * perCol), Math.max(south, north - (r1 + 1 + pad) * perRow),
    Math.min(east, west + (c1 + 1 + pad) * perCol), Math.min(north, north - (r0 - pad) * perRow)
  ];
}

// ---------------------------------------------------------------- maps to lay on the seabed

/** The Map list in the viewer: the satellite picture, other ready-made maps, then the user's own links. */
function drapeList() {
  const ready = [
    ...basemap.SATELLITES.filter((s) => s.canSave).map((s) => ({ id: s.id, label: s.label, maxzoom: s.maxZoom, group: 'default', savable: true, attribution: s.credit })),
    ...basemap.BASEMAPS.filter((b) => b.url).map((b) => ({ id: `base:${b.id}`, label: b.label, maxzoom: b.maxZoom, group: 'layer', savable: false, attribution: b.credit }))
  ];
  const own = customDrapes.map((d) => ({ id: d.id, label: d.label, maxzoom: 19, group: 'custom', savable: false, attribution: d.label }));
  return [...ready, ...own].map((d) => ({ minzoom: 0, offline: false, colour: null, bounds: null, ...d }));
}

const expand = (template, z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** One tile of a map in the list: a saved copy first for the satellite picture, then its server. */
async function drapeTile(id, z, x, y, signal) {
  const satellite = basemap.SATELLITES.find((s) => s.id === id);
  if (satellite) {
    if (offline.hasSaved(basemap.satelliteSource(id))) {
      const saved = await db.getTile(basemap.satelliteSource(id), z, x, y);
      if (saved) return saved;
    }
    if (!navigator.onLine) return null;
    return basemap.fetchSatellite(satellite, z, x, y, signal);
  }
  const url = id.startsWith('base:') ? basemap.BASEMAPS.find((b) => `base:${b.id}` === id)?.url : customDrapes.find((d) => d.id === id)?.url;
  if (!url || !navigator.onLine) return null;
  const response = await fetch(expand(url, z, x, y), { signal });
  return response.ok ? response.arrayBuffer() : null;
}

/** "Save this area offline" in the viewer: the satellite picture over the area in 3D, for use with no signal. */
async function saveOffline(id) {
  const preset = basemap.SATELLITES.find((s) => s.id === id && s.canSave);
  if (!preset || !state) return;
  const bounds = state.grid.bounds;
  // From the whole area in one tile, in to the finest zoom that keeps the save a sensible size.
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  const minZoom = Math.max(0, Math.min(preset.maxZoom, Math.floor(Math.log2(360 / span))));
  let maxZoom = minZoom;
  while (maxZoom < preset.maxZoom && offline.count(bounds, minZoom, maxZoom + 1) <= SAVE_TILES) maxZoom++;
  const progress = progressCard('Saving the satellite picture', 'Keep SeaBathy open and on screen until this finishes.');
  const letSleep = await holdScreenOn();
  try {
    const pack = await offline.download({
      source: basemap.satelliteSource(preset.id), label: `${preset.label}: ${state.chart.name}`, bounds, minZoom, maxZoom, signal: progress.signal,
      fetchTile: (z, x, y, signal) => basemap.fetchSatellite(preset, z, x, y, signal),
      onProgress: (n, of, bytes) => progress.set(n / of, `${n.toLocaleString()} of ${of.toLocaleString()} tiles · ${files.formatBytes(bytes)}`)
    });
    progress.close();
    await files.keep();
    toast(`Saved ${pack.tiles.toLocaleString()} tiles: the satellite picture of this area now works with no signal.`, 6000);
  } catch (error) {
    progress.close();
    toast(progress.signal.aborted || files.isCancel(error) ? 'Stopped. Nothing from this save was kept.'
      : files.isFull(error) ? 'The phone ran out of space. Nothing from this save was kept.' : error.message || "Couldn't save the area.", 7000);
  } finally {
    letSleep();
  }
}

// ---------------------------------------------------------------- what the viewer is told

const waypointJson = (w) => ({ id: w.id, name: w.name, color: w.color, lat: w.lat, lng: w.lng, desc: w.desc || '' });

function meta() {
  const { chart, grid } = state;
  const ramp = normalised(chart.ramp);
  const palette = paletteById(ramp.paletteId);
  const stops = palette.stops.map(hex);
  const whole = grid.bounds.every((v, i) => Math.abs(v - chart.bounds[i]) < 1e-9);
  // Where the area takes in land (downloaded depths do), 3D opens on the water alone, as the
  // chart shows it: the islands would dwarf the seabed. All of the water is kept, down to the
  // deepest. The Depth tab brings the land back.
  const land = grid.max > 0 && ramp.shallowMetres <= 0 && !state.isolated;
  const deep = land && ramp.showOutside ? Math.min(ramp.deepMetres, Math.floor(grid.min)) : ramp.deepMetres;
  return {
    name: chart.name,
    cols: grid.cols,
    rows: grid.rows,
    cellX: ((grid.bounds[2] - grid.bounds[0]) / grid.cols) * M_PER_DEG_LNG * cosMid(grid.bounds),
    cellY: ((grid.bounds[3] - grid.bounds[1]) / grid.rows) * M_PER_DEG_LAT,
    min: grid.min,
    max: grid.max,
    detail,
    detailLimit: detailLimit(grid.bounds),
    drapeMaxSize: Math.max(512, DRAPE_SIZE >> state.safety),
    safety: state.safety,
    pixelRatio: Math.min(PIXEL_RATIOS[state.safety], window.devicePixelRatio || 1),
    bounds: { west: grid.bounds[0], south: grid.bounds[1], east: grid.bounds[2], north: grid.bounds[3] },
    isolated: state.isolated,
    // Showing less than the whole survey, so "Whole layer" has something to go back to.
    partial: Boolean(state.isolated) || !whole,
    // The viewer's colours run deep to shallow; the chart's shallow to deep.
    chart: { label: palette.label, stops: ramp.invert ? stops : [...stops].reverse(), shallow: ramp.shallowMetres, deep, hide: !ramp.showOutside || land },
    waypoints: waypoints.list().map(waypointJson),
    drapes: drapeList()
  };
}

const page = () => state?.frame.contentWindow;

/** Builds a new grid and has the viewer load it; says so when there is nothing to show. */
async function rebuild(bounds, range, busyText) {
  if (!state) return;
  page()?.showBusy?.(busyText);
  const grid = await buildGrid(bounds, range).catch(() => null);
  if (!state) return;
  if (!grid) {
    page()?.showBusy?.(null);
    toast(range ? 'No data in that depth range.' : 'No depths in that area.');
    return;
  }
  state.grid = grid;
  state.isolated = range;
  page()?.showBusy?.(null);
  page()?.reloadGrid?.();
}

/** The object the viewer finds as window.parent.SeaBathy3D. */
function bridge() {
  return {
    meta: async () => meta(),
    grid: async () => state.grid.values.buffer,
    drapeTile,
    units: () => JSON.stringify({ depthPerM: 1, depthLabel: 'm', speedPerKnot: 1, speedLabel: 'kn' }),
    close,
    ready() {},
    log() {},
    noWebGL() {
      close();
      toast("This phone's browser can't draw 3D right now. Close other apps and try again.", 7000);
    },
    contextLost() {
      // The phone's graphics ran short: start the viewer again, lighter.
      if (!state) return;
      state.safety = Math.min(MAX_SAFETY, state.safety + 1);
      const { grid, isolated } = state;
      buildGrid(grid.bounds, isolated).then((lighter) => {
        if (!state) return;
        if (lighter) state.grid = lighter;
        page()?.location.reload();
      });
    },
    resetSafety() {
      if (!state) return;
      state.safety = 0;
      rebuild(state.grid.bounds, state.isolated, 'Loading terrain…').then(() => page()?.location.reload());
    },
    isolate(deep, shallow) {
      if (!state) return;
      const range = { deep: Math.min(deep, shallow), shallow: Math.max(deep, shallow) };
      const area = boundsWithin(state.grid, range);
      if (!area) toast('No data in that depth range.');
      else rebuild(area, range, 'Isolating depths…');
    },
    showAll() {
      if (state) rebuild(state.chart.bounds, null, 'Loading the whole layer…');
    },
    setDetail(value) {
      if (!state || !Number.isFinite(value)) return;
      detail = Math.max(MIN_DETAIL, value);
      db.setting.set('detail3d', detail).catch(() => {});
      rebuild(state.grid.bounds, state.isolated, 'Loading terrain…');
    },
    addWaypoint(lat, lng, depth) {
      const note = Number.isFinite(depth) ? `${depth < 0 ? `${(-depth).toFixed(1)} m deep` : `${depth.toFixed(1)} m above the water`} (from the 3D view)` : '';
      waypoints.addQuiet(lng, lat, note).then((w) => page()?.onWaypointAdded?.(waypointJson(w)));
    },
    editWaypoint(id) {
      const w = waypoints.list().find((x) => x.id === id);
      if (w) waypoints.edit(w);
    },
    startGps() {
      gps.turnOn();
      if (gps.lastFix()) sendFix(gps.lastFix());
    },
    addCustomDrape(name, url) {
      const problem = basemap.linkError(url);
      if (problem) return JSON.stringify({ error: problem });
      if (customDrapes.some((d) => d.url === url.trim())) return JSON.stringify({ error: 'That map is already in the list' });
      const added = { id: `own:${Date.now().toString(36)}`, label: (name || new URL(url).hostname).slice(0, 60), url: url.trim() };
      customDrapes.push(added);
      db.setting.set('drapes3d', customDrapes).catch(() => {});
      return JSON.stringify({ id: added.id, drapes: drapeList() });
    },
    removeCustomDrape(id) {
      customDrapes = customDrapes.filter((d) => d.id !== id);
      db.setting.set('drapes3d', customDrapes).catch(() => {});
      return JSON.stringify(drapeList());
    },
    saveOffline
  };
}

function sendFix(position) {
  const c = position.coords;
  const moving = Number.isFinite(c.speed) && c.speed > 0.5;
  page()?.updateBoat?.({
    lat: c.latitude, lng: c.longitude,
    heading: moving && Number.isFinite(c.heading) ? c.heading : null,
    knots: Number.isFinite(c.speed) ? c.speed * MS_TO_KNOTS : null,
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null
  });
}

// ---------------------------------------------------------------- opening and closing

/** The area to open in 3D: the part of the survey on screen, or all of it when most of it is. */
function areaFor(chart) {
  const view = map.getBounds();
  const [west, south, east, north] = chart.bounds;
  const part = [Math.max(west, view.getWest()), Math.max(south, view.getSouth()), Math.min(east, view.getEast()), Math.min(north, view.getNorth())];
  if (!(part[2] > part[0]) || !(part[3] > part[1])) return chart.bounds;
  const share = ((part[2] - part[0]) * (part[3] - part[1])) / ((east - west) * (north - south));
  return share > 0.8 ? chart.bounds : part;
}

/** Opens the 3D view of [chart] (a depth survey), on the part of it now on screen. */
export async function open(chart) {
  if (state || chart.kind !== 'geotiff') return;
  closeSheet();
  const holder = el('div', { id: 'view3d-holder' }, el('div', { id: 'view3d-wait', text: 'Building the 3D view…' }));
  document.body.append(holder);
  state = { chart, safety: 0, isolated: null, grid: null, frame: null, holder, stopFixes: null, stopWaypoints: null };
  const grid = await buildGrid(areaFor(chart), null).catch(() => null);
  if (!state) return;
  if (!grid) {
    close();
    toast('There are no depths in this part of the survey to show in 3D.');
    return;
  }
  state.grid = grid;
  window.SeaBathy3D = bridge();
  const frame = el('iframe', { id: 'view3d', title: '3D seabed', src: new URL('../3d/index.html', import.meta.url).href });
  state.frame = frame;
  holder.append(frame);
  state.stopFixes = gps.subscribe(sendFix);
  state.stopWaypoints = waypoints.onChange(() => page()?.setWaypointList?.(waypoints.list().map(waypointJson)));
}

export function close() {
  if (!state) return;
  state.stopFixes?.();
  state.stopWaypoints?.();
  state.holder.remove();
  state = null;
  delete window.SeaBathy3D;
  document.getElementById('btn-3d')?.focus();
}

/** The 3D button on the chart: shown while a depth survey is on screen. */
function paintButton() {
  const button = document.getElementById('btn-3d');
  button.hidden = surveysInView().length === 0;
}

export async function start(theMap) {
  map = theMap;
  detail = Number(await db.setting.get('detail3d', DEFAULT_DETAIL)) || DEFAULT_DETAIL;
  customDrapes = (await db.setting.get('drapes3d', [])) || [];
  document.getElementById('btn-3d').addEventListener('click', () => {
    // The topmost survey under the screen.
    const chart = surveysInView().at(-1);
    if (chart) open(chart);
  });
  map.on('moveend', paintButton);
  paintButton();
  return { changed: paintButton };
}
