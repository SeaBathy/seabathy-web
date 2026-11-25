// High detail in Australian waters when IMAS's composite can't be had (its servers closed on
// 25 November 2026): the same depths put together on the phone from the sources IMAS built its
// composite from, all published by Geoscience Australia's AusSeabed:
//
// - Geoscience Australia's national 250 m depth model (AusBathyTopo 2026) underneath,
// - its 30 m regional models over it (Great Barrier Reef, Northern Australia, Torres Strait,
//   Bass Strait, Perth),
// - the AusSeabed surveys on top (all CC BY 4.0), coarsest first, so the finest and newest win.
//
// The models and a few surveys are cut out by AusSeabed's map server (WCS); the other surveys
// are read straight from AusSeabed's public files (cloud-optimised GeoTIFFs), a part at a time.
// Each piece is fetched by the phone itself: nothing passes through SeaBathy. Nothing here touches
// the page: the page hands in what it fetches with (see build), so the tests can run all of it.

import { planGrid, resampleGeographic, resampleProjected, blendInto, fillThinGaps, fillSmallHoles, fillGaps, statsOf, writeGeoTiff, metresPerDegree, ticker } from './composite.js';
import { geographicBlock, chunks, openLevel, readWindow, NothingHere, BYTES_PER_CELL } from './overseas.js';

/** The list of sources (data/ausseabed.json): its models, its surveys and the map server's address. */
export const servers = { list: 'data/ausseabed.json' };

/** Points the list elsewhere (the tests use their own). */
export function useServer(url) {
  servers.list = url;
  list = null;
}

export const CREDITS = {
  model: 'Depths: Geoscience Australia, AusBathyTopo depth models and compilations (CC BY 4.0)',
  survey: 'Depths: AusSeabed surveys, Geoscience Australia and partners (CC BY 4.0)'
};
const WHO = "AusSeabed's server";
const STORE = "AusSeabed's data store";
/** At most this many surveys in one box: the finest and newest. */
const MAX_SURVEYS = 30;
/** The most cells one request to the map server asks for each way. */
const CHUNK = 2048;

let list = null;
/** The list of sources, fetched once with [json](url, who). */
async function sources(json) {
  if (!list) list = await json(servers.list, 'SeaBathy');
  return list;
}

const hits = (area) => (b) => b[2] > area.west && b[0] < area.east && b[3] > area.south && b[1] < area.north;

/**
 * What covers [area]: { place, wcs, models, surveys, finest } with the models coarsest first and
 * the surveys in the order they are laid (coarsest and oldest first). [json](url, who) fetches the
 * list.
 */
export async function survey(area, json) {
  const { models, surveys } = await sources(json);
  const inBox = hits(area);
  const order = { base: 0, regional: 1, compilations: 2 };
  const usedModels = models.filter((m) => inBox(m.bbox)).sort((a, b) => (order[a.g] ?? 1) - (order[b.g] ?? 1) || b.res - a.res);
  let usedSurveys = surveys.filter((s) => inBox(s.bbox) && (!s.cells?.length || s.cells.some(inBox)));
  if (usedSurveys.length > MAX_SURVEYS) {
    usedSurveys = [...usedSurveys].sort((a, b) => a.res - b.res || b.year - a.year).slice(0, MAX_SURVEYS);
  }
  usedSurveys.sort((a, b) => b.res - a.res || a.year - b.year);
  const all = [...usedModels, ...usedSurveys];
  return { place: 'Australia', wcs: list.wcs, models: usedModels, surveys: usedSurveys, finest: all.length ? Math.min(...all.map((x) => x.res)) : Infinity };
}

/** The grid for [area] from what [survey] found: as fine as the finest source, within [maxCells]. Null when nothing covers it. */
export function planFor(area, found, maxCells) {
  if (!found.models.length && !found.surveys.length) return null;
  // Always 10 m cells, as IMAS's composite is on the shelf: finer surveys are thinned to it, and
  // coarser models are drawn smoothly between their own cells instead of as big blocks.
  const finest = 10;
  const grid = planGrid(area, finest, maxCells);
  return { grid, finest, detail: Math.max(finest, grid.cell), cells: grid.cols * grid.rows, bytes: grid.cols * grid.rows * BYTES_PER_CELL };
}

