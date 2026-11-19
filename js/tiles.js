// Web Mercator tile sums, and the app's own tile address (sb://…) that the map asks through:
// tiles from a chart file on the phone, from a saved offline area, or drawn here from depths.

import { addProtocol } from '../vendor/maplibre-gl.js';

const R2D = 180 / Math.PI;
const MAX_LAT = 85.0511287798066;

export const tileLng = (x, z) => (x / 2 ** z) * 360 - 180;

export function tileLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return R2D * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;

export function latToTileY(lat, z) {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

/** Metres across one pixel of a 256-pixel tile at [lat]. */
export const metresPerPixel = (lat, z) => (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/** The tiles covering [bounds] ([west, south, east, north]) at zoom [z], as inclusive ranges. */
export function tileRange(bounds, z) {
  const last = 2 ** z - 1;
  const clamp = (v) => Math.max(0, Math.min(last, v));
  return {
    x0: clamp(Math.floor(lngToTileX(bounds[0], z))),
    x1: clamp(Math.floor(lngToTileX(bounds[2], z) - 1e-9)),
    y0: clamp(Math.floor(latToTileY(bounds[3], z))),
    y1: clamp(Math.floor(latToTileY(bounds[1], z) - 1e-9))
  };
}

export function countTiles(bounds, minZoom, maxZoom) {
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRange(bounds, z);
    count += Math.max(0, r.x1 - r.x0 + 1) * Math.max(0, r.y1 - r.y0 + 1);
  }
  return count;
}

/** Every tile of [bounds] from [minZoom] to [maxZoom], coarsest first. */
export function* tilesIn(bounds, minZoom, maxZoom) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRange(bounds, z);
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) yield [z, x, y];
  }
}

/** True when tile [z, x, y] lies inside [bounds] and the zoom range. */
export function tileWithin(bounds, minZoom, maxZoom, z, x, y) {
  if (z < minZoom || z > maxZoom) return false;
  const r = tileRange(bounds, z);
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

// ---------------------------------------------------------------- the sb:// address

const handlers = new Map();

/** [fn](id, z, x, y, signal) answers with the tile's bytes, a picture, or null for no tile. */
export function handle(kind, fn) {
  handlers.set(kind, fn);
}

/** The address pattern to give a map source. [rev] changes it so the map asks again. */
export const address = (kind, id, rev) =>
  `sb://${kind}/${encodeURIComponent(id)}/{z}/{x}/{y}${rev === undefined ? '' : `?r=${rev}`}`;

export function install() {
  addProtocol('sb', async (request, abortController) => {
    const m = /^sb:\/\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(request.url);
    const fn = m && handlers.get(m[1]);
    if (!fn) throw new Error(`No such tile: ${request.url}`);
    const data = await fn(decodeURIComponent(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), abortController.signal);
    return { data };
  });
}
