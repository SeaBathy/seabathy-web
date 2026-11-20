// Depth colours for depth layers, as in the Android and Desktop apps: palettes, the colour
// range, relief shading, the renderer and the auto-fitted range. Depths are metres, negative down.

const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

export const PALETTES = [
  { id: 'rainbow', label: 'Rainbow', stops: [0xb3002d, 0xff3b30, 0xff9500, 0xffe000, 0x34c759, 0x00c8b4, 0x0a84ff, 0x1b2a6b] },
  { id: 'ocean', label: 'Ocean blues', stops: [0xd9f5ff, 0x8fe0f5, 0x3eb8e0, 0x1573b8, 0x0b3a7a, 0x04143d] },
  { id: 'chart', label: 'Nautical chart', stops: [0xfff6c9, 0xcfeaf7, 0x9cd3ef, 0x66b6e2, 0xe8f4fa, 0xffffff] },
  { id: 'viridis', label: 'Viridis', stops: [0xfde725, 0xa0da39, 0x4ac16d, 0x1fa187, 0x277f8e, 0x365c8d, 0x46327e, 0x440154] },
  { id: 'inferno', label: 'Inferno', stops: [0xfcffa4, 0xf9c932, 0xed6925, 0xbb3754, 0x781c6d, 0x320a5e, 0x000004] },
  { id: 'reef', label: 'Reef contrast', stops: [0xffffff, 0xffd166, 0x06d6a0, 0x118ab2, 0x073b4c] },
  { id: 'grayscale', label: 'Greyscale', stops: [0xf5f5f5, 0x9a9a9a, 0x3c3c3c, 0x000000] }
];

export const paletteById = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];

/** Slope colours, as the 3D view's: flat (blue) through moderate (yellow) to steep (red). */
export const SLOPE_PALETTE = { id: 'slope', label: 'Slope', stops: [0x173880, 0x149e9e, 0xf5d642, 0xf27321, 0xc7141a] };
export const DEFAULT_SLOPE_MAX = 20;
/** The angle drawn fully red, as the 3D view offers it. */
export const SLOPE_MAXES = [[5, '5° (gentle seabeds)'], [10, '10°'], [20, '20°'], [35, '35°'], [60, '60° (cliffs only)']];

/** Water shallower than the depth picked in Settings is marked in this red. */
export const SHALLOW_RED = [229, 20, 30];
const SHALLOW_EDGE = [255, 255, 255];

/**
 * The colour of the shallow-water stripes at a pixel, or null between them. They run on the
 * slant: three pixels of red and one of white in every eight, so they show on any colour,
 * red included. Eight divides a tile's width, so they run on from one tile to the next.
 */
export function shallowStripe(x, y) {
  const at = (x + y) & 7;
  return at < 3 ? SHALLOW_RED : at === 3 ? SHALLOW_EDGE : null;
}
let shallowMark = 0;

/** Marks water shallower than [metres] with red stripes on every depth layer; 0 for none. */
export function setShallowMark(metres) {
  shallowMark = Number.isFinite(metres) && metres > 0 ? metres : 0;
}

export const getShallowMark = () => shallowMark;

/** The palette at [position] (0 = shallow end, 1 = deep end), as [r, g, b]. */
export function colorAt(palette, position) {
  const stops = palette.stops;
  const scaled = Math.min(1, Math.max(0, position)) * (stops.length - 1);
  const lower = Math.min(Math.floor(scaled), stops.length - 2);
  const t = scaled - lower;
  const a = hex(stops[lower]);
  const b = hex(stops[lower + 1]);
  return [0, 1, 2].map((c) => Math.min(255, Math.max(0, Math.trunc(a[c] + (b[c] - a[c]) * t))));
}

const LOOKUP_SIZE = 512;
const lookups = new Map();

function lookupTable(id) {
  if (lookups.has(id)) return lookups.get(id);
  const palette = id === SLOPE_PALETTE.id ? SLOPE_PALETTE : paletteById(id);
  const table = new Uint8Array(LOOKUP_SIZE * 3);
  for (let i = 0; i < LOOKUP_SIZE; i++) table.set(colorAt(palette, i / (LOOKUP_SIZE - 1)), i * 3);
  lookups.set(id, table);
  return table;
}

// ------------------------------------------------------------------ the colour range

export const DEFAULT_PALETTE_ID = 'rainbow';
export const DEFAULT_SHALLOW_METRES = -6.0;
export const DEFAULT_DEEP_METRES = -100.0;
export const DEFAULT_HILLSHADE_EXAGGERATION = 0.6;
export const MIN_HILLSHADE_EXAGGERATION = 0.0;
export const MAX_HILLSHADE_EXAGGERATION = 5.0;
export const MIN_SPAN_METRES = 0.1;

