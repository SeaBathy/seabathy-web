// GeoTIFF depth surveys. The file is copied into the app's storage and read a piece at a time:
// a small overview of the whole survey is kept for looking from far out, and close in the map
// tiles are read straight from the file (from its built-in overviews when it has them). The
// file never has to fit in memory. The projection table is the Desktop app's.

import * as files from './files.js';
import { setting } from './db.js';
import { loadScript } from './ui.js';
import { renderDepth, histogramOf, percentile, autoFitRamp } from './depth.js';
import { tileLng, tileLat, metresPerPixel } from './tiles.js';

/** The overview's longest side, in cells: 9 MB in memory at most. */
const GRID_MAX = 1536;
/** The most decoded source data held at once while the overview is made. */
const MAX_CHUNK_BYTES = 24 * 1024 * 1024;
/** A map tile's size, and the same with one extra cell all round so shading has no seams. */
const N = 256;
const M = N + 2;
/** The side of a map tile in cells. A tile's depths come as (TILE + 2) each way: one cell beyond each side. */
export const TILE = N;
/** A close-in tile is read from the file unless that would take more source cells than this. */
const MAX_WINDOW_CELLS = 6_000_000;
/** The same for the 3D view's grid, which is read once and may take a moment. */
const MAX_REGION_CELLS = 9_000_000;
const CACHE_TILES = 64;
const READS_AT_ONCE = 3;

async function libs() {
  await loadScript('vendor/geotiff.js');
  await loadScript('vendor/proj4.js');
  return { GeoTIFF: globalThis.GeoTIFF, proj4: globalThis.proj4 };
}

// ---------------------------------------------------------------- map projections

const GRS80 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const GEOGRAPHIC_CODES = new Set([4326, 4283, 4269, 7844, 4258, 4167, 4979, 4617, 4019]);
const lookedUp = new Map();

/** The proj4 definition for a projected EPSG code, or null when it isn't known. */
function projectedDef(code) {
  if ([3857, 3785, 900913, 102100, 102113].includes(code)) return { def: 'EPSG:3857', label: 'Web Mercator' };
  if (code >= 32601 && code <= 32660) return { def: `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`, label: `WGS84 UTM ${code - 32600}N` };
  if (code >= 32701 && code <= 32760) return { def: `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`, label: `WGS84 UTM ${code - 32700}S` };
  if (code >= 28348 && code <= 28358) return { def: `+proj=utm +zone=${code - 28300} +south ${GRS80}`, label: `GDA94 MGA ${code - 28300}` };
  if (code >= 7846 && code <= 7859) return { def: `+proj=utm +zone=${code - 7800} +south ${GRS80}`, label: `GDA2020 MGA ${code - 7800}` };
  if (code >= 26901 && code <= 26923) return { def: `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`, label: `NAD83 UTM ${code - 26900}N` };
  if (code >= 25828 && code <= 25838) return { def: `+proj=utm +zone=${code - 25800} ${GRS80}`, label: `ETRS89 UTM ${code - 25800}N` };
  if (code === 3577 || code === 9473) return { def: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GRS80}`, label: 'Australian Albers' };
  if (code === 3112 || code === 7845) return { def: `+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GRS80}`, label: 'GA Lambert' };
  if (code === 2193) return { def: `+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ${GRS80}`, label: 'NZTM 2000' };
  if (code >= 26701 && code <= 26722) return { def: `+proj=utm +zone=${code - 26700} +datum=NAD27 +units=m +no_defs`, label: `NAD27 UTM ${code - 26700}N` };
  if (code === 27700) return { def: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs', label: 'British National Grid' };
  if (code === 3035) return { def: `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${GRS80}`, label: 'ETRS89 LAEA Europe' };
  if (code === 3395) return { def: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs', label: 'World Mercator' };
  const looked = lookedUp.get(code);
  if (looked) return { def: looked, label: `EPSG:${code}` };
  return null;
}

/** A projection not in the list: asks epsg.io once and remembers the answer, so it works offline later. */
async function lookUpProjection(code, proj4) {
  if (!code || code === 32767 || projectedDef(code)) return;
  const saved = await setting.get(`epsg_${code}`);
  if (saved) {
    lookedUp.set(code, saved);
    return;
  }
  try {
    const response = await fetch(`https://epsg.io/${code}.proj4`);
    const def = response.ok ? (await response.text()).trim() : '';
    if (!def.startsWith('+')) return;
    proj4(def, 'EPSG:4326');
    lookedUp.set(code, def);
    await setting.set(`epsg_${code}`, def);
  } catch { /* offline, or a definition proj4 can't use: reported as unsupported */ }
}

