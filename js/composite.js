// Depths from several sources put together into one grid in longitude and latitude, and
// written out as a GeoTIFF that the app then keeps like any other depth download. High detail
// outside Australia is made this way: the worldwide GMRT depths underneath, and the finer
// sources on top where they have data. Nothing here touches the page, so the tests run it as
// it is, and the long loops stop now and then to let the page draw.

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320;
const RAD = Math.PI / 180;
const TILE = 256;

/** Metres in a degree of longitude and of latitude at [lat]. */
export const metresPerDegree = (lat) => ({ x: M_PER_DEG_LNG * Math.cos(lat * RAD), y: M_PER_DEG_LAT });

/**
 * A pause now and then: answers a function to await between pieces of work, which lets the page
 * draw every [everyMs] and stops the work when [signal] is aborted.
 */
export function ticker(signal = null, everyMs = 30) {
  const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
  let last = now();
  return async () => {
    if (signal?.aborted) throw new Error('Cancelled');
    if (now() - last < everyMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    last = now();
    if (signal?.aborted) throw new Error('Cancelled');
  };
}
const noPause = async () => {};

/**
 * The grid for [area] ({ west, south, east, north }, degrees) with cells about [detail] metres
 * square, made coarser when that would be more than [maxCells] cells, and never so coarse that
 * the longer side has fewer than [minSide] cells. [cell] is the grid's spacing in metres.
 */
export function planGrid(area, detail, maxCells, minSide = 256) {
  const { x, y } = metresPerDegree((area.south + area.north) / 2);
  const widthM = (area.east - area.west) * x;
  const heightM = (area.north - area.south) * y;
  let cell = Math.max(detail, Math.sqrt((widthM * heightM) / maxCells));
  cell = Math.min(cell, Math.max(widthM, heightM) / minSide);
  let cols;
  let rows;
  for (;;) {
    cols = Math.max(2, Math.round(widthM / cell));
    rows = Math.max(2, Math.round(heightM / cell));
    if (cols * rows <= maxCells) break;
    cell *= 1.002;
  }
  return {
    west: area.west, south: area.south, east: area.east, north: area.north, cols, rows,
    dx: (area.east - area.west) / cols, dy: (area.north - area.south) / rows,
    cell: Math.max(widthM / cols, heightM / rows)
  };
}

/** The middle of the grid's cell in column [i], and in row [j] (rows run north to south). */
export const lngOf = (grid, i) => grid.west + (i + 0.5) * grid.dx;
export const latOf = (grid, j) => grid.north - (j + 0.5) * grid.dy;

/**
 * The value at fractional cell [col], [row] of a [cols] × [rows] block, between the four cells
 * round it; beside a gap or at the edge, the nearest cell. NaN outside the block.
 */
export function sample(values, cols, rows, col, row) {
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
  if (a !== a || b !== b || d !== d || e !== e) return values[Math.round(r) * cols + Math.round(c)];
  return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
}

/** Catmull-Rom weights for the four cells round a point [t] (0..1) of the way between the middle two. */
const cubicWeights = (t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
};

/**
 * As [sample], but curved through the sixteen cells round the point, so a coarse model drawn on
 * a much finer grid comes out smooth instead of in flat facets. Beside a gap or an edge, as
 * [sample].
 */
export function sampleSmooth(values, cols, rows, col, row) {
  if (col < 1 || row < 1 || col > cols - 3 || row > rows - 3) return sample(values, cols, rows, col, row);
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const wx = cubicWeights(col - c0);
  const wy = cubicWeights(row - r0);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const base = (r0 - 1 + j) * cols + c0 - 1;
    let line = 0;
    for (let i = 0; i < 4; i++) {
      const v = values[base + i];
      if (v !== v) return sample(values, cols, rows, col, row);
      line += v * wx[i];
    }
    sum += line * wy[j];
  }
  return sum;
}

/**
 * Puts a block of depths held in longitude and latitude onto the grid. [src] is { values, cols,
 * rows, west, north, dx, dy } (its outer edges and cell size, NaN where it has nothing), and only
 * the grid's cells whose middles are inside [core] ({ west, south, east, north }, the whole
 * block when left out) are taken from it. Answers how many cells got a depth.
 */
