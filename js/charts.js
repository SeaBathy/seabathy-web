// The charts on the map: PMTiles files on the phone, PMTiles read from a web address, and
// GeoTIFF depth surveys. Each is drawn by what it holds: depth shapes and contour lines are
// coloured by a paint expression on their depth value, depth grids are coloured here tile by
// tile, and plain chart pictures are shown as they are.

import * as db from './db.js';
import * as files from './files.js';
import * as survey from './survey.js';
import * as offline from './offline.js';
import { handle, address, tileLat, metresPerPixel } from './tiles.js';
import { paletteById, colorAt, normalised, defaultRamp, renderDepth, MIN_SPAN_METRES } from './depth.js';

export const ANCHOR = 'sb-charts-top';
const CONTOUR_COLOUR = '#00C8B4';
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const PLAIN_FILL = '#3eb8e0';
const TILE_TYPE = { 1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif' };
/** Names a depth value goes by in vector charts, most likely first. */
const DEPTH_NAMES = [
  /^(depth|contour)$/i, /^depth_?m$/i, /^(drval1|valdco|valsou)$/i, /^(elev|elevation|ele)$/i,
  /^(z|level|value|val|height|dep|min_depth|depth_min|mindepth|lower|upper|min|max)$/i, /depth/i, /elev/i
];

const charts = [];
const archives = new Map();
const demCache = new Map();
let map = null;
let hooks = { changed() {}, labelFont: () => ['Open Sans Regular'] };

export const list = () => charts;
export const byId = (id) => charts.find((c) => c.id === id) || null;
export const tileSource = (chart) => `chart:${chart.id}`;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 13);

// ---------------------------------------------------------------- reading tiles

/** The PMTiles archive behind a chart, opened once. */
async function archive(chart) {
  if (!archives.has(chart.id)) {
    const source = chart.where === 'remote'
      ? chart.url
      : new globalThis.pmtiles.FileSource(await files.open(chart.file));
    archives.set(chart.id, new globalThis.pmtiles.PMTiles(source));
  }
  return archives.get(chart.id);
}

/** A tile's bytes as the chart holds them, or null. A web chart's saved areas are tried first. */
export async function rawTile(chart, z, x, y, signal, { savedFirst = true } = {}) {
  if (chart.where === 'remote') {
    if (savedFirst && offline.hasSaved(tileSource(chart))) {
      const saved = await db.getTile(tileSource(chart), z, x, y);
      if (saved) return saved;
    }
    if (!navigator.onLine) return null;
  }
  if (z < chart.minZoom || z > chart.maxZoom) return null;
  try {
    const tile = await (await archive(chart)).getZxy(z, x, y, signal);
    return tile?.data ?? null;
  } catch (error) {
    // Out of signal part-way, or the request was dropped as the map moved on: no tile.
    if (chart.where === 'remote' || signal?.aborted) return null;
    throw error;
  }
}