/** What to save about a file's projection: { def, geographic, label } or { unsupported: label }. */
function describeCrs(keys, bbox) {
  const projected = keys.ProjectedCSTypeGeoKey;
  const geographic = keys.GeographicTypeGeoKey;
  const looksLikeDegrees = Math.abs(bbox[0]) <= 360 && Math.abs(bbox[2]) <= 360 && Math.abs(bbox[1]) <= 90 && Math.abs(bbox[3]) <= 90;
  if (projected && projected !== 32767) {
    const found = projectedDef(projected);
    if (!found) return { unsupported: `EPSG:${projected}` };
    return { def: found.def, geographic: false, label: `${found.label} (EPSG:${projected})` };
  }
  if ((geographic && GEOGRAPHIC_CODES.has(geographic)) || keys.GTModelTypeGeoKey === 2 || (!projected && looksLikeDegrees)) {
    return { def: null, geographic: true, label: geographic ? `Geographic (EPSG:${geographic})` : 'Geographic (assumed)' };
  }
  return { unsupported: 'unknown' };
}

/** Working converters for a saved projection. */
function converters(crs, proj4) {
  if (crs.geographic) {
    return { toLonLat: (x, y) => [x > 180 ? x - 360 : x, y], fromLonLat: (lng, lat) => [lng, lat] };
  }
  const converter = proj4(crs.def, 'EPSG:4326');
  return { toLonLat: (x, y) => converter.forward([x, y]), fromLonLat: (lng, lat) => converter.inverse([lng, lat]) };
}

// ---------------------------------------------------------------- reading the file

const isNoData = (v, noData) =>
  !Number.isFinite(v) || Math.abs(v) >= 1e30 || (noData !== null && Math.abs(v - noData) <= Math.abs(noData) * 1e-6 + 1e-6);

/** The file's pictures of itself, finest first: the full survey and any smaller overviews. */
async function levelsOf(tiff, first) {
  const levels = [{ index: 0, width: first.getWidth(), height: first.getHeight() }];
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    const image = await tiff.getImage(i);
    if ((image.fileDirectory.NewSubfileType || 0) & 4) continue; // a transparency mask
    if (image.getSamplesPerPixel() !== first.getSamplesPerPixel()) continue;
    if (image.getWidth() >= first.getWidth()) continue;
    levels.push({ index: i, width: image.getWidth(), height: image.getHeight() });
  }
  return levels.sort((a, b) => b.width - a.width);
}

/**
 * What a GeoTIFF is, read from its first few kilobytes: size, place, projection and overviews.
 * Throws a plain message for a file that can't be shown.
 */
async function describe(file) {
  const { GeoTIFF, proj4 } = await libs();
  let tiff;
  let first;
  try {
    tiff = await GeoTIFF.fromBlob(file);
    first = await tiff.getImage(0);
  } catch {
    throw new Error("This isn't a GeoTIFF, or the file is damaged.");
  }
  if (first.getSamplesPerPixel() >= 3) {
    throw new Error('This GeoTIFF is a picture, not depths. This version loads depth surveys only.');
  }
  let bbox;
  try {
    bbox = first.getBoundingBox();
  } catch {
    throw new Error("This TIFF doesn't say where it is, so it can't be placed on the chart.");
  }
  const keys = first.getGeoKeys() || {};
  await lookUpProjection(keys.ProjectedCSTypeGeoKey, proj4);
  const crs = describeCrs(keys, bbox);
  if (crs.unsupported) throw new Error(`This file's map projection (${crs.unsupported}) isn't supported yet.`);
  return {
    tiff, first, bbox, crs,
    width: first.getWidth(),
    height: first.getHeight(),
    noData: first.getGDALNoData(),
    levels: await levelsOf(tiff, first)
  };
}

