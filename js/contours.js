// Depth contour lines on the chart, for depth surveys: lines of equal depth with the depth
// written along them, as the 3D view has. They are worked out on the device, from the depths
// under the part of the chart on screen, each time the chart comes to rest.

import { tileLng, tileLat, tileRange, lngToTileX, latToTileY } from './tiles.js';
import * as survey from './survey.js';
import * as units from './units.js';

/** The intervals a person can pick, in metres. Auto picks one to suit the depths on screen. */
export const CHOICES = [1, 2, 5, 10, 20, 50, 100];
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
/** Auto: about this many lines at most across the depths on screen. */
const AUTO_LINES = 16;
/** Never more lines than this, whatever interval is picked: zoomed far out, a wider one is used. */
const MAX_LINES = 60;
/** The most map tiles of depths read for one screen; beyond that a coarser zoom is used. */
const MAX_TILES = 40;
/** Every other cell of a tile's depths: a quarter of the work, and the lines still follow the seabed. */
const STRIDE = 2;
const EMPTY = { type: 'FeatureCollection', features: [] };

/** A chart's contour settings: { on, metres } with metres null for Auto. */
export const settingsOf = (chart) => ({ on: false, metres: null, ...(chart.contours || {}) });

/**
 * The interval to draw for depths from [min] to [max] metres: the one [picked], or one to suit
 * that range; wider when it would make too many lines.
 */
export function stepFor(min, max, picked = null) {
  const range = Math.max(0, max - min);
  let step = picked || STEPS.find((s) => range / s <= AUTO_LINES) || STEPS[STEPS.length - 1];
  while (range / step > MAX_LINES) {
    const next = STEPS.find((s) => s > step);
    if (!next) break;
    step = next;
  }
  return step;
}