const metres = (m) => (m < 1.5 ? '1 m' : m < 19.5 ? `${Math.round(m)} m` : `${Math.round(m / 5) * 5} m`);

/** The line under the box, for example "Australia, from AusSeabed: GA's 30 m model and 3 surveys, about 10 m detail. Up to about 12 MB." */
export function describe(found, plan, size) {
  const models = found.models.filter((m) => m.g !== 'compilations');
  const model = models.length ? `GA's ${metres(Math.min(...models.map((m) => m.res)))} depth model` : '';
  const c = found.models.length - models.length;
  const compiled = c ? `${c} compilation${c > 1 ? 's' : ''}` : '';
  const n = found.surveys.length;
  const surveys = n ? `${n} survey${n > 1 ? 's' : ''}` : '';
  const what = [model, compiled, surveys].filter(Boolean).join(', ');
  return `Australia, from AusSeabed: ${what}, about ${metres(plan.detail)} detail. Up to about ${size(plan.bytes)}.`;
}

/** The map server's address for [cov] over [b] (degrees), thinned to [size] [cols, rows] cells when given. */
export const wcsUrl = (base, cov, b, size = null) => `${base}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${encodeURIComponent(cov)}&format=image/tiff` +
  `&subset=Long(${b.west.toFixed(6)},${b.east.toFixed(6)})&subset=Lat(${b.south.toFixed(6)},${b.north.toFixed(6)})` +
  '&subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/4326&outputCrs=http://www.opengis.net/def/crs/EPSG/0/4326' +
  (size ? `&scalesize=i(${size[0]}),j(${size[1]})` : '');

/**
 * The projection a survey file is held in, as a converter from [lng, lat], or null for one in
 * longitude and latitude. Undefined for one this can't read. Most are UTM south zones.
 */