/** The whole survey shrunk to at most [GRID_MAX] cells a side, read in strips. */
async function readOverview(info, onProgress, signal, heights = false) {
  const { tiff, width, height, levels, noData } = info;
  const scale = Math.min(1, GRID_MAX / Math.max(width, height));
  const cols = Math.max(2, Math.round(width * scale));
  const rows = Math.max(2, Math.round(height * scale));
  // The smallest built-in overview that still has the detail wanted.
  const level = [...levels].reverse().find((l) => l.width >= cols) || levels[0];
  const image = await tiff.getImage(level.index);
  let sourceRows = Math.max(1, Math.floor(MAX_CHUNK_BYTES / (level.width * 4)));
  // Whole rows of the file's own blocks at a time, so no block is unpacked twice.
  const blockRows = image.getTileHeight() || 1;
  if (sourceRows > blockRows) sourceRows -= sourceRows % blockRows;
  const outRows = Math.max(1, Math.floor((sourceRows * rows) / level.height));
  const values = new Float32Array(cols * rows);
  for (let r0 = 0; r0 < rows; r0 += outRows) {
    if (signal?.aborted) throw new Error('Cancelled');
    const r1 = Math.min(rows, r0 + outRows);
    const sy0 = Math.floor((r0 * level.height) / rows);
    const sy1 = Math.max(sy0 + 1, Math.min(level.height, Math.round((r1 * level.height) / rows)));
    const data = await image.readRasters({
      window: [0, sy0, level.width, sy1], width: cols, height: r1 - r0, samples: [0], resampleMethod: 'nearest', interleave: false
    });
    values.set(data[0], r0 * cols);
    onProgress?.(r1 / rows);
  }
  let min = Infinity;
  let max = -Infinity;
  let covered = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNoData(v, noData)) {
      values[i] = NaN;
      continue;
    }
    covered++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!covered) throw new Error('Every cell in this GeoTIFF is marked as having no data.');
  // Depths come in both sign conventions. All-positive values are soundings, positive down,
  // unless the file is known to hold heights (an island with no sea round it stays land).
  const flipped = !heights && min >= 0 && max > 0;
  if (flipped) {
    for (let i = 0; i < values.length; i++) values[i] = -values[i];
    [min, max] = [-max, -min];
  }
  return { values, cols, rows, min, max, flipped };
}

/** The survey's outline in longitude and latitude: [west, south, east, north]. */
function lonLatBounds(bbox, crs, proj4) {
  const { toLonLat } = converters(crs, proj4);
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      // The edges only: a projected rectangle's widest points lie along them.
      if (i > 0 && i < 8 && j > 0 && j < 8) continue;
      const [lng, lat] = toLonLat(bbox[0] + ((bbox[2] - bbox[0]) * i) / 8, bbox[1] + ((bbox[3] - bbox[1]) * j) / 8);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
  }
  return [west, Math.max(-85, south), east, Math.min(85, north)];
}

/**
 * Brings a GeoTIFF in: checks it, copies it into the app's storage and makes its overview.
 * Answers with what to remember about it. [progress] is { set(fraction, text), signal }.
 * [heights] says the values are heights above sea level (negative under water) for certain.
 */
export async function importTiff(file, id, progress, { heights = false } = {}) {
  const { proj4 } = await libs();
  progress.set(0, 'Checking the file…');
  const info = await describe(file);
  const fileName = `${id}.tif`;
  const kept = await files.save(fileName, file, (done, total) =>
    progress.set((0.6 * done) / total, `Copying ${files.formatBytes(done)} of ${files.formatBytes(total)}`), progress.signal);
  try {
    // From here on the saved copy is read: the picked file belongs to the picker.
    const saved = await describe(await files.open(fileName));
    progress.set(0.6, 'Reading the depths…');
    const grid = await readOverview(saved, (f) => progress.set(0.6 + 0.38 * f, 'Reading the depths…'), progress.signal, heights);
    await files.saveBytes(`${id}.grid`, new Uint8Array(grid.values.buffer), !kept);
    const bounds = lonLatBounds(saved.bbox, saved.crs, proj4);
    const midLat = (bounds[1] + bounds[3]) / 2;
    // Metres across one cell of the full survey, for how far the map may zoom in on it.
    const cell = saved.crs.geographic
      ? ((saved.bbox[2] - saved.bbox[0]) / saved.width) * 111320 * Math.cos((midLat * Math.PI) / 180)
      : (saved.bbox[2] - saved.bbox[0]) / saved.width;
    const histogram = histogramOf(grid.values);
    const fitted = histogram ? [percentile(histogram, 0.99), percentile(histogram, 0.01)] : [grid.max, grid.min];
    return {
      kept,
      file: fileName,
      gridFile: `${id}.grid`,
      bounds,
      maxZoom: Math.max(6, Math.min(20, Math.ceil(Math.log2(metresPerPixel(midLat, 0) / Math.max(0.05, cell))))),
      // The range is fitted to the bulk of the survey, so one deep hole doesn't stretch it;
      // the few depths beyond it take the end colours instead of being left out.
      ramp: { ...autoFitRamp(fitted[0], fitted[1]), showOutside: true },
      tiff: {
        width: saved.width, height: saved.height, bbox: saved.bbox, crs: saved.crs, noData: saved.noData,
        levels: saved.levels, cols: grid.cols, rows: grid.rows, min: grid.min, max: grid.max, flipped: grid.flipped,
        fit: fitted
      }
    };
  } catch (error) {
    await files.remove(fileName);
    await files.remove(`${id}.grid`);
    throw error;
  }
}