export async function resampleGeographic(layer, grid, src, core = null, tick = noPause, smooth = false) {
  const at = smooth ? sampleSmooth : sample;
  const box = core || { west: src.west, north: src.north, east: src.west + src.cols * src.dx, south: src.north - src.rows * src.dy };
  const i0 = Math.max(0, Math.ceil((box.west - grid.west) / grid.dx - 0.5 - 1e-9));
  const i1 = Math.min(grid.cols, Math.ceil((box.east - grid.west) / grid.dx - 0.5 - 1e-9));
  const j0 = Math.max(0, Math.ceil((grid.north - box.north) / grid.dy - 0.5 - 1e-9));
  const j1 = Math.min(grid.rows, Math.ceil((grid.north - box.south) / grid.dy - 0.5 - 1e-9));
  let got = 0;
  for (let j = j0; j < j1; j++) {
    const row = (src.north - latOf(grid, j)) / src.dy - 0.5;
    for (let i = i0; i < i1; i++) {
      const v = at(src.values, src.cols, src.rows, (lngOf(grid, i) - src.west) / src.dx - 0.5, row);
      if (v === v) {
        layer[j * grid.cols + i] = v;
        got++;
      }
    }
    await tick();
  }
  return got;
}

/**
 * Puts depths held in a map projection onto the grid, reading them a band of rows at a time so
 * that a big source never has to be held whole. [src] is { width, height, bbox: [x0, y0, x1, y1]
 * (its outer edges, projected), tileHeight, toSource(lng, lat) → [x, y], read(c0, r0, c1, r1) →
 * the depths in that window, NaN where none }. Places are converted on a lattice every 32 cells
 * or so and filled in between, which is far finer than a cell over the 110 km a download may
 * span. Answers how many cells got a depth.
 */
export async function resampleProjected(layer, grid, src, { tick = noPause, bandCells = 4_000_000, smooth = false } = {}) {
  const pick = smooth ? sampleSmooth : sample;
  const { cols, rows } = grid;
  const [x0, y0, x1, y1] = src.bbox;
  const resX = (x1 - x0) / src.width;
  const resY = (y1 - y0) / src.height;
  const nx = Math.max(2, Math.min(cols, Math.ceil((cols - 1) / 32) + 1));
  const ny = Math.max(2, Math.min(rows, Math.ceil((rows - 1) / 32) + 1));
  const px = new Float64Array(nx * ny);
  const py = new Float64Array(nx * ny);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let b = 0; b < ny; b++) {
    const lat = grid.north - ((b * (rows - 1)) / (ny - 1) + 0.5) * grid.dy;
    for (let a = 0; a < nx; a++) {
      const [x, y] = src.toSource(grid.west + ((a * (cols - 1)) / (nx - 1) + 0.5) * grid.dx, lat);
      const k = b * nx + a;
      px[k] = (x - x0) / resX - 0.5;
      py[k] = (y1 - y) / resY - 0.5;
      if (px[k] < minX) minX = px[k];
      if (px[k] > maxX) maxX = px[k];
      if (py[k] < minY) minY = py[k];
      if (py[k] > maxY) maxY = py[k];
    }
  }
  const c0 = Math.max(0, Math.floor(minX) - 1);
  const c1 = Math.min(src.width, Math.ceil(maxX) + 2);
  const r0 = Math.max(0, Math.floor(minY) - 1);
  const r1 = Math.min(src.height, Math.ceil(maxY) + 2);
  if (!(c1 > c0 && r1 > r0)) return 0;

  // Where a grid cell falls in the source, from the lattice round it.
  const at = (nodes, i, j) => {
    const u = (i * (nx - 1)) / (cols - 1);
    const v = (j * (ny - 1)) / (rows - 1);
    const a = Math.min(nx - 2, Math.floor(u));
    const b = Math.min(ny - 2, Math.floor(v));
    const fu = u - a;
    const fv = v - b;
    const k = b * nx + a;
    return (nodes[k] * (1 - fu) + nodes[k + 1] * fu) * (1 - fv) + (nodes[k + nx] * (1 - fu) + nodes[k + nx + 1] * fu) * fv;
  };
  // The source rows each grid row spans, so a band only visits the rows that reach it.
  const rowLow = new Float64Array(rows);
  const rowHigh = new Float64Array(rows);
  for (let j = 0; j < rows; j++) {
    const v = (j * (ny - 1)) / (rows - 1);
    const b = Math.min(ny - 2, Math.floor(v));
    const fv = v - b;
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < nx; a++) {
      const y = py[b * nx + a] * (1 - fv) + py[(b + 1) * nx + a] * fv;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    rowLow[j] = lo;
    rowHigh[j] = hi;
  }

  const tileHeight = src.tileHeight || TILE;
  const band = Math.max(tileHeight, Math.floor(bandCells / (c1 - c0) / tileHeight) * tileHeight);
  let got = 0;
  for (let s = Math.floor(r0 / tileHeight) * tileHeight; s < r1; s += band) {
    const top = Math.max(s, r0);
    const bottom = Math.min(s + band, r1);
    if (bottom <= top) continue;
    // One row more each side, so a cell near the band's edge has its neighbours.
    const rs = Math.max(0, top - 1);
    const re = Math.min(src.height, bottom + 1);
    const data = await src.read(c0, rs, c1, re);
    const w = c1 - c0;
    const h = re - rs;
    for (let j = 0; j < rows; j++) {
      if (rowHigh[j] < top - 0.5 || rowLow[j] >= bottom - 0.5) continue;
      for (let i = 0; i < cols; i++) {
        const y = at(py, i, j);
        if (y < top - 0.5 || y >= bottom - 0.5) continue;
        const v = pick(data, w, h, at(px, i, j) - c0, y - rs);
        if (v === v) {
          layer[j * cols + i] = v;
          got++;
        }
      }
      await tick();
    }
  }
  return got;
}