/** Depths packed into a picture tile (Terrarium or Mapbox Terrain-RGB), unpacked to metres. */
async function demTile(chart, z, x, y, signal) {
  const key = `${chart.id}/${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const bytes = await rawTile(chart, z, x, y, signal);
  if (!bytes) return null;
  const blob = new Blob([bytes]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = typeof OffscreenCanvas === 'undefined'
    ? Object.assign(document.createElement('canvas'), { width: w, height: h })
    : new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const px = context.getImageData(0, 0, w, h).data;
  const values = new Float32Array(w * h);
  const mapbox = chart.encoding === 'mapbox';
  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    if (px[p + 3] === 0) values[i] = NaN;
    else if (mapbox) values[i] = -10000 + (px[p] * 65536 + px[p + 1] * 256 + px[p + 2]) * 0.1;
    else values[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  const result = { values, w, h };
  demCache.set(key, result);
  // About 16 MB of unpacked depths at most, whatever the tile size.
  if (demCache.size > Math.max(8, Math.floor(4_000_000 / (w * h)))) demCache.delete(demCache.keys().next().value);
  return result;
}

async function demPicture(chart, z, x, y, signal) {
  const dem = await demTile(chart, z, x, y, signal);
  if (!dem) return null;
  const metres = (metresPerPixel(tileLat(y + 0.5, z), z) * 256) / dem.w;
  const pixels = renderDepth(dem.values, dem.w, dem.h, chart.ramp, { cellX: metres, cellY: metres });
  return createImageBitmap(new ImageData(pixels, dem.w, dem.h));
}

function installHandlers() {
  handle('v', async (id, z, x, y, signal) => {
    const chart = byId(id);
    const bytes = chart ? await rawTile(chart, z, x, y, signal) : null;
    if (bytes) return bytes;
    return chart?.view === 'vector' ? new Uint8Array(0) : null;
  });
  handle('d', async (id, z, x, y, signal) => {
    const chart = byId(id);
    if (!chart) return null;
    return chart.kind === 'geotiff' ? survey.renderTile(chart, z, x, y, signal) : demPicture(chart, z, x, y, signal);
  });
}

// ---------------------------------------------------------------- colours

/** The depth value of a vector feature as metres, negative down. */
function depthValue(chart) {
  const value = ['to-number', ['get', chart.depthField], 0];
  return chart.positiveDown ? ['*', -1, value] : value;
}

/** The chart's colour ramp as a paint expression over the depth value. */
function rampColour(chart) {
  const ramp = normalised(chart.ramp);
  const palette = paletteById(ramp.paletteId);
  const span = Math.max(MIN_SPAN_METRES, ramp.shallowMetres - ramp.deepMetres);
  const steps = 16;
  const stops = [];
  // Deep end first: the expression wants its input values rising.
  for (let i = 0; i <= steps; i++) {
    const position = 1 - i / steps;
    const [r, g, b] = colorAt(palette, ramp.invert ? 1 - position : position);
    stops.push(ramp.shallowMetres - position * span, `rgb(${r},${g},${b})`);
  }
  return ['interpolate', ['linear'], depthValue(chart), ...stops];
}

/** [base] where the feature should show, 0 where its depth is outside the range picked. */
function rampOpacity(chart, base) {
  const ramp = normalised(chart.ramp);
  const has = ['has', chart.depthField];
  if (ramp.showOutside) return ['case', has, base, 0];
  const value = depthValue(chart);
  return ['case', ['all', has, ['>=', value, ramp.deepMetres], ['<=', value, ramp.shallowMetres]], base, 0];
}

const sourceId = (chart) => `chart-${chart.id}`;
const isType = (...types) => ['match', ['geometry-type'], types, true, false];

/** The map layers that draw a chart, bottom first. */
function layersFor(chart) {
  const source = sourceId(chart);
  const opacity = chart.opacity ?? 1;
  const visibility = chart.visible === false ? 'none' : 'visible';
  if (chart.view !== 'vector') {
    return [{ id: `${source}-raster`, type: 'raster', source, layout: { visibility }, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } }];
  }
  const coloured = Boolean(chart.depthField);
  const out = [];
  chart.vectorLayers.forEach((layer, n) => {
    const base = { source, 'source-layer': layer.id, layout: { visibility } };
    out.push({
      ...base, id: `${source}-fill-${n}`, type: 'fill', filter: isType('Polygon', 'MultiPolygon'),
      paint: {
        'fill-color': coloured ? rampColour(chart) : PLAIN_FILL,
        'fill-opacity': coloured ? rampOpacity(chart, opacity) : opacity * 0.5,
        'fill-antialias': false
      }
    });
    out.push({
      ...base, id: `${source}-line-${n}`, type: 'line', filter: isType('LineString', 'MultiLineString'),
      paint: {
        'line-color': coloured ? rampColour(chart) : CONTOUR_COLOUR,
        'line-opacity': coloured ? rampOpacity(chart, opacity) : opacity,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.4]
      }
    });
    out.push({
      ...base, id: `${source}-point-${n}`, type: 'circle', filter: isType('Point', 'MultiPoint'),
      paint: {
        'circle-color': coloured ? rampColour(chart) : CONTOUR_COLOUR,
        'circle-opacity': coloured ? rampOpacity(chart, opacity) : opacity,
        'circle-radius': 2.5
      }
    });
    if (coloured) {
      out.push({
        ...base, id: `${source}-label-${n}`, type: 'symbol', minzoom: 11, filter: isType('LineString', 'MultiLineString'),
        layout: {
          visibility, 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-size': 11,
          'text-font': hooks.labelFont(),
          'text-field': ['to-string', ['abs', ['to-number', ['get', chart.depthField], 0]]]
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4, 'text-opacity': opacity }
      });
    }
  });
  return out;
}

function sourceFor(chart) {
  const common = { minzoom: chart.minZoom, maxzoom: chart.maxZoom, bounds: chart.bounds };
  if (chart.view === 'vector') return { type: 'vector', tiles: [address('v', chart.id)], ...common };
  if (chart.view === 'depth') return { type: 'raster', tiles: [address('d', chart.id, chart.rev || 0)], tileSize: 256, ...common };
  return { type: 'raster', tiles: [address('v', chart.id)], tileSize: 256, ...common };
}

const styleLayers = () => map.getStyle()?.layers || [];

function removeFromMap(chart) {
  const source = sourceId(chart);
  for (const layer of styleLayers()) if (layer.source === source) map.removeLayer(layer.id);
  if (map.getSource(source)) map.removeSource(source);
}

/** The layer a chart's layers go under: the next chart up the list, so a redraw keeps its place. */
function layerAbove(chart) {
  const layers = styleLayers();
  for (const next of charts.slice(charts.indexOf(chart) + 1)) {
    const first = layers.find((l) => l.source === sourceId(next));
    if (first) return first.id;
  }
  return map.getLayer(ANCHOR) ? ANCHOR : undefined;
}

function addToMap(chart) {
  removeFromMap(chart);
  // A hidden chart is taken off the chart altogether and its file is closed, so it holds no
  // memory. Showing it again opens it afresh.
  if (chart.visible === false) {
    if (chart.kind === 'geotiff') survey.close(chart.id);
    return;
  }
  map.addSource(sourceId(chart), sourceFor(chart));
  const above = layerAbove(chart);
  for (const layer of layersFor(chart)) map.addLayer(layer, above);
}

/** Puts every chart on the map again: after start-up and after each change of basemap. */
export function addAll() {
  for (const chart of charts) addToMap(chart);
}

/** A chart's colours, range, opacity or visibility changed: redraw it and remember the change. */
export async function restyle(chart, { save = true } = {}) {
  if (chart.view === 'depth') chart.rev = (chart.rev || 0) + 1;
  addToMap(chart);
  if (save && !chart.session) await db.put('charts', stored(chart));
  hooks.changed();
}

/** What is written to the database: the chart without anything only this run needs. */
function stored(chart) {
  const { session, ...rest } = chart;
  return rest;
}

// ---------------------------------------------------------------- adding and removing

function depthFieldOf(vectorLayers) {
  const names = [...new Set(vectorLayers.flatMap((l) => Object.keys(l.fields || {})))];
  for (const pattern of DEPTH_NAMES) {
    const hit = names.find((n) => pattern.test(n));
    if (hit) return hit;
  }
  return null;
}

/** Every number field in a vector chart: the choices for "depth value". */
export function numberFields(chart) {
  const out = new Set();
  for (const layer of chart.vectorLayers || []) {
    for (const [name, type] of Object.entries(layer.fields || {})) if (/number/i.test(type)) out.add(name);
  }
  if (chart.depthField) out.add(chart.depthField);
  return [...out];
}

/**
 * What to call a chart: the name written in it, unless that is a file path from the computer
 * that made it (chart tools often write one). Then the file's own name is used.
 */
function chartName(written, fileName) {
  const name = String(written || '').trim();
  const fromPath = name.split(/[\\/]/).pop().replace(/\.(mbtiles|pmtiles)$/i, '');
  const chosen = name && !/[\\/]/.test(name) ? name : fileName || fromPath;
  return (chosen || 'Chart').slice(0, 80);
}

/** Builds a chart's record from a PMTiles archive's header and notes. */
async function describePmtiles(archiveFile, base) {
  let header;
  let meta;
  try {
    header = await archiveFile.getHeader();
    meta = (await archiveFile.getMetadata()) || {};
  } catch {
    throw new Error(base.where === 'remote'
      ? "Couldn't read a PMTiles chart at that address. The server must allow range requests from other sites."
      : "This isn't a PMTiles file, or it is damaged.");
  }
  const type = TILE_TYPE[header.tileType];
  if (!type) throw new Error("This chart's tile format isn't supported.");
  const vectorLayers = (meta.vector_layers || []).map((l) => ({ id: String(l.id), fields: l.fields || {} }));
  if (type === 'mvt' && !vectorLayers.length) throw new Error("This vector chart doesn't list its layers, so it can't be drawn.");
  const encoding = /terrarium/i.test(meta.encoding || '') ? 'terrarium' : /mapbox|terrain-?rgb/i.test(meta.encoding || '') ? 'mapbox' : null;
  const valid = [header.minLon, header.minLat, header.maxLon, header.maxLat].every(Number.isFinite) && header.maxLon > header.minLon && header.maxLat > header.minLat;
  const chart = {
    id: newId(),
    kind: 'pmtiles',
    name: chartName(meta.name, base.name),
    added: Date.now(),
    tileType: type,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: valid ? [header.minLon, Math.max(-85, header.minLat), header.maxLon, Math.min(85, header.maxLat)] : [-180, -85, 180, 85],
    attribution: typeof meta.attribution === 'string' ? meta.attribution.replace(/<[^>]*>/g, '').trim().slice(0, 200) : '',
    view: type === 'mvt' ? 'vector' : encoding ? 'depth' : 'picture',
    encoding: encoding || 'terrarium',
    vectorLayers,
    depthField: type === 'mvt' ? depthFieldOf(vectorLayers) : null,
    positiveDown: null,
    ramp: defaultRamp(),
    opacity: type === 'mvt' ? 0.85 : 1,
    visible: true,
    ...base
  };
  return chart;
}

async function register(chart) {
  charts.push(chart);
  if (!chart.session) await db.put('charts', stored(chart));
  addToMap(chart);
  hooks.changed();
  return chart;
}

/** Brings in a .pmtiles file picked from the phone. [progress] is { set(fraction, text), signal }. */
export async function importPmtiles(file, progress) {
  progress.set(0, 'Checking the file…');
  const probe = await describePmtiles(new globalThis.pmtiles.PMTiles(new globalThis.pmtiles.FileSource(file)), {
    where: 'local', name: file.name.replace(/\.pmtiles$/i, ''), size: file.size
  });
  probe.file = `${probe.id}.pmtiles`;
  const kept = await files.save(probe.file, file, (done, total) =>
    progress.set(done / total, `Copying ${files.formatBytes(done)} of ${files.formatBytes(total)}`), progress.signal);
  probe.session = !kept;
  return register(probe);
}

/**
 * Brings in a GeoTIFF depth survey: one picked from the phone, or depths the app downloaded.
 * [heights] says its values are heights for certain (negative under water); [attribution] is
 * the credit to show with it.
 */
export async function importTiff(file, progress, { heights = false, attribution = '' } = {}) {
  const id = newId();
  const found = await survey.importTiff(file, id, progress, { heights });
  return register({
    id, kind: 'geotiff', where: 'local', view: 'depth', name: file.name.replace(/\.(tiff?|geotiff)$/i, '').slice(0, 80),
    added: Date.now(), size: file.size, file: found.file, gridFile: found.gridFile, bounds: found.bounds,
    minZoom: 0, maxZoom: found.maxZoom, ramp: found.ramp, tiff: found.tiff, opacity: 1, visible: true,
    attribution, session: !found.kept, rev: 0
  });
}

/** Adds a chart read from a web address as it's needed. */
export async function addRemote(url) {
  const address = url.trim();
  if (!/^https:\/\//i.test(address)) throw new Error('The address must start with https://');
  if (charts.some((c) => c.url === address)) throw new Error('That chart is already added.');
  const chart = await describePmtiles(new globalThis.pmtiles.PMTiles(address), {
    where: 'remote', url: address, name: decodeURIComponent(address.split('/').pop().split('?')[0]).replace(/\.pmtiles$/i, '')
  });
  return register(chart);
}

export async function remove(chart) {
  removeFromMap(chart);
  charts.splice(charts.indexOf(chart), 1);
  archives.delete(chart.id);
  for (const key of [...demCache.keys()]) if (key.startsWith(`${chart.id}/`)) demCache.delete(key);
  if (chart.kind === 'geotiff') survey.close(chart.id);
  if (chart.file) await files.remove(chart.file);
  if (chart.gridFile) await files.remove(chart.gridFile);
  await offline.removeSource(tileSource(chart));
  await db.remove('charts', chart.id);
  hooks.changed();
}

// ---------------------------------------------------------------- what the data says

/** Depth values seen in a vector chart's tiles now on screen, as metres negative down. */
function seenDepths(chart) {
  if (!chart.depthField) return [];
  const out = [];
  for (const layer of chart.vectorLayers) {
    for (const feature of map.querySourceFeatures(sourceId(chart), { sourceLayer: layer.id })) {
      const value = Number(feature.properties?.[chart.depthField]);
      if (Number.isFinite(value)) out.push(value);
      if (out.length >= 20000) return out;
    }
  }
  return out;
}

/**
 * A vector chart's first tiles are in: works out whether its depths are written as positive
 * numbers, and fits the colour range to them, unless either was already settled.
 */
function settle(chart) {
  if (chart.view !== 'vector' || chart.positiveDown !== null || !chart.depthField) return;
  const values = seenDepths(chart);
  if (values.length < 5) return;
  const sorted = Float64Array.from(values).sort();
  // Heights say so in their name; anything else that is mostly above zero is a sounding.
  const height = /elev|ele$|height|^z$/i.test(chart.depthField);
  chart.positiveDown = !height && sorted[Math.floor(sorted.length / 2)] > 0;
  const signed = chart.positiveDown ? Array.from(sorted, (v) => -v).sort((a, b) => a - b) : sorted;
  const deep = Math.floor(signed[Math.floor(signed.length * 0.02)]);
  const shallow = Math.min(0, Math.ceil(signed[Math.floor(signed.length * 0.98)]));
  // Fitted to the bulk of the chart; the few depths beyond it take the end colours.
  if (shallow - deep >= 1) chart.ramp = { ...chart.ramp, shallowMetres: shallow, deepMetres: deep, showOutside: true };
  restyle(chart);
}

/** The colour range that fits the chart's own depths: [shallow, deep] metres, or null. */
export function fittedRange(chart) {
  if (chart.kind === 'geotiff') return chart.tiff.fit.map((v, i) => (i === 0 ? Math.min(0, Math.ceil(v)) : Math.floor(v)));
  if (chart.view !== 'vector') return null;
  const values = seenDepths(chart).map((v) => (chart.positiveDown ? -v : v)).sort((a, b) => a - b);
  if (values.length < 5) return null;
  return [Math.min(0, Math.ceil(values[Math.floor(values.length * 0.98)])), Math.floor(values[Math.floor(values.length * 0.02)])];
}

/**
 * The depth under a point of the screen from the topmost chart that has one: { depth: metres,
 * negative down; line: true when it is the value of a contour line there, not of the seabed }.
 */
export async function depthAt(point, lngLat) {
  for (let i = charts.length - 1; i >= 0; i--) {
    const chart = charts[i];
    if (chart.visible === false) continue;
    if (chart.kind === 'geotiff') {
      const depth = await survey.depthAt(chart, lngLat.lng, lngLat.lat).catch(() => null);
      if (depth !== null) return { depth, line: false };
    } else if (chart.view === 'vector' && chart.depthField) {
      const layers = layersFor(chart).filter((l) => l.type !== 'symbol' && map.getLayer(l.id)).map((l) => l.id);
      if (!layers.length) continue;
      const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
      const hits = map.queryRenderedFeatures(box, { layers });
      // A shape under the point says the depth there; otherwise a contour line passing by.
      const area = hits.find((f) => f.geometry.type.endsWith('Polygon'));
      const hit = area || hits[0];
      const value = Number(hit?.properties?.[chart.depthField]);
      if (hit && Number.isFinite(value)) return { depth: chart.positiveDown ? -value : value, line: !area };
    }
  }
  return null;
}

export function flyTo(chart) {
  const [west, south, east, north] = chart.bounds;
  map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: Math.min(chart.maxZoom, 15), duration: 600 });
}

/** The credits of the charts now shown. */
export const credits = () => charts.filter((c) => c.visible !== false && c.attribution).map((c) => c.attribution);

/** Starts the charts: reads the saved list and gets ready to draw them. */
export async function start(theMap, theHooks) {
  map = theMap;
  hooks = { ...hooks, ...theHooks };
  installHandlers();
  const saved = (await db.all('charts')).sort((a, b) => a.added - b.added);
  const listing = await files.list();
  const present = listing && new Set(listing.map((f) => f.name));
  for (const chart of saved) {
    // A chart whose file has gone (the phone cleared the app's storage) is dropped from the
    // list. Only when the storage answered: a storage that can't be read forgets nothing.
    if (chart.where === 'local' && present && !present.has(chart.file)) {
      await db.remove('charts', chart.id);
      continue;
    }
    charts.push(chart);
  }
  // A file with no chart is a copy that was cut short (the phone closed the app part-way): it
  // only takes up space. Anything written in the last hour is left, in case it is being made now.
  if (listing) {
    const wanted = new Set(charts.flatMap((c) => [c.file, c.gridFile]).filter(Boolean));
    for (const file of listing) {
      if (!wanted.has(file.name) && Date.now() - (file.modified || 0) > ORPHAN_AGE_MS) await files.remove(file.name);
    }
  }
  map.on('sourcedata', (event) => {
    if (!event.isSourceLoaded || !event.sourceId?.startsWith('chart-')) return;
    const chart = byId(event.sourceId.slice(6));
    if (chart) settle(chart);
  });
}