// ---------------------------------------------------------------- drawing map tiles

const opened = new Map();
const tileCache = new Map();
let reading = 0;
const queue = [];

/** The saved file and its overview, opened once and kept while the app runs. */
function open(chart) {
  if (!opened.has(chart.id)) {
    opened.set(chart.id, (async () => {
      const { GeoTIFF, proj4 } = await libs();
      const tiff = await GeoTIFF.fromBlob(await files.open(chart.file));
      const gridBytes = await (await files.open(chart.gridFile)).arrayBuffer();
      return { tiff, grid: new Float32Array(gridBytes), images: new Map(), ...converters(chart.tiff.crs, proj4) };
    })().catch((error) => {
      opened.delete(chart.id);
      throw error;
    }));
  }
  return opened.get(chart.id);
}

/** The surveys now held open in memory, by id. */
export const held = () => [...opened.keys()];

/** Forgets a survey's open file and tiles (it was deleted or hidden). */
export function close(id) {
  opened.delete(id);
  for (const key of [...tileCache.keys()]) if (key.startsWith(`${id}/`)) tileCache.delete(key);
}

async function limited(work, signal) {
  if (reading >= READS_AT_ONCE) await new Promise((resolve) => queue.push(resolve));
  reading++;
  try {
    if (signal?.aborted) throw new Error('Cancelled');
    return await work();
  } finally {
    reading--;
    queue.shift()?.();
  }
}

function remember(key, value) {
  tileCache.delete(key);
  tileCache.set(key, value);
  if (tileCache.size > CACHE_TILES) tileCache.delete(tileCache.keys().next().value);
}

/** Depth at fractional cell [col], [row] of a [cols]-wide block, between the four cells round it. */
function sample(values, cols, rows, col, row) {
  if (col < -0.5 || row < -0.5 || col > cols - 0.5 || row > rows - 0.5) return NaN;
  const c = Math.max(0, Math.min(cols - 1, col));
  const r = Math.max(0, Math.min(rows - 1, row));
  const c0 = Math.floor(c);
  const r0 = Math.floor(r);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fc = c - c0;
  const fr = r - r0;
  const a = values[r0 * cols + c0];
  const b = values[r0 * cols + c1];
  const d = values[r1 * cols + c0];
  const e = values[r1 * cols + c1];
  // At the survey's edge, or beside a gap: the nearest cell, so the edge isn't eaten away.
  if (a !== a || b !== b || d !== d || e !== e) return values[Math.round(r) * cols + Math.round(c)];
  return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
}

/**
 * Where each cell of a [cols] × [rows] block falls in the file's own coordinates; [lngAt](i)
 * and [latAt](j) give the block's columns and rows. Longitude and latitude are worked out
 * exactly; a projected file is converted on a lattice and filled in between, which is far
 * finer than a cell.
 */