/**
 * Lays [layer] over [out] (both the grid's size, NaN where they have nothing): the layer wins
 * wherever it has depths, and fades into what is under it over [feather] cells next to its own
 * gaps, so the join doesn't show as a step. The grid's edge is not a gap. [mask] keeps, for each
 * cell, which layers its depth came from: [bit] is this layer's. Answers how many cells it gave.
 */
export async function blendInto(out, layer, cols, rows, feather, mask, bit, tick = noPause) {
  const far = Math.max(1, Math.round(feather)) * 3;
  const n = cols * rows;
  const dist = new Uint16Array(feather > 0 ? n : 0);
  // Distance to the nearest gap in the layer, in thirds of a cell, counted only up to [far].
  for (let j = 0; j < rows && feather > 0; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (layer[k] !== layer[k]) continue;
      let d = far;
      if (j > 0) {
        d = Math.min(d, dist[k - cols] + 3);
        if (i > 0) d = Math.min(d, dist[k - cols - 1] + 4);
        if (i < cols - 1) d = Math.min(d, dist[k - cols + 1] + 4);
      }
      if (i > 0) d = Math.min(d, dist[k - 1] + 3);
      dist[k] = d;
    }
    await tick();
  }
  for (let j = rows - 1; j >= 0 && feather > 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      if (layer[k] !== layer[k]) continue;
      let d = dist[k];
      if (j < rows - 1) {
        d = Math.min(d, dist[k + cols] + 3);
        if (i > 0) d = Math.min(d, dist[k + cols - 1] + 4);
        if (i < cols - 1) d = Math.min(d, dist[k + cols + 1] + 4);
      }
      if (i < cols - 1) d = Math.min(d, dist[k + 1] + 3);
      dist[k] = d;
    }
    await tick();
  }
  let gave = 0;
  for (let k = 0; k < n; k++) {
    const v = layer[k];
    if (v !== v) continue;
    const under = out[k];
    const weight = feather > 0 ? Math.min(1, dist[k] / far) : 1;
    if (under !== under || weight >= 1) {
      out[k] = v;
      mask[k] = bit;
    } else {
      out[k] = under + weight * (v - under);
      mask[k] |= bit;
    }
    gave++;
  }
  return gave;
}

/**
 * Fills thin gaps in a layer: a run of no more than [maxWidth] empty cells, across or down, with
 * depths on both sides, is filled in a straight line between them. A server can leave a whole
 * row empty where it joins two pieces of its data (NONNA does), which would otherwise show as a
 * line of the coarser depths underneath. Answers how many cells were filled.
 */
