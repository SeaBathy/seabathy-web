// Small test files made from scratch, so the tests need nothing downloaded: a vector PMTiles
// chart of depth bands with a contour line, and a GeoTIFF depth survey. Each is read back with
// the app's own libraries before it is used.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildTiff, buildUtmTiff, surveyDepth as depthOf } from './surveys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The chart library is a plain browser script: run it here to get the same tile numbering. */
export const pmtiles = new Function(`${readFileSync(path.join(root, 'vendor/pmtiles.js'), 'utf8')}; return pmtiles;`)();

/** Where the test chart and survey sit: reef country off Queensland. */
export const AREA = { west: 148.9, south: -20.4, east: 149.3, north: -20.0 };

// ---------------------------------------------------------------- a vector tile, by hand

const varint = (value) => {
  const out = [];
  let v = value;
  while (v > 127) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const zigzag = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
const field = (number, wire, bytes) => [...varint(number * 8 + wire), ...bytes];
const lengthDelimited = (number, bytes) => field(number, 2, [...varint(bytes.length), ...bytes]);
const text = (s) => [...Buffer.from(s, 'utf8')];

function doubleValue(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return field(3, 1, [...b]);
}

/** Geometry commands for one ring or line of [x, y] points in tile units. */
function path2(points, close) {
  const out = [];
  let px = 0;
  let py = 0;
  out.push(1 * 8 + 1); // MoveTo, once
  out.push(zigzag(points[0][0] - px), zigzag(points[0][1] - py));
  [px, py] = points[0];
  out.push((points.length - 1) * 8 + 2); // LineTo
  for (const [x, y] of points.slice(1)) {
    out.push(zigzag(x - px), zigzag(y - py));
    px = x;
    py = y;
  }
  if (close) out.push(1 * 8 + 7); // ClosePath
  return out.flatMap(varint);
}

/** One layer: features are { type: 2 line | 3 polygon, points, depth }. */
function layer(name, features) {
  const values = [...new Set(features.map((f) => f.depth))];
  let body = [...field(15, 0, varint(2)), ...lengthDelimited(1, text(name))];
  for (const f of features) {
    const feature = [
      ...lengthDelimited(2, [...varint(0), ...varint(values.indexOf(f.depth))]),
      ...field(3, 0, varint(f.type)),
      ...lengthDelimited(4, path2(f.points, f.type === 3))
    ];
    body = body.concat(lengthDelimited(2, feature));
  }
  body = body.concat(lengthDelimited(3, text('depth')));
  for (const v of values) body = body.concat(lengthDelimited(4, doubleValue(v)));
  body = body.concat(field(5, 0, varint(4096)));
  return lengthDelimited(3, body);
}

/** A tile of four depth bands side by side (5, 15, 30 and 60 m) and a 20 m contour across it. */
function depthTile() {
  const bands = [5, 15, 30, 60].map((depth, i) => ({
    type: 3, depth, points: [[i * 1024, 0], [(i + 1) * 1024, 0], [(i + 1) * 1024, 4096], [i * 1024, 4096]]
  }));
  const contour = { type: 2, depth: 20, points: [[0, 2048], [1400, 1900], [2800, 2200], [4096, 2048]] };
  return Buffer.from([...layer('bathymetry', bands), ...layer('contours', [contour])]);
}

// ---------------------------------------------------------------- a PMTiles archive, by hand

const tileX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
};