export function defaultRamp() {
  return {
    paletteId: DEFAULT_PALETTE_ID,
    shallowMetres: DEFAULT_SHALLOW_METRES,
    deepMetres: DEFAULT_DEEP_METRES,
    invert: false,
    showOutside: false,
    hillshadeExaggeration: DEFAULT_HILLSHADE_EXAGGERATION,
    // 'depth', or 'slope': steep seabed in red up to slopeMax degrees, whatever its depth.
    colourBy: 'depth',
    slopeMax: DEFAULT_SLOPE_MAX
  };
}

/** Shallow is always the surface-most (larger) value. */
export function normalised(ramp) {
  const r = { ...defaultRamp(), ...ramp };
  if (r.shallowMetres >= r.deepMetres) return r;
  return { ...r, shallowMetres: r.deepMetres, deepMetres: r.shallowMetres };
}

export const coerceHillshade = (v) => Math.min(MAX_HILLSHADE_EXAGGERATION, Math.max(MIN_HILLSHADE_EXAGGERATION, v));

/**
 * Where [value] falls on the ramp, 0 (shallow end) to 1 (deep end), or null
 * to leave the cell clear. Depths outside the range are hidden unless
 * showOutside is on: then they take the nearest end's colour, and only dry
 * land is left clear (when the range is all water).
 */
export function rampPosition(value, ramp, span = Math.max(MIN_SPAN_METRES, ramp.shallowMetres - ramp.deepMetres)) {
  const position = (ramp.shallowMetres - value) / span;
  if (!ramp.showOutside) return position >= 0 && position <= 1 ? position : null;
  if (value > 0 && ramp.shallowMetres <= 0) return null;
  return Math.min(1, Math.max(0, position));
}

// ------------------------------------------------------------------ relief shading

const LIGHT_X = -0.5;
const LIGHT_Y = 0.5;
const LIGHT_Z = 0.70710678;
const AMBIENT = 0.45;
const DIRECT = 0.75;
const MAX_BRIGHTNESS = 1.15;
export const EXAGGERATION_PER_STRENGTH = 5.0;

/**
 * A brightness multiplier per cell (around 1; darker on slopes facing away
 * from a north-west sun), or null when [strength] is 0. Cell sizes in metres.
 */
export function reliefShade(values, cols, rows, cellX, cellY, strength) {
  if (strength <= 0 || cols < 2 || rows < 2 || cellX <= 0 || cellY <= 0) return null;
  const z = strength * EXAGGERATION_PER_STRENGTH;
  const out = new Float32Array(cols * rows).fill(1);
  for (let r = 0; r < rows; r++) {
    const up = Math.max(0, r - 1) * cols;
    const down = Math.min(rows - 1, r + 1) * cols;
    const here = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = values[here + c];
      if (Number.isNaN(v)) continue;
      // Missing neighbours fall back to this cell, so no-data edges stay flat-lit.
      const or = (x) => (Number.isNaN(x) ? v : x);
      const left = or(values[here + Math.max(0, c - 1)]);
      const right = or(values[here + Math.min(cols - 1, c + 1)]);
      const north = or(values[up + c]);
      const south = or(values[down + c]);
      const dzdx = ((right - left) / (2 * cellX)) * z;
      const dzdy = ((north - south) / (2 * cellY)) * z;
      const lambert = (-dzdx * LIGHT_X - dzdy * LIGHT_Y + LIGHT_Z) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      out[here + c] = Math.min(MAX_BRIGHTNESS, AMBIENT + DIRECT * Math.max(0, lambert));
    }
  }
  return out;
}

/**
 * The seabed's slope at each cell in degrees (0 flat, 90 a wall), from the cells either side of
 * it. Cell sizes in metres. NaN where there is no depth.
 */
