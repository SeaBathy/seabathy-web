// High detail outside Australia, against the real servers, run here in Node with the app's own
// code (js/overseas.js and js/composite.js) and libraries. It asks each source for a small box
// in five places and writes the GeoTIFF the phone would keep:
//
//   node tests/overseas-live.mjs [folder]        the files go in tests/.work/overseas by default
//   node tests/overseas-live.mjs [folder] halifax  just one of the places
//
// Reads from the file stores are made the way a browser makes them: a reply header a browser
// is not allowed to read from another site (Content-Range) is hidden here too. It needs the
// internet and downloads some tens of megabytes, so it should not be run in a loop.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as overseas from '../js/overseas.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'tests', '.work', 'overseas'));
const only = process.argv[3] || null;
mkdirSync(outDir, { recursive: true });

// The library names Worker as it loads, which Node lacks.
globalThis.Worker ??= class {};
const load = (file, name) => new Function('exports', 'module', 'define', `${readFileSync(path.join(root, file), 'utf8')}\n; return globalThis.${name};`)();
const GeoTIFF = load('vendor/geotiff.js', 'GeoTIFF');
const proj4 = load('vendor/proj4.js', 'proj4');

const MAX_CELLS = 9_000_000;
const PLACES = {
  keywest: { west: -81.82, south: 24.455, east: -81.755, north: 24.52 },
  halifax: { west: -63.62, south: 44.55, east: -63.52, north: 44.63 },
  bayofislands: { west: 174.08, south: -35.30, east: 174.20, north: -35.20 },
  mamanuca: { west: 177.05, south: -17.80, east: 177.20, north: -17.66 },
  glenan: { west: -4.1, south: 47.65, east: -3.9, north: 47.78 }
};

/** Only the reply headers a page from another site may read: the safe ones and those the server lists. */
function asBrowserSees(headers) {
  const safe = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
  const exposed = (headers.get('access-control-expose-headers') || '').toLowerCase().split(',').map((h) => h.trim());
  return { get: (name) => (safe.has(name.toLowerCase()) || exposed.includes(name.toLowerCase()) ? headers.get(name) : null) };
}

let requests = 0;
let bytes = 0;
const size = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const net = {
  GeoTIFF, proj4,
  progress: () => {},
  async json(url, who) {
    requests++;
    const reply = await fetch(url);
    if (!reply.ok) throw new Error(`${who} answered ${reply.status}`);
    const text = await reply.text();
    bytes += text.length;
    return JSON.parse(text);
  },
  async tiff(url, who) {
    requests++;
    const reply = await fetch(url);
    const data = await reply.arrayBuffer();
    bytes += data.byteLength;
    const b = new Uint8Array(data, 0, 4);
    if (!((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) throw new Error(`${who} sent no file (${reply.status}): ${new TextDecoder().decode(data.slice(0, 300))}`);
    return data;
  },
  async range(url, headers, signal) {
    requests++;
    const reply = await fetch(url, { headers, signal });
    const data = await reply.arrayBuffer();
    bytes += data.byteLength;
    return { status: reply.status, headers: asBrowserSees(reply.headers), data };
  },
  async size(url) {
    requests++;
    return Number((await fetch(url, { method: 'HEAD' })).headers.get('content-length'));
  }
};

const results = {};
for (const [name, area] of Object.entries(PLACES)) {
  if (only && name !== only) continue;
  requests = 0;
  bytes = 0;
  const started = Date.now();
  try {
    const found = await overseas.survey(area, net);
    const plan = overseas.planFor(area, found.found, MAX_CELLS);
    if (!plan) throw new Error(`no high detail found: ${JSON.stringify(found)}`);
    const line = overseas.describe(found.place, found.found, plan, size);
    const made = await overseas.build(area, found.found, plan, net);
    const file = path.join(outDir, `${name}.tif`);
    writeFileSync(file, Buffer.from(await made.blob.arrayBuffer()));
    results[name] = {
      file, line, sources: overseas.sourcesFor(area), found: found.found.map((f) => `${f.id} ${f.detail.toFixed(1)} m`),
      grid: `${plan.grid.cols} x ${plan.grid.rows} (${(plan.cells / 1e6).toFixed(2)} M cells), ${plan.grid.cell.toFixed(2)} m`,
      used: made.used, gave: made.gave, credits: made.credits, stats: made.stats, fileSize: made.blob.size, estimate: Math.round(plan.bytes),
      downloaded: bytes, requests, seconds: (Date.now() - started) / 1000
    };
    console.log(`PASS  ${name}: ${line}\n      ${results[name].grid}; used ${made.used.join(', ')}; ${made.stats.min.toFixed(1)} to ${made.stats.max.toFixed(1)} m; ${made.stats.emptyAfterFill} empty; file ${size(made.blob.size)}; downloaded ${size(bytes)} in ${requests} requests, ${results[name].seconds.toFixed(1)} s`);
  } catch (error) {
    results[name] = { error: String(error?.stack || error) };
    console.log(`FAIL  ${name}: ${String(error?.stack || error).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((r) => r.error) ? 1 : 0);