function sourceCoordinates(meta, fromLonLat, lngAt, latAt, cols, rows) {
  const sx = new Float64Array(cols * rows);
  const sy = new Float64Array(cols * rows);
  if (meta.crs.geographic) {
    const lngs = Float64Array.from({ length: cols }, (_, i) => lngAt(i));
    for (let j = 0; j < rows; j++) {
      const lat = latAt(j);
      sx.set(lngs, j * cols);
      sy.fill(lat, j * cols, (j + 1) * cols);
    }
    return { sx, sy };
  }
  // A node every 32 cells or so: over a map tile that is 9 a side.
  const L = Math.max(9, Math.min(65, Math.ceil(Math.max(cols, rows) / 32) + 1));
  const nx = new Float64Array(L * L);
  const ny = new Float64Array(L * L);
  // Between cells, a column's longitude and a row's latitude run evenly enough to fill in.
  const between = (at, count, t) => {
    const i = Math.min(count - 2, Math.floor(t));
    return at(i) + (at(i + 1) - at(i)) * (t - i);
  };
  for (let b = 0; b < L; b++) {
    const lat = between(latAt, rows, (b * (rows - 1)) / (L - 1));
    for (let a = 0; a < L; a++) {
      const [px, py] = fromLonLat(between(lngAt, cols, (a * (cols - 1)) / (L - 1)), lat);
      nx[b * L + a] = px;
      ny[b * L + a] = py;
    }
  }
  for (let j = 0; j < rows; j++) {
    const v = (j * (L - 1)) / (rows - 1);
    const b0 = Math.min(L - 2, Math.floor(v));
    const fv = v - b0;
    for (let i = 0; i < cols; i++) {
      const u = (i * (L - 1)) / (cols - 1);
      const a0 = Math.min(L - 2, Math.floor(u));
      const fu = u - a0;
      const k = b0 * L + a0;
      sx[j * cols + i] = (nx[k] * (1 - fu) + nx[k + 1] * fu) * (1 - fv) + (nx[k + L] * (1 - fu) + nx[k + L + 1] * fu) * fv;
      sy[j * cols + i] = (ny[k] * (1 - fu) + ny[k + 1] * fu) * (1 - fv) + (ny[k + L] * (1 - fu) + ny[k + L + 1] * fu) * fv;
    }
  }
  return { sx, sy };
}

/**
 * The depths (metres, negative down, NaN where there are none) at the places [sx], [sy], given
 * in the file's own coordinates, [cols] to a row. They are read from the file's level that
 * suits the spacing of the places, or from the overview when that is fine enough or the read
 * would take more than [maxCells] of the file. Null when none of the places has a depth.
 */
async function readCells(chart, handle, sx, sy, cols, maxCells, signal) {
  const meta = chart.tiff;
  const rows = sx.length / cols;
  const [bx0, by0, bx1, by1] = meta.bbox;
  const spanX = bx1 - bx0;
  const spanY = by1 - by0;
  // How much of the file's own units one cell of the block covers, across and down.
  const midRow = Math.floor(rows / 2) * cols;
  const midCol = Math.floor(cols / 2);
  const pixel = Math.max(
    Math.abs(sx[midRow + cols - 1] - sx[midRow]) / (cols - 1),
    Math.abs(sy[(rows - 1) * cols + midCol] - sy[midCol]) / (rows - 1));
  const out = new Float32Array(sx.length);
  let any = false;

  // The coarsest of the file's levels that is still as fine as the block needs.
  const level = [...meta.levels].reverse().find((l) => spanX / l.width <= pixel * 1.3) || meta.levels[0];
  let window = null;
  if (!(spanX / meta.cols <= pixel * 1.3)) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < sx.length; i++) {
      if (sx[i] < minX) minX = sx[i];
      if (sx[i] > maxX) maxX = sx[i];
      if (sy[i] < minY) minY = sy[i];
      if (sy[i] > maxY) maxY = sy[i];
    }
    const c0 = Math.max(0, Math.floor(((minX - bx0) / spanX) * level.width) - 1);
    const c1 = Math.min(level.width, Math.ceil(((maxX - bx0) / spanX) * level.width) + 1);
    const r0 = Math.max(0, Math.floor(((by1 - maxY) / spanY) * level.height) - 1);
    const r1 = Math.min(level.height, Math.ceil(((by1 - minY) / spanY) * level.height) + 1);
    if (c1 <= c0 || r1 <= r0) return null;
    if ((c1 - c0) * (r1 - r0) <= maxCells) window = { c0, r0, c1, r1 };
  }

  if (window) {
    const { c0, r0, c1, r1 } = window;
    const w = c1 - c0;
    const h = r1 - r0;
    const data = await limited(async () => {
      if (!handle.images.has(level.index)) handle.images.set(level.index, await handle.tiff.getImage(level.index));
      const image = handle.images.get(level.index);
      return (await image.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false }))[0];
    }, signal);
    const values = new Float32Array(w * h);
    const sign = meta.flipped ? -1 : 1;
    for (let i = 0; i < values.length; i++) values[i] = isNoData(data[i], meta.noData) ? NaN : data[i] * sign;
    for (let i = 0; i < out.length; i++) {
      const v = sample(values, w, h, ((sx[i] - bx0) / spanX) * level.width - 0.5 - c0, ((by1 - sy[i]) / spanY) * level.height - 0.5 - r0);
      out[i] = v;
      if (v === v) any = true;
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      const v = sample(handle.grid, meta.cols, meta.rows, ((sx[i] - bx0) / spanX) * meta.cols - 0.5, ((by1 - sy[i]) / spanY) * meta.rows - 0.5);
      out[i] = v;
      if (v === v) any = true;
    }
  }
  return any ? out : null;
}

