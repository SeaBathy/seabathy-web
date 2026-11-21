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
async function checkTiff(bytes, width, expected, noData = -9999) {
  // The library names Worker as it loads, which Node lacks.
  globalThis.Worker ??= class {};
  const GeoTIFF = browserScript('vendor/geotiff.js', 'GeoTIFF');
  const image = await (await GeoTIFF.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).getImage(0);
  const [data] = await image.readRasters({ interleave: false });
  for (const [row, col, value] of expected) {
    const read = data[row * width + col];
    if (Math.abs(read - value) > 1e-3) throw new Error(`the test survey reads ${read} at row ${row}, column ${col}, not ${value}`);
  }
  if (Math.abs(image.getGDALNoData() - noData) > Math.abs(noData) * 1e-6) throw new Error('the test survey lost its no-data value');
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


/** GDA2020 Australian Albers (EPSG:9473): the grid the IMAS composite is held in. */
const ALBERS = '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
/** What IMAS's server marks an empty cell with. */
const IMAS_EMPTY = 3.3999999521443642e38;

/**
 * A stand-in for what IMAS's server sends for a high-detail request: depths in Australian
 * Albers, 8 m at the west edge and 1 m deeper every kilometre east, with a patch of empty
 * cells. Answers with the file, and a place inside it with the depth there.
 */
export async function buildAlbersTiff(area) {
  const proj4 = browserScript('vendor/proj4.js', 'proj4');
  const toAlbers = proj4('EPSG:4326', ALBERS);
  const cell = 50;
  const corners = [[area.west, area.south], [area.east, area.south], [area.west, area.north], [area.east, area.north]].map((p) => toAlbers.forward(p));
  const west = Math.floor(Math.min(...corners.map((c) => c[0])) / cell) * cell;
  const north = Math.ceil(Math.max(...corners.map((c) => c[1])) / cell) * cell;
  const width = Math.ceil((Math.max(...corners.map((c) => c[0])) - west) / cell);
  const height = Math.ceil((north - Math.min(...corners.map((c) => c[1]))) / cell);
  const depthAt = (easting) => -(8 + (easting - west) / 1000);
  const values = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) values[r * width + c] = r < 30 && c < 30 ? IMAS_EMPTY : depthAt(west + (c + 0.5) * cell);
  }
  const bytes = writeTiff(values, width, height, { scale: [cell, cell], origin: [west, north], keys: [1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 9473] }, '3.3999999521443642E38');
  await checkTiff(bytes, width, [[100, 100, depthAt(west + 100.5 * cell)], [height - 1, width - 1, depthAt(west + (width - 0.5) * cell)]], IMAS_EMPTY);
  const col = Math.floor(width * 0.55);
  const row = Math.floor(height * 0.5);
  const [lng, lat] = toAlbers.inverse([west + (col + 0.5) * cell, north - (row + 0.5) * cell]);
  return { bytes, probe: { lng, lat, depth: depthAt(west + (col + 0.5) * cell) }, middle: toAlbers.forward([(area.west + area.east) / 2, (area.south + area.north) / 2]) };
}

/** Where the tests' stand-ins for the depth servers outside Australia have depths: round Key West. */
export const OVERSEAS = { west: -81.95, south: 24.35, east: -81.55, north: 24.75 };
/** The stand-in GMRT's depth there: 30 m at the west edge, 1 m deeper every 0.01° east. */
export const overseasCoarse = (lng) => -(30 + (lng - OVERSEAS.west) * 100);
/** The stand-in NOAA's: a flat 4 m south of 24.55° N, and nothing north of it. */
export const OVERSEAS_FINE = { depth: -4, north: 24.55, cell: 0.0001 };

/**
 * What the stand-ins for GMRT and for NOAA's coastal models send for any box round Key West:
 * the worldwide depths sloping gently east, and NOAA's covering only the south half, with
 * NOAA's empty-cell value (-99999) over the rest.
 */
export async function buildOverseasTiffs() {
  const keys = [1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  const span = { x: OVERSEAS.east - OVERSEAS.west, y: OVERSEAS.north - OVERSEAS.south };
  const coarseCell = 0.002;
  const cw = Math.round(span.x / coarseCell);
  const ch = Math.round(span.y / coarseCell);
  const coarse = new Float32Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) coarse[r * cw + c] = overseasCoarse(OVERSEAS.west + (c + 0.5) * coarseCell);
  }
  const gmrt = writeTiff(coarse, cw, ch, { scale: [coarseCell, coarseCell], origin: [OVERSEAS.west, OVERSEAS.north], keys }, -99999);
  await checkTiff(gmrt, cw, [[10, 10, overseasCoarse(OVERSEAS.west + 10.5 * coarseCell)]], -99999);
  const fineCell = 0.0005;
  const fw = Math.round(span.x / fineCell);
  const fh = Math.round(span.y / fineCell);
  const fine = new Float32Array(fw * fh);
  for (let r = 0; r < fh; r++) {
    const lat = OVERSEAS.north - (r + 0.5) * fineCell;
    fine.fill(lat < OVERSEAS_FINE.north ? OVERSEAS_FINE.depth : -99999, r * fw, (r + 1) * fw);
  }
  const noaa = writeTiff(fine, fw, fh, { scale: [fineCell, fineCell], origin: [OVERSEAS.west, OVERSEAS.north], keys }, -99999);
  await checkTiff(noaa, fw, [[0, 0, -99999], [fh - 1, 0, OVERSEAS_FINE.depth]], -99999);
  const query = JSON.stringify({ features: [{ attributes: { DemName: 'Test coastal model', Name: 'test', LowPS: OVERSEAS_FINE.cell, VerticalDatum: 'MHW' } }] });
  return { gmrt, noaa, query };
}
