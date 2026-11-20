// Small test files made from scratch, so the tests need nothing downloaded: a vector PMTiles
// chart of depth bands with a contour line, and a GeoTIFF depth survey. Each is read back with
// the app's own libraries before it is used.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { buildTiff, buildUtmTiff, buildAlbersTiff, surveyDepth as depthOf } from './surveys.mjs';

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

// ---------------------------------------------------------------- a photo, and a map tile

/**
 * A JPEG with the notes a camera writes in it: where and when it was taken ([lat], [lng],
 * [when], a Date), and with [turned] that the camera was held on its side.
 */
export function withExif(jpeg, { lat, lng, when, turned = false }) {
  const first = turned ? 3 : 2;
  const cameraAt = 8 + 2 + first * 12 + 4;
  const gpsAt = cameraAt + 2 + 2 * 12 + 4 + 28;
  const gpsData = gpsAt + 2 + 6 * 12 + 4;
  const tiff = Buffer.alloc(gpsData + 24 * 3 + 12);
  let at = 0;
  const u16 = (v) => { tiff.writeUInt16LE(v, at); at += 2; };
  const u32 = (v) => { tiff.writeUInt32LE(v, at); at += 4; };
  const entry = (tag, type, count, value) => { u16(tag); u16(type); u32(count); u32(value); };
  const text = (where, said) => { tiff.write(said, where, 'latin1'); };
  const fractions = (where, values) => values.forEach(([above, below], i) => { tiff.writeUInt32LE(above, where + i * 8); tiff.writeUInt32LE(below, where + i * 8 + 4); });
  const dms = (value) => {
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    const minutes = Math.floor((abs - degrees) * 60);
    return [[degrees, 1], [minutes, 1], [Math.round(((abs - degrees) * 60 - minutes) * 60 * 10000), 10000]];
  };
  const two = (n) => String(n).padStart(2, '0');
  // The camera's own clock ran ten hours ahead of the satellites' (Queensland).
  const local = new Date(when.getTime() + 10 * 3600000);
  tiff.write('II', 0, 'latin1');
  at = 2;
  u16(42);
  u32(8);
  u16(first);
  if (turned) entry(0x0112, 3, 1, 6);
  entry(0x8769, 4, 1, cameraAt);
  entry(0x8825, 4, 1, gpsAt);
  u32(0);
  u16(2);
  entry(0x9003, 2, 20, cameraAt + 30);
  entry(0x9011, 2, 7, cameraAt + 50);
  u32(0);
  text(cameraAt + 30, `${local.getUTCFullYear()}:${two(local.getUTCMonth() + 1)}:${two(local.getUTCDate())} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`);
  text(cameraAt + 50, '+10:00');
  at = gpsAt;
  u16(6);
  entry(1, 2, 2, lat < 0 ? 0x53 : 0x4e);
  entry(2, 5, 3, gpsData);
  entry(3, 2, 2, lng < 0 ? 0x57 : 0x45);
  entry(4, 5, 3, gpsData + 24);
  entry(7, 5, 3, gpsData + 48);
  entry(29, 2, 11, gpsData + 72);
  u32(0);
  fractions(gpsData, dms(lat));
  fractions(gpsData + 24, dms(lng));
  fractions(gpsData + 48, [[when.getUTCHours(), 1], [when.getUTCMinutes(), 1], [when.getUTCSeconds(), 1]]);
  text(gpsData + 72, `${when.getUTCFullYear()}:${two(when.getUTCMonth() + 1)}:${two(when.getUTCDate())}`);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(2 + 6 + tiff.length, 2);
  head.write('Exif', 4, 'latin1');
  return Buffer.concat([jpeg.subarray(0, 2), head, tiff, jpeg.subarray(2)]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A map tile of one colour, as a PNG. */
export function pngTile([r, g, b], size = 256) {
  const row = Buffer.alloc(1 + size * 3);
  for (let i = 0; i < size; i++) row.set([r, g, b], 1 + i * 3);
  const part = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const whole = Buffer.alloc(body.length + 8);
    whole.writeUInt32BE(data.length, 0);
    body.copy(whole, 4);
    whole.writeUInt32BE(crc32(body), body.length + 4);
    return whole;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), part('IHDR', head), part('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), part('IEND', Buffer.alloc(0))]);
}

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
  // What the tests' stand-ins for the two depth services send back.
  writeFileSync(path.join(dir, 'seabed-service'), tiff);
  const albers = await buildAlbersTiff(AREA);
  writeFileSync(path.join(dir, 'high-detail-service'), albers.bytes);
  // The one tile the tests' stand-in for a person's own map server sends for every tile asked.
  writeFileSync(path.join(dir, 'tile.png'), pngTile([40, 110, 160]));
  return { ...files, tiles: chart.tiles, utmProbe: utm.probe, albersProbe: albers.probe, albersMiddle: albers.middle };
}