/** The depths under map tile [z, x, y] as M × M metres (negative down), or null when it's empty. */
export async function elevationTile(chart, z, x, y, signal) {
  const key = `${chart.id}/${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    const hit = tileCache.get(key);
    remember(key, hit);
    return hit;
  }
  const [west, south, east, north] = chart.bounds;
  if (tileLng(x + 1, z) < west || tileLng(x, z) > east || tileLat(y, z) < south || tileLat(y + 1, z) > north) return null;
  const handle = await open(chart);
  // One cell beyond the tile each way, so its shading meets its neighbours'.
  const { sx, sy } = sourceCoordinates(chart.tiff, handle.fromLonLat,
    (i) => tileLng(x + (i - 0.5) / N, z), (j) => tileLat(y + (j - 0.5) / N, z), M, M);
  const result = await readCells(chart, handle, sx, sy, M, MAX_WINDOW_CELLS, signal);
  remember(key, result);
  return result;
}

/**
 * The survey's depths over [bounds] ([west, south, east, north]) as a north-up block of
 * [cols] × [rows] cells, evenly spaced in longitude and latitude: the 3D view's grid. Null
 * when the survey has nothing there.
 */
export async function sampleRegion(chart, bounds, cols, rows, signal) {
  const [west, south, east, north] = bounds;
  const handle = await open(chart);
  const { sx, sy } = sourceCoordinates(chart.tiff, handle.fromLonLat,
    (i) => west + ((i + 0.5) / cols) * (east - west), (j) => north - ((j + 0.5) / rows) * (north - south), cols, rows);
  return readCells(chart, handle, sx, sy, cols, MAX_REGION_CELLS, signal);
}

/** Map tile [z, x, y] of a survey, coloured by its depth range: a picture, or null when empty. */
export async function renderTile(chart, z, x, y, signal) {
  const depths = await elevationTile(chart, z, x, y, signal);
  if (!depths) return null;
  const metres = metresPerPixel(tileLat(y + 0.5, z), z);
  const shaded = renderDepth(depths, M, M, chart.ramp, { cellX: metres, cellY: metres });
  const pixels = new Uint8ClampedArray(N * N * 4);
  for (let j = 0; j < N; j++) {
    const from = ((j + 1) * M + 1) * 4;
    pixels.set(shaded.subarray(from, from + N * 4), j * N * 4);
  }
  return createImageBitmap(new ImageData(pixels, N, N));
}

/** The survey's depth at a place, from its overview: metres (negative down), or null. */
export async function depthAt(chart, lng, lat) {
  const [west, south, east, north] = chart.bounds;
  if (lng < west || lng > east || lat < south || lat > north) return null;
  const handle = await open(chart);
  const meta = chart.tiff;
  const [px, py] = handle.fromLonLat(lng, lat);
  const v = sample(handle.grid, meta.cols, meta.rows,
    ((px - meta.bbox[0]) / (meta.bbox[2] - meta.bbox[0])) * meta.cols - 0.5,
    ((meta.bbox[3] - py) / (meta.bbox[3] - meta.bbox[1])) * meta.rows - 0.5);
  return v === v ? v : null;
}