export function converterFor(crs, proj4) {
  const code = Number(/EPSG:(\d+)/.exec(crs || '')?.[1] || 0);
  let def = null;
  if (code === 4326 || code === 4283 || code === 7844) return null;
  if (code >= 32701 && code <= 32760) def = `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  else if (code >= 28348 && code <= 28358) def = `+proj=utm +zone=${code - 28300} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  else if (code >= 7846 && code <= 7859) def = `+proj=utm +zone=${code - 7800} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  else if (!code) {
    const cm = /central_meridian",(-?[\d.]+)/.exec(crs || '');
    const fn = /false_northing",(-?[\d.]+)/.exec(crs || '');
    const fe = /false_easting",(-?[\d.]+)/.exec(crs || '');
    const k = /scale_factor",([\d.]+)/.exec(crs || '');
    if (cm) def = `+proj=tmerc +lat_0=0 +lon_0=${cm[1]} +k=${k ? k[1] : 0.9996} +x_0=${fe ? fe[1] : 500000} +y_0=${fn ? fn[1] : 10000000} +ellps=GRS80 +units=m +no_defs`;
  }
  return def ? proj4('EPSG:4326', def).forward : undefined;
}

const clip = (a, b) => ({ west: Math.max(a.west, b[0]), south: Math.max(a.south, b[1]), east: Math.min(a.east, b[2]), north: Math.min(a.north, b[3]) });

/**
 * How far (in cells, roughly) each cell of [inside] (1 where something is, 0 where not) is from
 * the nearest cell that is not, capped at [cap]. The grid's edge doesn't count as outside.
 */
function reach(inside, cols, rows, cap) {
  const d = new Uint16Array(cols * rows);
  for (let k = 0; k < d.length; k++) d[k] = inside[k] ? cap : 0;
  const step = (k, from, cost) => { if (d[from] + cost < d[k]) d[k] = d[from] + cost; };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!d[k]) continue;
      if (i > 0) step(k, k - 1, 2);
      if (j > 0) {
        step(k, k - cols, 2);
        if (i > 0) step(k, k - cols - 1, 3);
        if (i < cols - 1) step(k, k - cols + 1, 3);
      }
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      if (!d[k]) continue;
      if (i < cols - 1) step(k, k + 1, 2);
      if (j < rows - 1) {
        step(k, k + cols, 2);
        if (i < cols - 1) step(k, k + cols + 1, 3);
        if (i > 0) step(k, k + cols - 1, 3);
      }
    }
  }
  return d;
}

/**
 * Leaves out of [values] (NaN where empty) every strip narrower than about 2 × [r] cells: the lines
 * of single ship crossings, kept where they are part of a wide area surveyed edge to edge.
 * Answers how many cells are left.
 */
function dropStrips(values, cols, rows, r) {
  const n = cols * rows;
  const inside = new Uint8Array(n);
  for (let k = 0; k < n; k++) inside[k] = values[k] === values[k] ? 1 : 0;
  // Distances are in half cells: [r] cells is 2r.
  const cap = Math.min(65535, 4 * r + 4);
  const fromEdge = reach(inside, cols, rows, cap);
  const core = new Uint8Array(n);
  for (let k = 0; k < n; k++) core[k] = fromEdge[k] >= 2 * r ? 0 : 1;
  // Back out to the strip's own edge round what is wide enough: within r cells of the core.
  const fromCore = reach(core, cols, rows, cap);
  let left = 0;
  for (let k = 0; k < n; k++) {
    if (inside[k] && fromCore[k] > 2 * r) values[k] = NaN;
    else if (inside[k]) left++;
  }
  return left;
}

/**
 * Fetches everything for [area] at [plan]'s grid and puts it together: the national model, the
 * regional models over it, then the surveys, each fading into what is under it at its edge. [net]
 * is what the page fetches with (as for overseas.build): tiff(url, who), range(...), size(...),
 * GeoTIFF, proj4, signal and progress(fraction, text). Answers { blob, credits, used, stats,
 * skipped } (skipped: surveys that couldn't be read just now).
 */
export async function build(area, found, plan, net) {
  const { grid } = plan;
  const { cols, rows } = grid;
  const n = cols * rows;
  const tick = ticker(net.signal);
  const progress = net.progress || (() => {});
  const { wcs } = found;
  const out = new Float32Array(n).fill(NaN);
  const layer = new Float32Array(n);
  const mask = new Uint8Array(n);
  const lat = (grid.south + grid.north) / 2;
  const perDeg = metresPerDegree(lat);
  const feather = Math.max(2, Math.min(16, Math.round(40 / grid.cell)));
  const thinGap = Math.max(2, Math.round(30 / grid.cell));
  const smallHole = Math.max(9, Math.round((50 / grid.cell) ** 2));
  // Interpolated models first, then what was measured, coarsest first in each: real soundings win
  // over a model, and finer ones over coarser, as in IMAS's composite.
  const groupOf = (m) => m.g || (m.res >= 100 ? 'base' : 'regional');
  const groups = [
    { id: 'base', bit: 1, pieces: found.models.filter((m) => groupOf(m) === 'base') },
    { id: 'regional', bit: 2, pieces: found.models.filter((m) => groupOf(m) === 'regional') },
    { id: 'compilations', bit: 4, pieces: found.models.filter((m) => groupOf(m) === 'compilations') },
    { id: 'surveys', bit: 8, pieces: found.surveys }
  ].filter((g) => g.pieces.length);
  const total = groups.reduce((t, g) => t + g.pieces.length, 0) + 1;
  let step = 0;
  const gave = {};
  let skipped = 0;

  // A source much coarser than the grid is drawn curved between its cells, not in flat facets.
  const smoothFor = (piece) => piece.res > grid.cell * 2;

  /** One piece from the map server into [into], at its own cells when they are about the grid's or coarser, else thinned to the grid's. */
  async function fromServer(piece, into) {
    const pad = Math.max(grid.dx, grid.dy, piece.res / perDeg.y) * 3;
    const box = clip({ west: grid.west - pad, south: grid.south - pad, east: grid.east + pad, north: grid.north + pad }, piece.bbox);
    if (!(box.east > box.west && box.north > box.south)) return 0;
    const native = piece.res >= grid.cell * 0.9;
    const cellX = native ? piece.res / perDeg.x : grid.dx;
    const cellY = native ? piece.res / perDeg.y : grid.dy;
    let got = 0;
    for (const part of chunks(box, cellX, cellY)) {
      const size = native ? null : [Math.min(CHUNK + 2, part.cols), Math.min(CHUNK + 2, part.rows)];
      const block = await geographicBlock(net.GeoTIFF, await net.tiff(wcsUrl(wcs, piece.cov, part.box, size), WHO), net.signal);
      got += await resampleGeographic(into, grid, block, part.core, tick, smoothFor(piece));
    }
    return got;
  }

  /** One file read straight from AusSeabed's files into [into], only the parts inside the box. */
  async function fromFile(piece, into) {
    const forward = converterFor(piece.crs, net.proj4);
    if (forward === undefined) return 0;
    const groundScale = forward ? 1 : perDeg.x;
    const level = await openLevel(net.GeoTIFF, piece.url, net, STORE, grid.cell, groundScale);
    return resampleProjected(into, grid, {
      width: level.width, height: level.height, bbox: level.bbox, tileHeight: level.tileHeight,
      toSource: forward ? (lng, lat2) => forward([lng, lat2]) : (lng, lat2) => [lng, lat2],
      read: readWindow(level, net.signal)
    }, { tick, smooth: smoothFor(piece) });
  }

  // The coarse national compilations hold, in many places, only the lines of single ship
  // crossings: drawn on a fine grid they are streaks across the seabed. Where one covers less
  // than this share of the box it is left out.
  const SPARSE = 0.02;
  let scratch = null;

  for (const group of groups) {
    layer.fill(NaN);
    let got = 0;
    for (const piece of group.pieces) {
      const label = group.id === 'surveys' ? `AusSeabed survey ${group.pieces.indexOf(piece) + 1} of ${group.pieces.length}: ${piece.name}` : `Geoscience Australia: ${piece.name}`;
      progress(step / total, `${label}…`);
      try {
        const read = (into) => (piece.k === 'cog' ? fromFile(piece, into) : fromServer(piece, into));
        if (group.id === 'compilations' && piece.res >= 50) {
          scratch = scratch || new Float32Array(n);
          scratch.fill(NaN);
          let some = await read(scratch);
          if (some > 0) some = dropStrips(scratch, cols, rows, Math.ceil((2.5 * piece.res) / grid.cell));
          if (some >= n * SPARSE) {
            for (let k = 0; k < n; k++) if (scratch[k] === scratch[k]) layer[k] = scratch[k];
            got += some;
          }
        } else {
          got += await read(layer);
        }
      } catch (error) {
        if (net.signal?.aborted || error?.name === 'AbortError') throw error;
        // The national model is the base: without it there is nothing to lay the rest on.
        if (group.id === 'base') throw error;
        skipped++;
        net.skip?.(piece, error);
      }
      step++;
    }
    if (got > 0 && (group.id === 'surveys' || group.id === 'compilations')) {
      // Some survey files average their empty cells into the smaller copies they keep for coarse
      // reading (a cell beside an empty one comes out hundreds of metres deep), and a few mark
      // empty cells with a number. Such depths are far below the models under them: left out.
      for (let k = 0; k < n; k++) {
        const v = layer[k];
        if (v !== v) continue;
        const under = out[k];
        if (v < -11000 || v > 9000 || (under === under && v < under - Math.max(100, Math.abs(under)))) layer[k] = NaN;
      }
    }
    if (got > 0) {
      progress(step / total, 'Putting the depths together…');
      if (group.id !== 'base') {
        await fillThinGaps(layer, cols, rows, thinGap, tick);
        await fillSmallHoles(layer, cols, rows, smallHole, tick);
      }
      gave[group.id] = await blendInto(out, layer, cols, rows, group.id === 'base' ? 0 : feather, mask, group.bit, tick);
    }
  }
  if (!Object.values(gave).some((v) => v > 0)) throw new NothingHere('AusSeabed has no depths in this box. Try the worldwide depths.');
  progress((total - 0.5) / total, 'Writing the file…');
  const empty = fillGaps(out, cols, rows, 8);
  let usedBits = 0;
  for (let k = 0; k < n; k++) usedBits |= mask[k];
  const used = groups.filter((g) => usedBits & g.bit).map((g) => g.id).reverse();
  const credits = [...new Set(used.map((id) => (id === 'surveys' ? CREDITS.survey : CREDITS.model)))];
  const blob = await writeGeoTiff(out, grid, { tick });
  return { blob, credits, used, gave, skipped, stats: { ...statsOf(out), emptyAfterFill: empty } };
}