/** A contour's depth as it is written on the chart, in the unit chosen in Settings. */
export function labelFor(level, unit = units.depthUnit()) {
  const value = Math.abs(level) * unit.perMetre;
  const text = value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${level > 0 ? '+' : ''}${text} ${unit.label}`;
}

let scratch = { size: 0, link: null, seen: null };

/**
 * The contour lines of a grid of depths ([cols] to a row, NaN where there are none), one set
 * for each multiple of [step] up to [top]. Answers [{ level, lines }], each line a list of
 * [x, y] in cells; a closed line ends where it began.
 */
export function trace(values, cols, rows, step, top = Infinity) {
  const cells = cols * rows;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cells; i++) {
    const v = values[i];
    if (v !== v) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min) || !(step > 0)) return [];
  // A level L is crossed where some depths are below it and some at or above: min < L <= max.
  const first = Math.floor(min / step) + 1;
  const last = Math.min(Math.floor(max / step), Math.floor(top / step));
  if (last < first) return [];
  const segments = Array.from({ length: last - first + 1 }, () => []);

  // An edge between two cells of a row is numbered by its left cell; one between two rows, by
  // its upper cell, after all of those.
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i = r * cols + c;
      const tl = values[i];
      const tr = values[i + 1];
      const bl = values[i + cols];
      const br = values[i + cols + 1];
      if (tl !== tl || tr !== tr || bl !== bl || br !== br) continue;
      const lo = Math.min(tl, tr, bl, br);
      const hi = Math.max(tl, tr, bl, br);
      const k0 = Math.max(first, Math.floor(lo / step) + 1);
      const k1 = Math.min(last, Math.floor(hi / step));
      if (k1 < k0) continue;
      const T = i;
      const B = i + cols;
      const L = cells + i;
      const R = cells + i + 1;
      for (let k = k0; k <= k1; k++) {
        const level = k * step;
        const into = segments[k - first];
        const kind = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
        switch (kind) {
          case 1: case 14: into.push(L, B); break;
          case 2: case 13: into.push(B, R); break;
          case 3: case 12: into.push(L, R); break;
          case 4: case 11: into.push(T, R); break;
          case 6: case 9: into.push(T, B); break;
          case 7: case 8: into.push(T, L); break;
          // Two corners across from each other: the middle of the cell says which pair is joined.
          case 5:
            if ((tl + tr + bl + br) / 4 >= level) into.push(T, L, B, R);
            else into.push(T, R, L, B);
            break;
          case 10:
            if ((tl + tr + bl + br) / 4 >= level) into.push(T, R, L, B);
            else into.push(T, L, B, R);
            break;
          default: break;
        }
      }
    }
  }

  if (scratch.size !== cells) {
    scratch = { size: cells, link: new Int32Array(cells * 4).fill(-1), seen: new Uint8Array(cells * 2) };
  }
  const { link, seen } = scratch;
  const out = [];
  for (let n = 0; n < segments.length; n++) {
    const pairs = segments[n];
    if (!pairs.length) continue;
    const level = (first + n) * step;
    // Where the level crosses an edge, between the depths at its two ends.
    const point = (edge) => {
      if (edge < cells) {
        const r = Math.floor(edge / cols);
        const a = values[edge];
        return [edge - r * cols + (level - a) / (values[edge + 1] - a), r];
      }
      const i = edge - cells;
      const r = Math.floor(i / cols);
      const a = values[i];
      return [i - r * cols, r + (level - a) / (values[i + cols] - a)];
    };
    for (let s = 0; s < pairs.length; s += 2) {
      const a = pairs[s];
      const b = pairs[s + 1];
      if (link[a * 2] === -1) link[a * 2] = b; else link[a * 2 + 1] = b;
      if (link[b * 2] === -1) link[b * 2] = a; else link[b * 2 + 1] = a;
    }
    const lines = [];
    const walk = (start) => {
      const line = [];
      let before = -1;
      let at = start;
      while (at !== -1 && !seen[at]) {
        seen[at] = 1;
        line.push(point(at));
        const next = link[at * 2] !== before ? link[at * 2] : link[at * 2 + 1];
        before = at;
        at = next;
      }
      // Back at the start: a closed line.
      if (at === start && line.length > 2) line.push(line[0]);
      if (line.length > 1) lines.push(line);
    };
    // Lines with ends first (they stop at the edge of the depths), then the closed ones.
    for (let s = 0; s < pairs.length; s++) if (!seen[pairs[s]] && link[pairs[s] * 2 + 1] === -1) walk(pairs[s]);
    for (let s = 0; s < pairs.length; s++) if (!seen[pairs[s]]) walk(pairs[s]);
    for (let s = 0; s < pairs.length; s++) {
      const edge = pairs[s];
      link[edge * 2] = -1;
      link[edge * 2 + 1] = -1;
      seen[edge] = 0;
    }
    out.push({ level, lines });
  }
  return out;
}

// ---------------------------------------------------------------- on the chart

let map = null;
const attached = new Map();
const last = new Map();
const built = new Map();
let timer = 0;
let moveTimer = 0;
let running = false;
let again = false;

const sourceOf = (chart) => `contours-${chart.id}`;

/** The tiles of depths under the part of [chart] on screen, { z, x0, x1, y0, y1 }, with that part's own bounds; or null. */
function tilesOnScreen(chart) {
  const view = map.getBounds();
  const [west, south, east, north] = chart.bounds;
  // The chart may be shown a whole turn of the world away from its own longitudes.
  const turn = Math.round((map.getCenter().lng - (west + east) / 2) / 360) * 360;
  const part = [Math.max(west, view.getWest() - turn), Math.max(south, view.getSouth()), Math.min(east, view.getEast() - turn), Math.min(north, view.getNorth())];
  if (!(part[2] > part[0]) || !(part[3] > part[1])) return null;
  // The zoom the chart's own tiles are drawn at: one finer than the map's, as its tiles are 256 across.
  let z = Math.max(0, Math.min(chart.maxZoom, Math.floor(map.getZoom()) + 1));
  let range = tileRange(part, z);
  while (z > 0 && (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) > MAX_TILES) {
    z -= 1;
    range = tileRange(part, z);
  }
  return { z, ...range, part };
}

/** The depths under [tiles] as one grid: every other cell of each tile, the tiles side by side. */
async function gridOf(chart, tiles) {
  const { z, x0, x1, y0, y1 } = tiles;
  const size = survey.TILE;
  const side = size + 2;
  const per = size / STRIDE;
  const cols = (x1 - x0 + 1) * per + 1;
  const rows = (y1 - y0 + 1) * per + 1;
  const values = new Float32Array(cols * rows).fill(NaN);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(survey.elevationTile(chart, z, tx, ty).then((block) => {
        if (!block) return;
        // A tile's depths come with one cell beyond each side, so its first and last samples
        // here are its neighbours' too and the lines meet where the tiles do.
        for (let j = 0; j <= per; j++) {
          const from = j * STRIDE * side;
          const to = ((ty - y0) * per + j) * cols + (tx - x0) * per;
          for (let i = 0; i <= per; i++) {
            const v = block[from + i * STRIDE];
            if (v === v) values[to + i] = v;
          }
        }
      }));
    }
  }
  await Promise.all(jobs);
  return { values, cols, rows };
}

/** The shallowest and deepest water in the part of the grid that is on screen: [min, max] metres. */
function depthsOnScreen({ values, cols, rows }, tiles) {
  const { z, x0, y0, part } = tiles;
  const size = survey.TILE;
  const column = (lng) => Math.max(0, Math.min(cols - 1, ((lngToTileX(lng, z) - x0) * size + 0.5) / STRIDE));
  const line = (lat) => Math.max(0, Math.min(rows - 1, ((latToTileY(lat, z) - y0) * size + 0.5) / STRIDE));
  const c0 = Math.floor(column(part[0]));
  const c1 = Math.ceil(column(part[2]));
  const r0 = Math.floor(line(part[3]));
  const r1 = Math.ceil(line(part[1]));
  let min = Infinity;
  let max = -Infinity;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const v = values[r * cols + c];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // Depths only: land in a survey gets no lines, and doesn't widen the interval.
  return [min, Math.min(max, 0)];
}

/** True for a line that stays within a cell and a half each way: a speck, not a shape of the seabed. */
function isSpeck(line) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of line) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 - x0 < 1.5 && y1 - y0 < 1.5;
}

/** The contour lines of a grid of depths, every [step] metres, as map data. */
function linesOf({ values, cols, rows }, tiles, step) {
  const { z, x0, y0 } = tiles;
  const size = survey.TILE;
  const unit = units.depthUnit();
  const features = [];
  for (const { level, lines } of trace(values, cols, rows, step, 0)) {
    const properties = { label: labelFor(level, unit), major: Math.round(level / step) % 5 === 0, depth: -level };
    for (const line of lines) {
      if (line.length < 3 || isSpeck(line)) continue;
      features.push({
        type: 'Feature', properties,
        geometry: { type: 'LineString', coordinates: line.map(([gx, gy]) => [tileLng(x0 + (gx * STRIDE - 0.5) / size, z), tileLat(y0 + (gy * STRIDE - 0.5) / size, z)]) }
      });
    }
  }
  return { type: 'FeatureCollection', features, step };
}

async function update() {
  for (const chart of [...attached.values()]) {
    const tiles = tilesOnScreen(chart);
    const grid = tiles ? await gridOf(chart, tiles).catch(() => null) : null;
    if (attached.get(chart.id) !== chart) continue;
    // Auto goes by the depths on screen, so close in on a flat seabed the lines come closer.
    const [min, max] = grid ? depthsOnScreen(grid, tiles) : [0, 0];
    const step = max > min ? stepFor(min, max, settingsOf(chart).metres) : 0;
    const key = step ? `${tiles.z}/${tiles.x0}-${tiles.x1}/${tiles.y0}-${tiles.y1}/${step}/${units.state.depth}` : 'none';
    if (built.get(chart.id) === key) continue;
    const data = step ? linesOf(grid, tiles, step) : EMPTY;
    const source = map.getSource(sourceOf(chart));
    if (!source) continue;
    last.set(chart.id, data);
    built.set(chart.id, key);
    source.setData(data);
  }
}

async function run() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    await update();
  } catch { /* the chart moved on or a file could not be read: the next move tries again */ } finally {
    running = false;
    if (again) {
      again = false;
      refresh(60);
    }
  }
}

/** Works the lines out again shortly: the chart moved, or a setting changed. */
export function refresh(delay = 120) {
  if (!map || !attached.size) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

/** Starts watching the chart. */
export function begin(theMap) {
  map = theMap;
  map.on('moveend', () => refresh());
  // While the chart is being dragged, the lines follow a couple of times a second.
  map.on('move', () => {
    if (!attached.size || moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = 0;
      run();
    }, 450);
  });
  units.onChange(() => {
    built.clear();
    refresh(0);
  });
}

/** Puts a chart's contour layers on the map, under [above]. [font] is the map's label font. */
export function attach(chart, above, font) {
  detach(chart);
  if (chart.kind !== 'geotiff' || !settingsOf(chart).on || chart.visible === false) return;
  const source = sourceOf(chart);
  const opacity = chart.opacity ?? 1;
  const major = ['==', ['get', 'major'], true];
  map.addSource(source, { type: 'geojson', data: last.get(chart.id) || EMPTY });
  map.addLayer({
    id: `${source}-line`, type: 'line', source, layout: { 'line-join': 'round', 'line-cap': 'round' },
    // Every fifth line is heavier, as in the 3D view.
    paint: { 'line-color': '#05121f', 'line-opacity': ['case', major, 0.8 * opacity, 0.5 * opacity], 'line-width': ['case', major, 1.6, 0.9] }
  }, above);
  map.addLayer({
    id: `${source}-label`, type: 'symbol', source,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': font, 'text-padding': 4 },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4, 'text-opacity': opacity }
  }, above);
  attached.set(chart.id, chart);
  if (!last.has(chart.id)) built.delete(chart.id);
  refresh(0);
}

/** Takes a chart's contour layers off the map. */
export function detach(chart) {
  attached.delete(chart.id);
  // No lines on the chart: the working memory for tracing them is let go.
  if (!attached.size) scratch = { size: 0, link: null, seen: null };
  if (!map) return;
  const source = sourceOf(chart);
  for (const id of [`${source}-label`, `${source}-line`]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(source)) map.removeSource(source);
}

/** Forgets a chart that was removed. */
export function forget(id) {
  attached.delete(id);
  last.delete(id);
  built.delete(id);
}

/** The lines last drawn for a chart, as map data, or null. For the tests. */
export const dataOf = (id) => last.get(id) || null;
