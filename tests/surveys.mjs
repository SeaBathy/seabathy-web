// Test GeoTIFF depth surveys, written byte by byte so the tests need nothing downloaded: one in
// longitude and latitude and one in a UTM projection. Each is read back with the app's own
// library before it is used.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs one of the app's browser scripts here and hands back the global it defines. */
export const browserScript = (file, name) =>
  new Function('exports', 'module', 'define', `${readFileSync(path.join(root, file), 'utf8')}\n; return globalThis.${name};`)();

/**
 * A plain GeoTIFF of 32-bit depths in strips of 40 rows. [geo] is { scale: [x, y], origin:
 * [x, y] (the top-left corner), keys: the GeoKey directory's entries }.
 */
function writeTiff(values, width, height, geo, noData) {
  const rowsPerStrip = 40;
  const strips = Math.ceil(height / rowsPerStrip);
  const keys = [1, 1, 0, geo.keys.length / 4, ...geo.keys];
  const noDataText = [...Buffer.from(`${noData}\0`, 'ascii')];
  // [tag, type, values]: type 2 is text, 3 a 16-bit number, 4 a 32-bit number, 12 a double.
  const entries = [
    [256, 4, [width]], [257, 4, [height]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]],
    [273, 4, null], [277, 3, [1]], [278, 4, [rowsPerStrip]], [279, 4, null], [284, 3, [1]], [339, 3, [3]],
    [33550, 12, [geo.scale[0], geo.scale[1], 0]], [33922, 12, [0, 0, 0, geo.origin[0], geo.origin[1], 0]],
    [34735, 3, keys], [42113, 2, noDataText]
  ];
  const sizes = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifdAt = 8;
  let extraAt = ifdAt + 2 + entries.length * 12 + 4;
  // Where each tag's values go when they don't fit in the entry itself.
  const placed = entries.map(([tag, type, list]) => {
    const count = list ? list.length : strips;
    const bytes = count * sizes[type];
    const at = bytes > 4 ? extraAt : null;
    if (at !== null) extraAt += bytes + (bytes % 2);
    return { tag, type, list, count, at };
  });
  const stripBytes = (i) => Math.min(rowsPerStrip, height - i * rowsPerStrip) * width * 4;
  const offsets = [];
  let end = extraAt;
  for (let i = 0; i < strips; i++) {
    offsets.push(end);
    end += stripBytes(i);
  }
  const out = Buffer.alloc(end);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdAt, 4);
  out.writeUInt16LE(entries.length, ifdAt);
  const put = (type, value, where) => {
    if (type === 2) out.writeUInt8(value, where);
    else if (type === 3) out.writeUInt16LE(value, where);
    else if (type === 4) out.writeUInt32LE(value, where);
    else out.writeDoubleLE(value, where);
  };
  placed.forEach((entry, i) => {
    const list = entry.list || (entry.tag === 273 ? offsets : offsets.map((_, n) => stripBytes(n)));
    const entryAt = ifdAt + 2 + i * 12;
    out.writeUInt16LE(entry.tag, entryAt);
    out.writeUInt16LE(entry.type, entryAt + 2);
    out.writeUInt32LE(entry.count, entryAt + 4);
    if (entry.at !== null) out.writeUInt32LE(entry.at, entryAt + 8);
    list.forEach((value, n) => put(entry.type, value, (entry.at ?? entryAt + 8) + n * sizes[entry.type]));
  });
  Buffer.from(values.buffer, values.byteOffset, values.byteLength).copy(out, extraAt);
  return out;
}

/** Reads a test survey back with the app's own library and checks a few cells. */
async function checkTiff(bytes, width, expected) {
  // The library names Worker as it loads, which Node lacks.
  globalThis.Worker ??= class {};
  const GeoTIFF = browserScript('vendor/geotiff.js', 'GeoTIFF');
  const image = await (await GeoTIFF.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).getImage(0);
  const [data] = await image.readRasters({ interleave: false });
  for (const [row, col, value] of expected) {
    const read = data[row * width + col];
    if (Math.abs(read - value) > 1e-3) throw new Error(`the test survey reads ${read} at row ${row}, column ${col}, not ${value}`);
  }
  if (image.getGDALNoData() !== -9999) throw new Error('the test survey lost its no-data value');
  return image.getBoundingBox();
}

/**
 * A survey in longitude and latitude over [area]: the seabed slopes from 5 m in the west to
 * 65 m in the east, with a corner of no data as a real survey has round its edges.
 */
export const surveyDepth = (area, lng) => -(5 + (60 * (lng - area.west)) / (area.east - area.west));

export async function buildTiff(area) {
  const width = 320;
  const height = 320;
  const values = new Float32Array(width * height);
  const depthAt = (c) => surveyDepth(area, area.west + ((c + 0.5) / width) * (area.east - area.west));
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) values[r * width + c] = r < 20 && c < 20 ? -9999 : depthAt(c);
  }
  const bytes = writeTiff(values, width, height, {
    scale: [(area.east - area.west) / width, (area.north - area.south) / height], origin: [area.west, area.north],
    keys: [1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
  }, -9999);
  const box = await checkTiff(bytes, width, [[0, 0, -9999], [160, 160, depthAt(160)], [319, 319, depthAt(319)]]);
  if (Math.abs(box[0] - area.west) > 1e-9 || Math.abs(box[3] - area.north) > 1e-9) throw new Error('the test survey is in the wrong place');
  return bytes;
}

const UTM = { zone: 55, epsg: 32755, cell: 50, width: 400, height: 360 };
/** The UTM survey's depth: 10 m at its west edge, 1 m deeper every 500 m east. */
const utmDepth = (easting, west) => -(10 + (easting - west) / 500);

/**
 * The same stretch of sea as a survey in UTM zone 55 south, in metres: a projected file, which
 * the app has to convert. Answers with the file and a place inside it with the depth there.
 */
export async function buildUtmTiff(area) {
  const proj4 = browserScript('vendor/proj4.js', 'proj4');
  const toUtm = proj4('EPSG:4326', `+proj=utm +zone=${UTM.zone} +south +datum=WGS84 +units=m +no_defs`);
  const [west, north] = toUtm.forward([area.west + 0.05, area.north - 0.05]).map((v) => Math.round(v / UTM.cell) * UTM.cell);
  const values = new Float32Array(UTM.width * UTM.height);
  for (let r = 0; r < UTM.height; r++) {
    for (let c = 0; c < UTM.width; c++) values[r * UTM.width + c] = utmDepth(west + (c + 0.5) * UTM.cell, west);
  }
  const bytes = writeTiff(values, UTM.width, UTM.height, {
    scale: [UTM.cell, UTM.cell], origin: [west, north], keys: [1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, UTM.epsg]
  }, -9999);
  await checkTiff(bytes, UTM.width, [[0, 0, utmDepth(west + 25, west)], [200, 300, utmDepth(west + 300.5 * UTM.cell, west)]]);
  const easting = west + 240.5 * UTM.cell;
  const [lng, lat] = toUtm.inverse([easting, north - 180.5 * UTM.cell]);
  return { bytes, probe: { lng, lat, depth: utmDepth(easting, west) } };
}
