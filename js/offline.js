// Areas saved for use with no signal: the map tiles of a web chart or of the satellite map,
// fetched once at a gentle pace and kept in the app's database.

import * as db from './db.js';
import { tilesIn, countTiles, tileWithin } from './tiles.js';

/** The most tiles one saved area may hold. */
export const MAX_TILES = 15000;
/** A polite pace for other people's map servers. */
const PER_SECOND = 20;
const AT_ONCE = 6;
const BATCH = 24;

const packs = [];
const saved = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const list = () => packs;
/** True when [source] has at least one saved area, so its tiles are worth looking up. */
export const hasSaved = (source) => saved.has(source);
export const count = countTiles;

function refresh() {
  saved.clear();
  for (const pack of packs) saved.add(pack.source);
}

export async function start() {
  packs.push(...(await db.all('packs')).sort((a, b) => a.created - b.created));
  refresh();
}

/** The usual size of one tile, from a few fetched across the area: for the size shown before saving. */
export async function sampleSize(fetchTile, bounds, minZoom, maxZoom, signal) {
  const sizes = [];
  const midLng = (bounds[0] + bounds[2]) / 2;
  const midLat = (bounds[1] + bounds[3]) / 2;
  const point = [midLng, midLat, midLng, midLat];
  for (let z = maxZoom; z >= minZoom && sizes.length < 4; z--) {
    const [tile] = [...tilesIn(point, z, z)];
    if (!tile) continue;
    try {
      const data = await fetchTile(tile[0], tile[1], tile[2], signal);
      if (data?.byteLength) sizes.push(data.byteLength);
    } catch { /* this one is left out of the average */ }
  }
  return sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
}

/**
 * Saves every tile of [bounds] between the zooms. [fetchTile](z, x, y, signal) answers with the
 * tile's bytes or null. Resolves with the saved area's record, with how many tiles failed.
 */
export async function download({ source, label, bounds, minZoom, maxZoom, fetchTile, onProgress, signal }) {
  const total = countTiles(bounds, minZoom, maxZoom);
  if (total > MAX_TILES) throw new Error(`That is ${total.toLocaleString()} tiles: save a smaller area or less detail.`);
  const tiles = tilesIn(bounds, minZoom, maxZoom);
  const written = [];
  let batch = [];
  let done = 0;
  let stored = 0;
  let bytes = 0;
  let failed = 0;
  let nextAt = performance.now();
  let stop = null;

  const flush = async () => {
    if (!batch.length) return;
    const out = batch;
    batch = [];
    await db.putTiles(out);
    for (const [key] of out) written.push(key);
  };

  const worker = async () => {
    while (!signal?.aborted && !stop) {
      const next = tiles.next();
      if (next.done) return;
      const [z, x, y] = next.value;
      const now = performance.now();
      const wait = nextAt - now;
      nextAt = Math.max(now, nextAt) + 1000 / PER_SECOND;
      if (wait > 0) await sleep(wait);
      let data = null;
      for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt++) {
        try {
          data = await fetchTile(z, x, y, signal);
          break;
        } catch {
          if (attempt === 2) failed++;
          else await sleep(600 * (attempt + 1));
        }
      }
      if (data?.byteLength) {
        const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        batch.push([db.tileKey(source, z, x, y), buffer]);
        bytes += buffer.byteLength;
        stored++;
      }
      done++;
      try {
        if (batch.length >= BATCH) await flush();
      } catch (error) {
        stop = error;
        return;
      }
      onProgress?.(done, total, bytes);
    }
  };

  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  if (!stop && !signal?.aborted) {
    try {
      await flush();
    } catch (error) {
      stop = error;
    }
  }
  if (stop || signal?.aborted) {
    // Stopped or out of space: what this save wrote is taken out again, unless another saved area covers it.
    const others = packs.filter((p) => p.source === source);
    const prefix = `${source}/`;
    const drop = written.filter((key) => {
      const [z, x, y] = key.slice(prefix.length).split('/').map(Number);
      return !others.some((o) => tileWithin(o.bounds, o.minZoom, o.maxZoom, z, x, y));
    });
    for (let i = 0; i < drop.length; i += 500) await db.deleteTiles(drop.slice(i, i + 500));
    if (stop) throw stop;
    throw new Error('Cancelled');
  }
  const pack = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    source, label, bounds, minZoom, maxZoom, tiles: stored, bytes, failed, created: Date.now()
  };
  await db.put('packs', pack);
  packs.push(pack);
  refresh();
  return pack;
}

/** Deletes a saved area. Tiles another saved area of the same map also covers are kept. */
export async function removePack(pack) {
  const others = packs.filter((p) => p !== pack && p.source === pack.source);
  let keys = [];
  for (const [z, x, y] of tilesIn(pack.bounds, pack.minZoom, pack.maxZoom)) {
    if (others.some((o) => tileWithin(o.bounds, o.minZoom, o.maxZoom, z, x, y))) continue;
    keys.push(db.tileKey(pack.source, z, x, y));
    if (keys.length >= 500) {
      await db.deleteTiles(keys);
      keys = [];
    }
  }
  if (keys.length) await db.deleteTiles(keys);
  await db.remove('packs', pack.id);
  packs.splice(packs.indexOf(pack), 1);
  refresh();
}

/** Deletes every saved area of one map (its chart was removed). */
export async function removeSource(source) {
  const mine = packs.filter((p) => p.source === source);
  if (!mine.length) return;
  await db.deleteTilesOf(source);
  for (const pack of mine) {
    await db.remove('packs', pack.id);
    packs.splice(packs.indexOf(pack), 1);
  }
  refresh();
}