/** A vector PMTiles file covering [AREA] from zoom 6 to 12, every tile holding the same picture. */
export function buildPmtiles() {
  const tile = depthTile();
  const ids = [];
  for (let z = 6; z <= 12; z++) {
    for (let x = tileX(AREA.west, z); x <= tileX(AREA.east, z); x++) {
      for (let y = tileY(AREA.north, z); y <= tileY(AREA.south, z); y++) ids.push(pmtiles.zxyToTileId(z, x, y));
    }
  }
  ids.sort((a, b) => a - b);
  // Every tile points at the one copy of the picture.
  const directory = [...varint(ids.length)];
  let last = 0;
  for (const id of ids) {
    directory.push(...varint(id - last));
    last = id;
  }
  for (let i = 0; i < ids.length; i++) directory.push(...varint(1));
  for (let i = 0; i < ids.length; i++) directory.push(...varint(tile.length));
  for (let i = 0; i < ids.length; i++) directory.push(...varint(1));
  const dir = Buffer.from(directory);
  const metadata = Buffer.from(JSON.stringify({
    name: 'Test depth chart',
    attribution: 'Test data, made up',
    vector_layers: [
      { id: 'bathymetry', fields: { depth: 'Number' }, minzoom: 6, maxzoom: 12 },
      { id: 'contours', fields: { depth: 'Number' }, minzoom: 6, maxzoom: 12 }
    ]
  }));
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const u64 = (value, at) => header.writeBigUInt64LE(BigInt(value), at);
  const rootAt = 127;
  const metaAt = rootAt + dir.length;
  const dataAt = metaAt + metadata.length;
  u64(rootAt, 8); u64(dir.length, 16);
  u64(metaAt, 24); u64(metadata.length, 32);
  u64(dataAt, 40); u64(0, 48);
  u64(dataAt, 56); u64(tile.length, 64);
  u64(ids.length, 72); u64(ids.length, 80); u64(1, 88);
  header.writeUInt8(1, 96);  // clustered
  header.writeUInt8(1, 97);  // directories: not compressed
  header.writeUInt8(1, 98);  // tiles: not compressed
  header.writeUInt8(1, 99);  // vector tiles
  header.writeUInt8(6, 100);
  header.writeUInt8(12, 101);
  header.writeInt32LE(Math.round(AREA.west * 1e7), 102);
  header.writeInt32LE(Math.round(AREA.south * 1e7), 106);
  header.writeInt32LE(Math.round(AREA.east * 1e7), 110);
  header.writeInt32LE(Math.round(AREA.north * 1e7), 114);
  header.writeUInt8(9, 118);
  header.writeInt32LE(Math.round(((AREA.west + AREA.east) / 2) * 1e7), 119);
  header.writeInt32LE(Math.round(((AREA.south + AREA.north) / 2) * 1e7), 123);
  return { bytes: Buffer.concat([header, dir, metadata, tile]), tiles: ids.length };
}

/** Reads the archive back with the app's own library: the header, and one tile at each zoom. */
export async function checkPmtiles(bytes) {
  const source = {
    getKey: () => 'test',
    getBytes: async (offset, length) => ({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length) })
  };
  const archive = new pmtiles.PMTiles(source);
  const header = await archive.getHeader();
  if (header.tileType !== 1 || header.minZoom !== 6 || header.maxZoom !== 12) throw new Error('the test chart has the wrong header');
  const midLng = (AREA.west + AREA.east) / 2;
  const midLat = (AREA.south + AREA.north) / 2;
  for (let z = 6; z <= 12; z++) {
    const tile = await archive.getZxy(z, tileX(midLng, z), tileY(midLat, z));
    if (!tile?.data?.byteLength) throw new Error(`the test chart has no tile at zoom ${z}`);
  }
}

// ---------------------------------------------------------------- everything, on disk

/** The longitude-and-latitude survey's depth at a longitude. */
export const surveyDepth = (lng) => depthOf(AREA, lng);

/** Writes the test files into [dir] and answers with their paths. */
export async function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const chart = buildPmtiles();
  await checkPmtiles(chart.bytes);
  const tiff = await buildTiff(AREA);
  const utm = await buildUtmTiff(AREA);
  const files = {
    pmtiles: path.join(dir, 'test-chart.pmtiles'), tiff: path.join(dir, 'test-survey.tif'), utm: path.join(dir, 'test-survey-utm.tif')
  };
  writeFileSync(files.pmtiles, chart.bytes);
  writeFileSync(files.tiff, tiff);
  writeFileSync(files.utm, utm.bytes);
  return { ...files, tiles: chart.tiles, utmProbe: utm.probe };
}