export async function fillThinGaps(values, cols, rows, maxWidth, tick = noPause) {
  let filled = 0;
  const run = (at, step, count) => {
    // Along one row (step 1) or one column (step cols) of [count] cells starting at [at].
    let last = -1;
    for (let i = 0; i < count; i++) {
      const k = at + i * step;
      if (values[k] !== values[k]) continue;
      const gap = i - last - 1;
      if (last >= 0 && gap > 0 && gap <= maxWidth) {
        const a = values[at + last * step];
        const b = values[k];
        for (let g = 1; g <= gap; g++) values[at + (last + g) * step] = a + ((b - a) * g) / (gap + 1);
        filled += gap;
      }
      last = i;
    }
  };
  for (let j = 0; j < rows; j++) {
    run(j * cols, 1, cols);
    await tick();
  }
  for (let i = 0; i < cols; i++) {
    run(i, cols, rows);
    if (i % 64 === 0) await tick();
  }
  return filled;
}

/**
 * Fills the small holes inside a layer from the depths round them: a few cells a survey or the
 * lidar missed, which would otherwise take the coarser depths underneath and show as pits.
 * A hole is a patch of empty cells, joined side by side, of no more than [maxCells]; anything
 * bigger is a real gap and stays empty. Answers how many cells were filled.
 */
export async function fillSmallHoles(values, cols, rows, maxCells, tick = noPause) {
  const n = cols * rows;
  const seen = new Uint8Array(n);
  const stack = [];
  let filled = 0;
  for (let start = 0; start < n; start++) {
    if (start % cols === 0) await tick();
    if (seen[start] || values[start] === values[start]) continue;
    // The patch of empty cells this one belongs to, kept while it is still small enough.
    let patch = [];
    seen[start] = 1;
    stack.push(start);
    let steps = 0;
    while (stack.length) {
      if (++steps % 262144 === 0) await tick();
      const k = stack.pop();
      if (patch) {
        patch.push(k);
        if (patch.length > maxCells) patch = null;
      }
      const i = k % cols;
      if (i > 0 && !seen[k - 1] && values[k - 1] !== values[k - 1]) { seen[k - 1] = 1; stack.push(k - 1); }
      if (i < cols - 1 && !seen[k + 1] && values[k + 1] !== values[k + 1]) { seen[k + 1] = 1; stack.push(k + 1); }
      if (k >= cols && !seen[k - cols] && values[k - cols] !== values[k - cols]) { seen[k - cols] = 1; stack.push(k - cols); }
      if (k < n - cols && !seen[k + cols] && values[k + cols] !== values[k + cols]) { seen[k + cols] = 1; stack.push(k + cols); }
    }
    if (!patch) continue;
    // Filled from its edge inwards, each cell the mean of the depths next to it.
    let left = patch;
    while (left.length) {
      const fills = [];
      const still = [];
      for (const k of left) {
        const i = k % cols;
        const j = (k - i) / cols;
        let sum = 0;
        let count = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || ii >= cols || jj < 0 || jj >= rows) continue;
            const v = values[jj * cols + ii];
            if (v === v) {
              sum += v;
              count++;
            }
          }
        }
        if (count) fills.push(k, sum / count);
        else still.push(k);
      }
      if (!fills.length) break;
      for (let f = 0; f < fills.length; f += 2) values[fills[f]] = fills[f + 1];
      filled += fills.length / 2;
      left = still;
    }
  }
  return filled;
}

/**
 * Fills any cell still empty from its neighbours, a ring at a time, up to [steps] cells in: a
 * thin gap at the edge of the grid where no source quite reached. Answers how many stay empty.
 */
export function fillGaps(values, cols, rows, steps = 8) {
  for (let step = 0; step < steps; step++) {
    const fills = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (values[k] === values[k]) continue;
        let sum = 0;
        let count = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj;
            const ii = i + di;
            if (jj < 0 || jj >= rows || ii < 0 || ii >= cols) continue;
            const v = values[jj * cols + ii];
            if (v === v) {
              sum += v;
              count++;
            }
          }
        }
        if (count) fills.push(k, sum / count);
      }
    }
    if (!fills.length) break;
    for (let f = 0; f < fills.length; f += 2) values[fills[f]] = fills[f + 1];
  }
  let empty = 0;
  for (let k = 0; k < values.length; k++) if (values[k] !== values[k]) empty++;
  return empty;
}

/** The lowest and highest value and how many cells are empty. */
export function statsOf(values) {
  let min = Infinity;
  let max = -Infinity;
  let empty = 0;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (v !== v) {
      empty++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, empty };
}

// ---------------------------------------------------------------- writing the GeoTIFF