export function slopeDegrees(values, cols, rows, cellX, cellY) {
  const out = new Float32Array(cols * rows).fill(NaN);
  if (cols < 2 || rows < 2 || !(cellX > 0) || !(cellY > 0)) return out;
  const has = (i) => values[i] === values[i];
  for (let r = 0; r < rows; r++) {
    const here = r * cols;
    for (let c = 0; c < cols; c++) {
      const i = here + c;
      if (!has(i)) continue;
      // The neighbour each side where there is one with a depth, else this cell itself.
      const left = c > 0 && has(i - 1) ? i - 1 : i;
      const right = c < cols - 1 && has(i + 1) ? i + 1 : i;
      const up = r > 0 && has(i - cols) ? i - cols : i;
      const down = r < rows - 1 && has(i + cols) ? i + cols : i;
      const dzdx = right > left ? (values[right] - values[left]) / ((right - left) * cellX) : 0;
      const dzdy = down > up ? (values[down] - values[up]) / (((down - up) / cols) * cellY) : 0;
      out[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

/**
 * Colours for a grid of depths (north-up rows), as RGBA bytes: by depth, or by slope when the
 * ramp says so. Water shallower than [shallow] metres gets red stripes over it, whatever the
 * colours and the range.
 */
export function renderDepth(values, cols, rows, rampIn, { cellX, cellY, shade, shallow = shallowMark } = {}) {
  const ramp = normalised(rampIn);
  const bySlope = ramp.colourBy === 'slope' && cellX > 0 && cellY > 0;
  const lookup = lookupTable(bySlope ? SLOPE_PALETTE.id : ramp.paletteId);
  const slopes = bySlope ? slopeDegrees(values, cols, rows, cellX, cellY) : null;
  const steepest = ramp.slopeMax > 0 ? ramp.slopeMax : DEFAULT_SLOPE_MAX;
  const span = Math.max(MIN_SPAN_METRES, ramp.shallowMetres - ramp.deepMetres);
  const light = shade === undefined ? reliefShade(values, cols, rows, cellX, cellY, ramp.hillshadeExaggeration) : shade;
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const v = values[i];
      if (Number.isNaN(v)) continue;
      const stripe = shallow > 0 && v <= 0 && v > -shallow ? shallowStripe(c, r) : null;
      if (stripe) {
        out[i * 4] = stripe[0];
        out[i * 4 + 1] = stripe[1];
        out[i * 4 + 2] = stripe[2];
        out[i * 4 + 3] = 255;
        continue;
      }
      let position = rampPosition(v, ramp, span);
      if (position === null) continue;
      if (bySlope) position = Math.min(1, slopes[i] / steepest);
      else if (ramp.invert) position = 1 - position;
      const k = Math.min(LOOKUP_SIZE - 1, Math.max(0, Math.trunc(position * (LOOKUP_SIZE - 1)))) * 3;
      const b = light ? light[i] : 1;
      out[i * 4] = Math.min(255, Math.trunc(lookup[k] * b));
      out[i * 4 + 1] = Math.min(255, Math.trunc(lookup[k + 1] * b));
      out[i * 4 + 2] = Math.min(255, Math.trunc(lookup[k + 2] * b));
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** The ramp's colours left to right (shallow to deep, or reversed; flat to steep for slope), for a legend. */
export function drawLegend(canvas, rampIn) {
  const ramp = normalised(rampIn);
  const bySlope = ramp.colourBy === 'slope';
  const palette = bySlope ? SLOPE_PALETTE : paletteById(ramp.paletteId);
  const ctx = canvas.getContext('2d');
  for (let x = 0; x < canvas.width; x++) {
    let position = x / Math.max(1, canvas.width - 1);
    if (ramp.invert && !bySlope) position = 1 - position;
    const [r, g, b] = colorAt(palette, position);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
}

// ------------------------------------------------------------------ auto-fit

export const HISTOGRAM_BINS = 1000;
const FIT_TAIL = 0.01;

/** How a layer's depths are spread: counts in equal bins from lowest to highest. */
export function histogramOf(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return null;
  const counts = new Float64Array(HISTOGRAM_BINS);
  const scale = HISTOGRAM_BINS / (hi - lo);
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    counts[Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.trunc((v - lo) * scale)))]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return { lowest: lo, highest: hi, counts, total };
}

/** The depth below which [fraction] of the layer lies. */
export function percentile(h, fraction) {
  const target = Math.min(1, Math.max(0, fraction)) * h.total;
  const width = (h.highest - h.lowest) / h.counts.length;
  let seen = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const next = seen + h.counts[i];
    if (next >= target && h.counts[i] > 0) {
      const within = (target - seen) / h.counts[i];
      return h.lowest + (i + Math.min(1, Math.max(0, within))) * width;
    }
    seen = next;
  }
  return h.highest;
}

/** The share (0..1) of the layer's depths between [a] and [b], either order. */
export function fractionWithin(h, a, b) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const width = (h.highest - h.lowest) / h.counts.length;
  let inside = 0;
  for (let i = 0; i < h.counts.length; i++) {
    if (!h.counts[i]) continue;
    const lo = h.lowest + i * width;
    const overlap = Math.max(0, Math.min(to, lo + width) - Math.max(from, lo));
    inside += h.counts[i] * (overlap / width);
  }
  return Math.min(1, Math.max(0, inside / h.total));
}

/** A colour range for the bulk of the survey (one deep hole doesn't stretch it), in whole metres. */
export function fitRange(shallowest, deepest, histogram = null) {
  if (histogram) {
    const d = percentile(histogram, FIT_TAIL);
    const s = percentile(histogram, 1 - FIT_TAIL);
    if (Number.isFinite(d) && Number.isFinite(s) && s - d >= 1) return fitRange(s, d);
  }
  const deep = Math.floor(deepest);
  let shallow = Math.ceil(shallowest);
  if (deep < 0) shallow = Math.min(shallow, 0);
  return [shallow, deep];
}

/** A new layer's starting ramp: its own data's range, rounded to whole metres. */
export function autoFitRamp(shallowest, deepest) {
  const [shallow, deep] = fitRange(shallowest, deepest);
  if (!Number.isFinite(shallow) || !Number.isFinite(deep) || shallow - deep < 1) return defaultRamp();
  return { ...defaultRamp(), shallowMetres: shallow, deepMetres: deep };
}
