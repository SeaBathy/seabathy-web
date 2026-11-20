// The map under the charts, and the satellite picture over them. The basemap choices are the
// Android app's: OpenFreeMap's dark and street maps, ready-made map links, your own tile link,
// or none. With no internet an online basemap gives way to a blank chart and comes back when the
// connection does. Every provider's credit is shown on the map.

import * as db from './db.js';
import * as offline from './offline.js';
import { handle, address } from './tiles.js';
import { ANCHOR } from './charts.js';

export const TOP = 'sb-top';
const BACKGROUND = '#0b1220';
const OPENFREEMAP = 'OpenFreeMap © OpenMapTiles • © OpenStreetMap contributors';
const GIBS_CREDIT = "Imagery: NASA Global Imagery Browse Services (GIBS), part of NASA's ESDIS";
const gibs = (layer) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

/** The app's own lettering for depth labels, kept with the app so it works with no signal. */
const GLYPHS = `${new URL('../glyphs/', import.meta.url).href}{fontstack}/{range}.pbf`;

export const BASEMAPS = [
  { id: 'dark', label: 'Dark', detail: 'OpenFreeMap, easy on the eyes', style: 'https://tiles.openfreemap.org/styles/dark', credit: OPENFREEMAP },
  { id: 'streets', label: 'Street map', detail: 'OpenFreeMap, towns and roads', style: 'https://tiles.openfreemap.org/styles/liberty', credit: OPENFREEMAP },
  { id: 'osm', label: 'OpenStreetMap', detail: 'The standard OSM map', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', credit: '© OpenStreetMap contributors', maxZoom: 19 },
  { id: 'topo', label: 'OpenTopoMap', detail: 'Land contours and hill shading', url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', credit: 'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)', maxZoom: 17 },
  { id: 'usgs', label: 'USGS Imagery', detail: 'Aerial pictures, best over the USA', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', credit: 'USGS The National Map', maxZoom: 16 },
  { id: 'custom', label: 'Your own link', detail: 'Any map with a {z}/{x}/{y} tile link' },
  { id: 'none', label: 'None', detail: 'A blank chart: just your layers' }
];

export const SATELLITES = [
  {
    id: 'eox_s2cloudless', label: 'Sentinel-2 satellite', detail: 'Cloud-free picture of the world, 10 m detail. Can be saved offline',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    credit: 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
    maxZoom: 15, canSave: true
  },
  { id: 'gibs_true_colour_n20', label: 'Latest true colour (NOAA-20)', detail: "Yesterday or today's pass, about 250 m: water colour, clouds, river plumes", url: gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor'), credit: GIBS_CREDIT, maxZoom: 9 },
  { id: 'gibs_true_colour_n21', label: 'Latest true colour (NOAA-21)', detail: 'The same from another satellite: try it if clouds hide the first', url: gibs('VIIRS_NOAA21_CorrectedReflectance_TrueColor'), credit: GIBS_CREDIT, maxZoom: 9 }
];

export const state = {
  basemap: 'dark',
  customUrl: '',
  customCredit: '',
  satOn: false,
  satId: 'eox_s2cloudless',
  satOpacity: 0.6
};

let map = null;
let hooks = { installed() {}, message() {}, credits: () => [] };
let generation = 0;
let pendingRemote = false;
let fallback = false;
let usingRemoteStyle = false;
let watchdog = 0;

export const basemapById = (id) => BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];
export const satelliteById = (id) => SATELLITES.find((s) => s.id === id) || SATELLITES[0];
export const satelliteSource = (id) => `sat:${id}`;

/** Why a tile link won't work, or null when it will. */
export function linkError(urlTemplate) {
  const url = urlTemplate.trim();
  if (!url) return 'Enter a tile link';
  if (!/^https:\/\//i.test(url)) return 'The link must start with https://';
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) return 'The link must contain {z}, {x} and {y}';
  return null;
}

const expand = (template, z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** A short name for a tile link, so tiles saved from one link are never shown for another. */
function linkName(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** The name the saved tiles of the person's own map are kept under. */
export const customSource = () => `base:${linkName(state.customUrl)}`;

/** One tile of the person's own map from its server: bytes, or null where the server has none. */
export async function fetchCustom(z, x, y, signal) {
  const response = await fetch(expand(state.customUrl, z, x, y), { signal });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error(`The map server answered ${response.status}`);
  return response.arrayBuffer();
}

/** One satellite tile from its server: bytes, or null where the server has none. */
export async function fetchSatellite(preset, z, x, y, signal) {
  const response = await fetch(expand(preset.url, z, x, y), { signal });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error(`The map server answered ${response.status}`);
  return response.arrayBuffer();
}

/** A tile of the person's own map as the chart is given it: a saved one first, then its server; null when neither has it. */
export async function customTile(z, x, y, signal) {
  if (!state.customUrl) return null;
  if (offline.hasSaved(customSource())) {
    const saved = await db.getTile(customSource(), z, x, y);
    if (saved) return saved;
  }
  if (!navigator.onLine) return null;
  try {
    return await fetchCustom(z, x, y, signal);
  } catch {
    return null;
  }
}

/** The font the current map has for labels the app adds. */
export const labelFont = () => (usingRemoteStyle ? ['Noto Sans Regular'] : ['Open Sans Regular']);

const background = () => ({ id: 'sb-bg', type: 'background', paint: { 'background-color': BACKGROUND } });

function ownStyle(tiles = null, maxZoom = 19) {
  const style = { version: 8, glyphs: GLYPHS, sources: {}, layers: [background()] };
  if (tiles) {
    style.sources.base = { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: maxZoom };
    style.layers.push({ id: 'sb-base', type: 'raster', source: 'base' });
  }
  return style;
}

/** Invisible layers that hold everything in order: charts under the first, satellite between. */
function installAnchors() {
  for (const id of [ANCHOR, TOP]) {
    if (!map.getLayer(id)) map.addLayer({ id, type: 'background', paint: { 'background-opacity': 0 } });
  }
}

function installSatellite() {
  if (map.getLayer('sb-sat')) map.removeLayer('sb-sat');
  if (map.getSource('sb-sat')) map.removeSource('sb-sat');
  if (!state.satOn) return;
  const preset = satelliteById(state.satId);
  map.addSource('sb-sat', { type: 'raster', tiles: [address('s', preset.id)], tileSize: 256, maxzoom: preset.maxZoom });
  // Under the zones, names and ramps (layers named "sb-over-…") when any of them is on.
  const over = map.getStyle().layers.find((layer) => layer.id.startsWith('sb-over-'));
  map.addLayer({ id: 'sb-sat', type: 'raster', source: 'sb-sat', paint: { 'raster-opacity': state.satOpacity, 'raster-fade-duration': 0 } }, over ? over.id : TOP);
}

function apply(style, mine, remote) {
  clearTimeout(watchdog);
  pendingRemote = remote;
  map.once('style.load', () => {
    if (mine !== generation) return;
    clearTimeout(watchdog);
    pendingRemote = false;
    usingRemoteStyle = remote;
    installAnchors();
    installSatellite();
    hooks.installed();
    refreshCredits();
  });
  map.setStyle(style, { diff: false });
  // An online style that never arrives (a dead connection gives no error): the blank chart instead.
  if (remote) watchdog = setTimeout(() => { if (mine === generation && pendingRemote) fail(); }, 9000);
}

function fail() {
  if (fallback) return;
  fallback = true;
  hooks.message("Couldn't load the online basemap: showing your own layers. It comes back when you're connected.");
  apply(ownStyle(), ++generation, false);
}

/** Shows the chosen basemap, or the blank chart when it needs the internet and there is none. */
export function rebuild() {
  const chosen = basemapById(state.basemap);
  const mine = ++generation;
  const custom = chosen.id === 'custom' ? state.customUrl : null;
  const online = Boolean(chosen.style || chosen.url || custom);
  // The person's own map still shows with no signal where an area of it was saved.
  const kept = Boolean(custom) && offline.hasSaved(customSource());
  if (online && !navigator.onLine && !kept) {
    fallback = true;
    hooks.message('No internet: showing your own layers. The online basemap comes back when you connect.');
    apply(ownStyle(), mine, false);
    return;
  }
  fallback = false;
  if (chosen.style) apply(chosen.style, mine, true);
  else if (chosen.url) apply(ownStyle(chosen.url, chosen.maxZoom), mine, false);
  else if (custom) apply(ownStyle(address('b', 'custom', linkName(custom)), 22), mine, false);
  else apply(ownStyle(), mine, false);
}

export async function setBasemap(id) {
  if (id === 'custom' && !state.customUrl) return;
  state.basemap = id;
  await db.setting.set('basemap', id);
  rebuild();
}

export async function setCustom(url, credit) {
  state.customUrl = url.trim();
  state.customCredit = credit.trim();
  await db.setting.set('customUrl', state.customUrl);
  await db.setting.set('customCredit', state.customCredit);
  if (state.basemap === 'custom') {
    state.basemap = state.customUrl ? 'custom' : 'dark';
    await db.setting.set('basemap', state.basemap);
    rebuild();
  }
}

export async function setSatellite(change) {
  Object.assign(state, change);
  await db.setting.set('satellite', { on: state.satOn, id: state.satId, opacity: state.satOpacity });
  if ('satOpacity' in change && Object.keys(change).length === 1 && map.getLayer('sb-sat')) {
    map.setPaintProperty('sb-sat', 'raster-opacity', state.satOpacity);
    return;
  }
  installSatellite();
  refreshCredits();
}

function baseCredit() {
  if (fallback) return null;
  const chosen = basemapById(state.basemap);
  if (chosen.id !== 'custom') return chosen.credit || null;
  // A map the person added: the credit is the one they typed for it.
  return state.customCredit || 'Custom online tiles';
}

/** Every credit now due, one per map or depth layer shown. */
export const creditParts = () => [...new Set([baseCredit(), state.satOn ? satelliteById(state.satId).credit : null, ...hooks.credits()].filter(Boolean))];

/** The credit line: "Not for navigation" first, then every map now shown. */
export function refreshCredits() {
  document.getElementById('credits').textContent = ['Not for navigation', ...creditParts()].join(' • ');
}

export async function start(theMap, theHooks) {
  map = theMap;
  hooks = { ...hooks, ...theHooks };
  state.basemap = await db.setting.get('basemap', 'dark');
  state.customUrl = await db.setting.get('customUrl', '');
  state.customCredit = await db.setting.get('customCredit', '');
  const sat = await db.setting.get('satellite', null);
  if (sat) Object.assign(state, { satOn: Boolean(sat.on), satId: satelliteById(sat.id).id, satOpacity: Number(sat.opacity) || 0.6 });
  if (state.basemap === 'custom' && !state.customUrl) state.basemap = 'dark';

  handle('s', async (id, z, x, y, signal) => {
    const preset = SATELLITES.find((s) => s.id === id);
    if (!preset) return null;
    if (offline.hasSaved(satelliteSource(id))) {
      const saved = await db.getTile(satelliteSource(id), z, x, y);
      if (saved) return saved;
    }
    if (!navigator.onLine) return null;
    try {
      return await fetchSatellite(preset, z, x, y, signal);
    } catch {
      return null;
    }
  });

  handle('b', (id, z, x, y, signal) => customTile(z, x, y, signal));

  map.on('error', (event) => {
    // The online style itself failing to load: fall back to the blank chart.
    const url = event?.error?.url || '';
    const styleFailed = url.includes('openfreemap.org/styles/') || (!url && event?.error?.status === undefined);
    if (pendingRemote && styleFailed && !map.isStyleLoaded()) fail();
  });
  window.addEventListener('online', () => { if (fallback) rebuild(); });
  rebuild();
}