/**
 * The TIFF floating-point predictor (Adobe Technote 3) for one row of [w] little-endian 32-bit
 * values: the bytes regrouped most significant first, then each byte less the one before. It
 * makes depths compress to about half.
 */
function predictRow(src, dst, w) {
  for (let i = 0; i < w; i++) {
    const p = i * 4;
    dst[i] = src[p + 3];
    dst[w + i] = src[p + 2];
    dst[2 * w + i] = src[p + 1];
    dst[3 * w + i] = src[p];
  }
  for (let i = 4 * w - 1; i > 0; i--) dst[i] = dst[i] - dst[i - 1];
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A GeoTIFF of [values] (32-bit, north-up, the grid's size, NaN where empty) placed on [grid] in
 * longitude and latitude (EPSG:4326), in tiles of 256 cells. Where the browser can compress
 * (CompressionStream), the tiles are deflated with the floating-point predictor. Answers a Blob.
 */
export async function writeGeoTiff(values, grid, { compress = typeof CompressionStream !== 'undefined', tick = noPause } = {}) {
  const { cols, rows } = grid;
  const across = Math.ceil(cols / TILE);
  const down = Math.ceil(rows / TILE);
  const tiles = [];
  const block = new Float32Array(TILE * TILE);
  const blockBytes = new Uint8Array(block.buffer);
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      block.fill(NaN);
      const w = Math.min(TILE, cols - tx * TILE);
      const h = Math.min(TILE, rows - ty * TILE);
      for (let r = 0; r < h; r++) {
        const from = (ty * TILE + r) * cols + tx * TILE;
        block.set(values.subarray(from, from + w), r * TILE);
      }
      if (compress) {
        const predicted = new Uint8Array(blockBytes.length);
        for (let r = 0; r < TILE; r++) predictRow(blockBytes.subarray(r * TILE * 4, (r + 1) * TILE * 4), predicted.subarray(r * TILE * 4, (r + 1) * TILE * 4), TILE);
        tiles.push(await deflate(predicted));
      } else {
        tiles.push(blockBytes.slice());
      }
      await tick();
    }
  }

  // [tag, type, values]: type 2 is text, 3 a 16-bit number, 4 a 32-bit number, 12 a double.
  const offsets = new Array(tiles.length).fill(0);
  const entries = [
    [256, 4, [cols]], [257, 4, [rows]], [258, 3, [32]], [259, 3, [compress ? 8 : 1]], [262, 3, [1]], [277, 3, [1]], [284, 3, [1]],
    ...(compress ? [[317, 3, [3]]] : []),
    [322, 3, [TILE]], [323, 3, [TILE]], [324, 4, offsets], [325, 4, tiles.map((t) => t.length)], [339, 3, [3]],
    [33550, 12, [grid.dx, grid.dy, 0]], [33922, 12, [0, 0, 0, grid.west, grid.north, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
    [42113, 2, [...'nan\0'].map((ch) => ch.charCodeAt(0))]
  ];
  const sizes = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifdAt = 8;
  let extraAt = ifdAt + 2 + entries.length * 12 + 4;
  const placed = entries.map(([tag, type, list]) => {
    const bytes = list.length * sizes[type];
    const at = bytes > 4 ? extraAt : null;
    if (at !== null) extraAt += bytes + (bytes % 2);
    return { tag, type, list, at };
  });
  let end = extraAt;
  tiles.forEach((tile, i) => {
    offsets[i] = end;
    end += tile.length;
  });
  const head = new ArrayBuffer(extraAt);
  const view = new DataView(head);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdAt, true);
  view.setUint16(ifdAt, entries.length, true);
  const put = (type, value, where) => {
    if (type === 2) view.setUint8(where, value);
    else if (type === 3) view.setUint16(where, value, true);
    else if (type === 4) view.setUint32(where, value, true);
    else view.setFloat64(where, value, true);
  };
  placed.forEach((entry, i) => {
    const at = ifdAt + 2 + i * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.list.length, true);
    if (entry.at !== null) view.setUint32(at + 8, entry.at, true);
    entry.list.forEach((value, n) => put(entry.type, value, (entry.at ?? at + 8) + n * sizes[entry.type]));
  });
  // No next directory: the four bytes after the entries stay zero.
  return new Blob([head, ...tiles], { type: 'image/tiff' });
}
