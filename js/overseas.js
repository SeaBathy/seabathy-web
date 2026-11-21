// High detail outside Australia: which finer depths cover a box, what the person is told about
// them, and how they are fetched and put together over the worldwide GMRT depths.
//
// - USA: NOAA NCEI's coastal elevation models, cut out by NOAA's own map server.
// - Canada: the Canadian Hydrographic Service's NONNA-10 surveys, from its own map server.
// - Europe: the EMODnet Digital Bathymetry (DTM 2024), from EMODnet's map server.
// - New Zealand: LINZ's coastal lidar, read straight from LINZ's public files.
// - Pacific islands: Digital Earth Pacific's satellite estimate of the reef shallows, read
//   straight from its public files.
//
// Each box is fetched from those servers by the phone itself: nothing passes through SeaBathy.
// Nothing here touches the page: the page hands in what it fetches with (see build), so the
// tests can run all of it as it is.

import { planGrid, resampleGeographic, resampleProjected, blendInto, fillThinGaps, fillSmallHoles, fillGaps, statsOf, writeGeoTiff, metresPerDegree, ticker } from './composite.js';

export const servers = {
  gmrt: 'https://www.gmrt.org/services/GridServer',
  noaa: 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer',
  nonna: 'https://nonna-geoserver.data.chs-shc.ca/geoserver/wcs',
  emodnet: 'https://ows.emodnet-bathymetry.eu/wcs',
  linz: 'https://nz-coastal.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/',
  dep: 'https://stac.digitalearthpacific.org/collections/dep_s2_sdb/items'
};

/** Points a source at another address that answers the same way. The tests use their own. */
export function useServer(which, url) {
  if (which in servers) servers[which] = url;
}

/** Each source: its credit, who it is in a message, and its name at the start of one. */
export const SOURCES = {
  gmrt: { credit: 'Depths: GMRT, Ryan et al. 2009 (CC BY 4.0)', who: 'the GMRT depth service' },
  emodnet: { credit: 'Depths: EMODnet Bathymetry Consortium (2024), EMODnet Digital Bathymetry (DTM 2024), CC BY 4.0', who: "EMODnet's server", name: 'EMODnet' },
  noaa: { credit: 'Depths: NOAA NCEI coastal DEMs (public domain)', who: "NOAA's server", name: 'NOAA' },
  nonna: { credit: 'Contains information licensed under the Open Government Licence - Canada (CHS NONNA, not for navigation)', who: "the Canadian Hydrographic Service's server", name: 'the Canadian Hydrographic Service' },
  linz: { credit: 'Depths: Toitū Te Whenua Land Information New Zealand, Coastal LiDAR DEM, CC BY 4.0', who: "LINZ's data store", name: 'LINZ' },
  dep: { credit: 'Depths (estimate): Digital Earth Pacific, Pacific Community (SPC), satellite-derived bathymetry, CC BY 4.0', who: "Digital Earth Pacific's data store", name: 'Digital Earth Pacific' }
};

/** NZTM 2000 (EPSG:2193), the grid LINZ's lidar is held in. */
export const NZTM = '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
/** WGS 84 / PDC Mercator (EPSG:3832), centred on 150° E so the Pacific is not cut at 180°. */
export const PDC_MERCATOR = '+proj=merc +lon_0=150 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

/** NOAA's cell size for its global fill (ETOPO 2022), in degrees: anything this coarse is not US high detail. */
const ETOPO_CELL = 0.004;
/** NOAA draws its coastal models only for cells up to 0.0004° (about 44 m): finer is asked for and thinned here. */
const NOAA_MAX_CELL = 0.00038;
/** EMODnet's cell: 1/16 of a minute. */
const EMODNET_CELL = 1 / 960;
/** NONNA-10 is held in Web Mercator cells of 19.1 m, which are smaller on the ground away from the equator. */
const NONNA_MERCATOR_CELL = 19.1;
/** The most cells one request to a map server asks for each way. */
const CHUNK = 2048;
/** How much of the composite's file each cell takes, roughly, once compressed. */
export const BYTES_PER_CELL = 2.6;

const intersects = (a, w, s, e, n) => a.east > w && a.west < e && a.north > s && a.south < n;
const inside = (lng, lat, [w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n;
/** Longitude back into -180..180. */
export const normaliseLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------- where each source is

/** Australian waters, where High detail stays the IMAS composite: the EEZ, roughly, clear of the neighbours. */
export const AUSTRALIA = [
  [109, -45, 155, -21], [109, -21, 129, -12.5], [129, -21, 142, -9.8], [142, -30, 146, -9.7],
  [146, -30, 150.5, -11], [150.5, -32, 160, -12], [155, -36, 162, -28], [163, -33, 170, -25.5],
  [140, -48, 152, -39], [156, -57, 161, -52], [104, -12, 107, -9.5], [95, -13.5, 98.5, -10.5]
];
/** True when the middle of [area] is in Australian waters. */
export const inAustralia = (area) => AUSTRALIA.some((box) => inside((area.west + area.east) / 2, (area.south + area.north) / 2, box));

/** [country, region, west, south, east, north]: the US coasts NOAA's models cover. */
const USA = [
  ['Florida', -83.2, 24.3, -79.8, 31.0], ['Florida', -87.7, 29.0, -83.2, 31.1], ['Gulf of Mexico', -97.9, 25.8, -87.7, 30.8],
  ['Atlantic coast', -81.6, 30.7, -66.8, 45.2], ['Pacific coast', -125.0, 32.4, -117.0, 48.4], ['Pacific coast', -123.3, 48.4, -122.0, 49.0],
  ['Alaska', -180, 51.0, -141.0, 72.0], ['Alaska', -141.0, 54.6, -130.1, 60.5], ['Alaska', 172.0, 50.5, 180, 54.0],
  ['Hawaii', -178.5, 18.5, -154.5, 28.5], ['Puerto Rico and US Virgin Islands', -68.0, 17.5, -64.5, 18.7],
  ['Guam and Northern Marianas', 144.4, 13.1, 146.2, 20.7], ['American Samoa', -171.2, -14.6, -168.0, -11.0]
].map(([name, ...box]) => ({ country: 'USA', name, box }));
const GREAT_LAKES = [{ country: 'USA and Canada', name: 'Great Lakes', box: [-92.3, 41.3, -75.9, 49.1] }];
/** Canada's coasts, where the NONNA surveys are. */
const CANADA = [
  ['British Columbia', -139.1, 48.2, -122.7, 60.0], ['Nova Scotia', -66.5, 43.3, -59.6, 47.1],
  ['New Brunswick and the Bay of Fundy', -67.3, 44.5, -63.7, 48.1], ['Gulf of St Lawrence', -66.5, 45.5, -58.5, 50.3],
  ['St Lawrence River', -75.9, 44.9, -66.5, 50.3], ['Newfoundland and Labrador', -67.5, 46.5, -52.0, 60.5],
  ['Hudson Bay', -95.5, 51.0, -76.0, 66.0], ['Arctic', -141.0, 60.0, -60.0, 83.5]
].map(([name, ...box]) => ({ country: 'Canada', name, box }));
/** European seas, as EMODnet covers them, named by sea; the first that holds the box's middle names it. */
const EUROPE_COVER = [[-11, 34, 43, 72], [-6, 30, 36.5, 34], [-25, 62.8, -13, 67.5], [-31.5, 36.5, -24.5, 40.2], [-18.5, 27.5, -13, 33.5], [9, 72, 43, 81]];
const EUROPE = [
  ['Black Sea', 27.3, 40.8, 42, 47.5], ['Baltic Sea', 13, 53.8, 30.5, 66], ['Kattegat and the Danish straits', 9.8, 54.3, 13, 57.8],
  ['Irish Sea', -6.5, 51.5, -2.8, 55], ['English Channel', -6, 48.4, 2, 51], ['North Sea', -4, 51, 9.8, 61],
  ['Bay of Biscay', -10, 43, -1, 48.4], ['Spain and Portugal, Atlantic coast', -10, 35.8, -6, 43.8], ['Mediterranean', -6, 30, 36.5, 46],
  ['Norway', 4, 57.8, 31.5, 72], ['Ireland and the west of Scotland', -11, 51, -4, 61], ['Iceland', -25, 62.8, -13, 67.5],
  ['Azores', -31.5, 36.5, -24.5, 40.2], ['Canary Islands and Madeira', -18.5, 27.5, -13, 33.5], ['Svalbard and the Barents Sea', 9, 72, 43, 81]
].map(([name, ...box]) => ({ country: 'Europe', name, box }));
/** New Zealand, and points along its coasts: the nearest one names the region. */
const NEW_ZEALAND = [165.5, -48, 179, -34];
const NZ_PLACES = [
  ['Northland', [[173.3, -34.9], [174.1, -35.3], [173.9, -35.9], [174.5, -35.8]]],
  ['Auckland', [[174.8, -36.85], [174.7, -36.45], [175.4, -36.2], [174.6, -37.05]]],
  ['Waikato', [[175.5, -36.9], [175.85, -36.85], [174.85, -37.8], [176.0, -37.2]]],
  ['Bay of Plenty', [[176.2, -37.6], [176.9, -37.9], [177.6, -37.9]]],
  ['Gisborne', [[178.0, -38.7], [178.4, -37.9], [178.3, -38.3]]],
  ["Hawke's Bay", [[177.0, -39.4], [176.9, -39.6]]],
  ['Taranaki', [[174.1, -39.0], [173.8, -39.3], [174.3, -39.6]]],
  ['Manawatu-Whanganui', [[175.0, -39.95], [175.2, -40.3]]],
  ['Wellington', [[174.8, -41.3], [175.3, -41.5], [174.95, -40.9], [176.0, -41.0]]],
  ['Nelson and Tasman', [[173.3, -41.25], [172.9, -40.85], [172.6, -40.6]]],
  ['Marlborough', [[174.0, -41.2], [174.2, -41.7]]],
  ['West Coast', [[171.2, -42.4], [170.0, -43.3], [168.8, -44.0], [171.6, -41.8]]],
  ['Canterbury', [[172.9, -43.7], [172.7, -43.55], [171.3, -44.4], [173.7, -42.4]]],
  ['Otago', [[170.6, -45.85], [170.9, -45.4], [169.8, -46.4]]],
  ['Southland', [[168.35, -46.6], [167.9, -46.9], [167.0, -45.5], [166.8, -46.0]]]
];
/** The Pacific islands Digital Earth Pacific covers: 130° E to 120° W, 25° S to 25° N, less Australia and Indonesia. */
const PACIFIC = [[130, -25, 180, 25], [-180, -25, -120, 25]];
const NOT_PACIFIC = [[130, -11.5, 141, 1.5]];
const PACIFIC_PLACES = [
  ['Palau', 131, 2.5, 135, 8.5], ['Papua New Guinea', 141, -12, 155.5, 0], ['Micronesia', 137, 0.5, 163.5, 10.5],
  ['Marshall Islands', 160, 4, 173, 15], ['Nauru', 166.5, -1, 167.5, 0], ['Kiribati', 172, -3, 177.5, 4],
  ['Tuvalu', 175.5, -11, 180, -5], ['Solomon Islands', 155, -12.5, 170.5, -5], ['New Caledonia', 163, -23, 168.5, -19.5],
  ['Vanuatu', 166, -20.5, 170.5, -13], ['Fiji', 176.5, -21, 180, -12], ['Fiji', -180, -21, -178, -12],
  ['Wallis and Futuna', -178.5, -14.5, -176, -13], ['Tonga', -177, -23, -173, -15], ['Samoa', -173, -14.2, -171.3, -13.3],
  ['Tokelau', -173, -9.5, -171, -8.5], ['Niue', -170.1, -19.2, -169.7, -18.9], ['Kiribati', -175, -5, -170, -2],
  ['Kiribati', -163, -12, -150, 6], ['Cook Islands', -166, -22.5, -157, -8.5], ['French Polynesia', -155, -28, -134, -7],
  ['Pitcairn Islands', -131, -26, -124, -23.5]
].map(([name, ...box]) => ({ country: name, name: null, box }));

/** Which finer sources may cover [area] (a box no more than 110 km across, inside -180..180). */
export function sourcesFor(area) {
  const lng = (area.west + area.east) / 2;
  const lat = (area.south + area.north) / 2;
  const touches = (list) => list.some((r) => intersects(area, ...(r.box || r)));
  const out = [];
  if (touches(USA) || touches(GREAT_LAKES)) out.push('noaa');
  if (touches(CANADA) || touches(GREAT_LAKES)) out.push('nonna');
  if (touches(EUROPE_COVER)) out.push('emodnet');
  if (intersects(area, ...NEW_ZEALAND)) out.push('linz');
  if (touches(PACIFIC) && !NOT_PACIFIC.some((box) => inside(lng, lat, box)) && !inAustralia(area)) out.push('dep');
  return out;
}

/** "USA (Florida)", "Fiji", "New Zealand (Northland)", "Europe (North Sea)": where [area] is. */
export function placeOf(area, sources = sourcesFor(area)) {
  const lng = (area.west + area.east) / 2;
  const lat = (area.south + area.north) / 2;
  const named = (r) => (r.name ? `${r.country} (${r.name})` : r.country);
  if (inside(lng, lat, NEW_ZEALAND) && sources.includes('linz')) {
    let best = null;
    let nearest = Infinity;
    for (const [name, points] of NZ_PLACES) {
      for (const [x, y] of points) {
        const d = ((x - lng) * Math.cos(lat * (Math.PI / 180))) ** 2 + (y - lat) ** 2;
        if (d < nearest) {
          nearest = d;
          best = name;
        }
      }
    }
    return `New Zealand (${best})`;
  }
  for (const list of [USA, CANADA, GREAT_LAKES, PACIFIC_PLACES, EUROPE]) {
    const hit = list.find((r) => inside(lng, lat, r.box));
    if (hit) return named(hit);
  }
  const fallback = { noaa: 'USA', nonna: 'Canada', emodnet: 'Europe', linz: 'New Zealand', dep: 'Pacific islands' };
  return fallback[sources[0]] || null;
}

/** True when any part of [area] (the chart on screen, say) is somewhere high detail works outside Australia. */
export const touchesOverseas = (area) => sourcesFor(area).length > 0;

// ---------------------------------------------------------------- addresses

const fixed = (v) => Number(v.toFixed(7));
const bboxText = (b) => [b.west, b.south, b.east, b.north].map(fixed).join(',');

/** GMRT's depths for [b]: its server picks the detail. */
export const gmrtUrl = (b) => `${servers.gmrt}?north=${fixed(b.north)}&south=${fixed(b.south)}&east=${fixed(b.east)}&west=${fixed(b.west)}&layer=topo&format=geotiff&resolution=high`;

/** NOAA's list of the elevation models under [b], with the cell size of each (LowPS, degrees). */
export const noaaQueryUrl = (b) => `${servers.noaa}/query?geometry=${bboxText(b)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
  '&where=Category%3D1&outFields=DemName,Name,LowPS,VerticalDatum&returnGeometry=false&f=json';

/** The rule that leaves NOAA's global fill out, so a cell with no coastal model comes back empty. */
const NOAA_RULE = encodeURIComponent(JSON.stringify({
  mosaicMethod: 'esriMosaicAttribute', sortField: 'ZOrder', sortValue: '0', ascending: true, mosaicOperation: 'MT_FIRST', where: `Category=1 AND LowPS<${ETOPO_CELL}`
}));

/** NOAA's coastal depths over [b] as a [cols] × [rows] float GeoTIFF, empty cells -99999. */
export const noaaExportUrl = (b, cols, rows) => `${servers.noaa}/exportImage?bbox=${bboxText(b)}&bboxSR=4326&imageSR=4326&size=${cols},${rows}` +
  `&format=tiff&pixelType=F32&compression=LZ77&interpolation=RSP_BilinearInterpolation&adjustAspectRatio=false&noData=-99999&mosaicRule=${NOAA_RULE}&f=image`;

const wcs = (base, coverage, b, extra = '') => `${base}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${encodeURIComponent(coverage)}&format=image/tiff` +
  `&subset=Long(${fixed(b.west)},${fixed(b.east)})&subset=Lat(${fixed(b.south)},${fixed(b.north)})${extra}&geotiff:compression=DEFLATE`;

/** The NONNA-10 surveys over [b]; [size] [cols, rows] has the server thin them to that many cells. */
export const nonnaUrl = (b, size = null) => wcs(servers.nonna, 'nonna__NONNA 10 Coverage', b,
  `&subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/4326${size ? `&scalesize=i(${size[0]}),j(${size[1]})` : ''}`);

/** EMODnet's depths over [b], at its own 1/16 minute. */
export const emodnetUrl = (b) => wcs(servers.emodnet, 'emodnet__mean', b);

/** Digital Earth Pacific's satellite depth tiles that touch [b]. */
export const depSearchUrl = (b) => `${servers.dep}?bbox=${bboxText(b)}&limit=50`;

/** LINZ's list of its coastal lidar tiles. */
export const linzCollectionUrl = () => `${servers.linz}collection.json`;

/**
 * Where a LINZ tile lies in NZTM, from its name: the tiles are NZ Topo50 map sheets, 24 km east
 * to west and 36 km north to south, lettered by row from the north (AS, AT, … no I or O) and
 * numbered by column from the west. [x0, y0, x1, y1] in metres, or null for a name that isn't one.
 */
export function linzSheetBounds(id) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const m = /^([A-Z])([A-Z])(\d{2})$/.exec(id);
  if (!m) return null;
  const row = letters.indexOf(m[1]) * letters.length + letters.indexOf(m[2]);
  if (letters.indexOf(m[1]) < 0 || letters.indexOf(m[2]) < 0) return null;
  const x0 = 988000 + Number(m[3]) * 24000;
  const y1 = 6810000 - row * 36000;
  return [x0, y1 - 36000, x0 + 24000, y1];
}

// ---------------------------------------------------------------- finding what covers a box

/**
 * A box with a little more round it, so a server that snaps to its own cells still covers the
 * whole of it.
 */
const padded = (a, by) => ({ west: Math.max(-180, a.west - by), south: Math.max(-90, a.south - by), east: Math.min(180, a.east + by), north: Math.min(90, a.north + by) });

/** The area converted with [forward] ([lng, lat] → [x, y]), as the box round it: [x0, y0, x1, y1]. */
function projectedBox(area, forward) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const [x, y] = forward([area.west + ((area.east - area.west) * i) / 8, area.south + ((area.north - area.south) * j) / 8]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}
const overlaps = (a, b) => a[2] > b[0] && a[0] < b[2] && a[3] > b[1] && a[1] < b[3];

/**
 * What covers [area] and at what detail: { place, found: [{ id, detail, ... }], unknown } where
 * [found] lists each finer source that has (or may have) depths there, coarsest first. NOAA,
 * LINZ and Digital Earth Pacific are asked; NONNA is only known once fetched. [net] is { json(url,
 * who), proj4 }. A source that can't be asked just now is kept, marked unknown, unless [strict],
 * when the failure is passed on.
 */
export async function survey(area, net, { strict = false } = {}) {
  const ids = sourcesFor(area);
  const place = placeOf(area, ids);
  const lat = (area.south + area.north) / 2;
  const found = [];
  let unknown = false;
  const ask = async (id, work) => {
    try {
      await work();
    } catch (error) {
      if (strict || error?.message === 'Cancelled' || error?.name === 'AbortError') throw error;
      unknown = true;
      found.push({ id, detail: defaultDetail(id, lat), unknown: true });
    }
  };
  for (const id of ids) {
    if (id === 'noaa') {
      await ask(id, async () => {
        const answer = await net.json(noaaQueryUrl(area), SOURCES.noaa.who);
        const cells = (answer.features || []).map((f) => Number(f.attributes?.LowPS)).filter((v) => v > 0 && v < ETOPO_CELL);
        if (cells.length) found.push({ id, detail: Math.min(...cells) * metresPerDegree(lat).y });
      });
    } else if (id === 'nonna') {
      found.push({ id, detail: defaultDetail(id, lat) });
    } else if (id === 'emodnet') {
      found.push({ id, detail: defaultDetail(id, lat) });
    } else if (id === 'linz') {
      await ask(id, async () => {
        const sheets = await linzSheets(area, net);
        if (sheets.length) found.push({ id, detail: 1, sheets });
      });
    } else if (id === 'dep') {
      await ask(id, async () => {
        const items = await depItems(area, net);
        if (items.length) found.push({ id, detail: 10 * Math.cos(lat * (Math.PI / 180)), items });
      });
    }
  }
  found.sort((a, b) => b.detail - a.detail);
  return { place, found, unknown };
}

/** The detail a source is known for at [lat], in metres, before it has been asked. */
function defaultDetail(id, lat) {
  if (id === 'nonna') return NONNA_MERCATOR_CELL * Math.cos(lat * (Math.PI / 180));
  if (id === 'emodnet') return EMODNET_CELL * metresPerDegree(lat).y;
  if (id === 'noaa') return 3;
  if (id === 'linz') return 1;
  return 10;
}

let linzList = null;
/** The LINZ tiles that touch [area]: [{ id, href, bbox (NZTM) }]. The list of tiles is fetched once. */
async function linzSheets(area, net) {
  if (!linzList) {
    const collection = await net.json(linzCollectionUrl(), SOURCES.linz.who);
    linzList = (collection.links || []).filter((l) => l.rel === 'item').map((l) => new URL(l.href, linzCollectionUrl()).href);
  }
  const box = projectedBox(area, net.proj4('EPSG:4326', NZTM).forward);
  const out = [];
  for (const itemUrl of linzList) {
    const id = itemUrl.split('/').pop().replace(/\.json$/, '');
    const bounds = linzSheetBounds(id);
    // A name that isn't a map sheet is looked at; any other only when the sheet touches the box.
    if (bounds && !overlaps(bounds, [box[0] - 500, box[1] - 500, box[2] + 500, box[3] + 500])) continue;
    const item = await net.json(itemUrl, SOURCES.linz.who);
    const asset = Object.values(item.assets || {}).find((a) => /tiff?/i.test(a.type || a.href || ''));
    const [w, s, e, n] = item.bbox || [];
    if (!asset || !intersects(area, w, s, e, n)) continue;
    out.push({ id, href: new URL(asset.href, itemUrl).href, bbox: bounds });
  }
  return out;
}
/** Forgets the LINZ tile list (the tests point the source elsewhere). */
export const forgetLists = () => { linzList = null; };

/** Digital Earth Pacific's depth tiles that touch [area], the newest of each: [{ id, href, bbox (PDC Mercator) }]. */
async function depItems(area, net) {
  const answer = await net.json(depSearchUrl(area), SOURCES.dep.who);
  const box = projectedBox(area, net.proj4('EPSG:4326', PDC_MERCATOR).forward);
  const newest = new Map();
  for (const item of answer.features || []) {
    const href = item.assets?.depth?.href;
    const bbox = item.properties?.['proj:bbox'];
    if (!href || !Array.isArray(bbox) || !overlaps(bbox, box)) continue;
    const tile = bbox.join(',');
    const when = String(item.properties?.end_datetime || item.properties?.datetime || '');
    if (!newest.has(tile) || newest.get(tile).when < when) newest.set(tile, { id: item.id, href, bbox, when });
  }
  return [...newest.values()];
}

// ---------------------------------------------------------------- the plan and its words

/**
 * The grid a download will make for [area] from what [survey] found: as fine as the finest
 * source, within [maxCells]. Null when nothing finer than GMRT covers it.
 */
export function planFor(area, found, maxCells) {
  if (!found.length) return null;
  const finest = Math.min(...found.map((f) => f.detail));
  const grid = planGrid(area, finest, maxCells);
  return { grid, finest, detail: Math.max(finest, grid.cell), cells: grid.cols * grid.rows, bytes: grid.cols * grid.rows * BYTES_PER_CELL };
}

const capitalised = (text) => text[0].toUpperCase() + text.slice(1);
const metres = (m) => (m < 1.5 ? '1 m' : m < 19.5 ? `${Math.round(m)} m` : `${Math.round(m / 5) * 5} m`);
/** What each source gives, in a few words, at the detail it will really have. */
const PHRASES = {
  noaa: (d) => `NOAA, about ${metres(d)} detail`,
  nonna: (d) => `CHS surveys, about ${metres(d)} where surveyed`,
  emodnet: (d) => `EMODnet, about ${metres(d)}`,
  linz: (d) => `LINZ lidar near shore, about ${metres(d)}`,
  dep: (d) => `satellite estimate of the reef shallows, about ${metres(d)}`
};

/**
 * The line under the box: where it is and what it will get, for example "USA (Florida): NOAA,
 * about 3 m detail; GMRT fills the rest. Up to about 20 MB." [size] formats a number of bytes.
 */
export function describe(place, found, plan, size) {
  const parts = [...found].reverse().map((f) => PHRASES[f.id](Math.max(f.detail, plan.grid.cell)));
  const fills = found.some((f) => f.id !== 'emodnet');
  const sharper = plan.grid.cell > plan.finest * 1.15 ? ' A smaller box comes sharper.' : '';
  // A server that couldn't be asked while the box was drawn is asked again when it downloads.
  const unsure = found.filter((f) => f.unknown).map((f) => SOURCES[f.id].name);
  const asked = unsure.length ? ` ${capitalised(unsure.join(' and '))} didn't answer just now: asked again on Get depths.` : '';
  return `${place}: ${parts.join('; ')}${fills ? '; GMRT fills the rest' : ''}. Up to about ${size(plan.bytes)}.${sharper}${asked}`;
}

// ---------------------------------------------------------------- fetching and putting together

/** A source had nothing in the box after all. */
export class NothingHere extends Error {}

/**
 * Reads only the parts of a cloud-optimised GeoTIFF that are needed, with part-file requests
 * through [net.range]. The file stores (S3) let other sites read the bytes but not the reply's
 * Content-Range, which geotiff.js needs: it is put back from the range asked for and the
 * file's size.
 */
function rangeClient(url, net, who) {
  let size = null;
  return {
    url,
    async request({ headers = {}, signal } = {}) {
      const reply = await net.range(url, headers, signal, who);
      const asked = /bytes=(\d+)-/.exec(headers.Range || headers.range || '');
      let told = reply.headers.get('content-range');
      if (!told && asked && reply.status === 206) {
        if (size === null) size = await net.size(url, signal, who);
        const start = Number(asked[1]);
        told = `bytes ${start}-${start + reply.data.byteLength - 1}/${size}`;
      }
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        getHeader: (name) => (name.toLowerCase() === 'content-range' ? told : reply.headers.get(name)),
        getData: async () => reply.data
      };
    }
  };
}

/** A GeoTIFF's first image as a block of depths in longitude and latitude: { values, cols, rows, west, north, dx, dy }. */
async function geographicBlock(GeoTIFF, bytes, signal) {
  const image = await (await GeoTIFF.fromArrayBuffer(bytes)).getImage(0);
  const [west, south, east, north] = image.getBoundingBox();
  const cols = image.getWidth();
  const rows = image.getHeight();
  const values = new Float32Array((await image.readRasters({ samples: [0], interleave: false, signal }))[0]);
  const noData = image.getGDALNoData();
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v) || Math.abs(v) >= 1e30 || v <= -99990 || (noData !== null && Math.abs(v - noData) <= Math.abs(noData) * 1e-6 + 1e-6)) values[k] = NaN;
  }
  return { values, cols, rows, west: Math.min(west, east), north: Math.max(south, north), dx: Math.abs(east - west) / cols, dy: Math.abs(north - south) / rows };
}

/** The pieces a request over the grid is split into, each at most [CHUNK] cells a side at [cellX] × [cellY] degrees. */
function chunks(grid, cellX, cellY) {
  const across = Math.max(1, Math.ceil((grid.east - grid.west) / cellX / CHUNK));
  const down = Math.max(1, Math.ceil((grid.north - grid.south) / cellY / CHUNK));
  const w = (grid.east - grid.west) / across;
  const h = (grid.north - grid.south) / down;
  const out = [];
  for (let j = 0; j < down; j++) {
    for (let i = 0; i < across; i++) {
      const core = { west: grid.west + i * w, east: grid.west + (i + 1) * w, north: grid.north - j * h, south: grid.north - (j + 1) * h };
      const cols = Math.max(2, Math.round(w / cellX));
      const rows = Math.max(2, Math.round(h / cellY));
      const mx = w / cols;
      const my = h / rows;
      // One cell more each side, so the cells along a seam have their neighbours.
      out.push({ core, box: { west: core.west - mx, east: core.east + mx, south: core.south - my, north: core.north + my }, cols: cols + 2, rows: rows + 2 });
    }
  }
  return out;
}

/** Runs [work] over [list], [atOnce] at a time. */
async function inTurn(list, atOnce, work) {
  let next = 0;
  const runners = Array.from({ length: Math.min(atOnce, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await work(list[i], i);
    }
  });
  await Promise.all(runners);
}

/** Opens a cloud-optimised GeoTIFF and picks its level for [cell] metres: { image, width, height, bbox, tileHeight, noData }. */
async function openLevel(GeoTIFF, url, net, who, cell, groundScale = 1) {
  const tiff = await GeoTIFF.fromCustomClient(rangeClient(url, net, who), { blockSize: 65536, cacheSize: 200 });
  const first = await tiff.getImage(0);
  const bbox = first.getBoundingBox();
  const count = await tiff.getImageCount();
  const levels = [{ index: 0, image: first, width: first.getWidth(), height: first.getHeight() }];
  for (let i = 1; i < count; i++) {
    const image = await tiff.getImage(i);
    if ((image.fileDirectory.NewSubfileType || 0) & 4) continue;
    if (image.getWidth() >= first.getWidth()) continue;
    levels.push({ index: i, image, width: image.getWidth(), height: image.getHeight() });
  }
  levels.sort((a, b) => a.width - b.width);
  // The coarsest level still about as fine as the grid.
  const level = levels.find((l) => ((bbox[2] - bbox[0]) / l.width) * groundScale <= cell * 1.3) || levels[levels.length - 1];
  return {
    image: level.image, width: level.width, height: level.height, bbox, tileHeight: level.image.getTileHeight() || 256,
    noData: first.getGDALNoData(), decoder: await GeoTIFF.getDecoder(level.image.fileDirectory)
  };
}

/** A decoded tile's bytes as numbers of the file's own kind. */
function asNumbers(image, buffer) {
  const bits = image.getBitsPerSample(0);
  const format = image.getSampleFormat(0);
  if (format === 3) return bits === 64 ? new Float64Array(buffer) : new Float32Array(buffer);
  if (format === 2) return bits === 8 ? new Int8Array(buffer) : bits === 16 ? new Int16Array(buffer) : new Int32Array(buffer);
  return bits === 8 ? new Uint8Array(buffer) : bits === 16 ? new Uint16Array(buffer) : new Uint32Array(buffer);
}

/**
 * Reads a window of a level as depths, NaN where it has none, a tile at a time. A tile the file
 * leaves out (no bytes: nothing surveyed there) is simply empty. geotiff.js's own window reader
 * fails on those, and LINZ's files have many.
 */
const readWindow = (level, signal) => async (c0, r0, c1, r1) => {
  const { image, decoder, noData } = level;
  const tw = image.getTileWidth();
  const th = image.getTileHeight();
  const across = Math.ceil(image.getWidth() / tw);
  const counts = image.fileDirectory.TileByteCounts || image.fileDirectory.StripByteCounts;
  const w = c1 - c0;
  const values = new Float32Array(w * (r1 - r0)).fill(NaN);
  const jobs = [];
  for (let ty = Math.floor(r0 / th); ty <= Math.floor((r1 - 1) / th); ty++) {
    for (let tx = Math.floor(c0 / tw); tx <= Math.floor((c1 - 1) / tw); tx++) {
      if (!counts[ty * across + tx]) continue;
      jobs.push(image.getTileOrStrip(tx, ty, 0, decoder, signal).then(({ data }) => {
        const tile = asNumbers(image, data);
        const x0 = Math.max(c0, tx * tw);
        const x1 = Math.min(c1, (tx + 1) * tw);
        for (let y = Math.max(r0, ty * th); y < Math.min(r1, (ty + 1) * th); y++) {
          const from = (y - ty * th) * tw + (x0 - tx * tw);
          const to = (y - r0) * w + (x0 - c0);
          for (let x = 0; x < x1 - x0; x++) {
            const v = tile[from + x];
            values[to + x] = !Number.isFinite(v) || Math.abs(v) >= 1e30 || (noData !== null && Number.isFinite(noData) && Math.abs(v - noData) <= Math.abs(noData) * 1e-6 + 1e-6) ? NaN : v;
          }
        }
      }));
    }
  }
  await Promise.all(jobs);
  return values;
};

/**
 * Fetches everything for [area] at [plan]'s grid and puts it together: GMRT underneath, then
 * the finer sources in [found], coarsest first, each fading into what is under it at its edge.
 * [net] is what the page fetches with:
 *   json(url, who) and tiff(url, who) (the bytes of a GeoTIFF a server sent, checked),
 *   range(url, headers, signal, who) → { status, headers, data } and size(url, signal, who) for
 *   part-file reads,
 *   GeoTIFF and proj4 (the libraries), signal, and progress(fraction, text).
 * Answers { blob: the GeoTIFF, credits, used, stats }. Throws NothingHere when no finer source
 * had anything in the box.
 */
export async function build(area, found, plan, net) {
  const { grid } = plan;
  const { cols, rows } = grid;
  const n = cols * rows;
  const tick = ticker(net.signal);
  const progress = net.progress || (() => {});
  const out = new Float32Array(n).fill(NaN);
  const layer = new Float32Array(n);
  const mask = new Uint8Array(n);
  const order = ['gmrt', ...found.map((f) => f.id)];
  const bits = new Map(order.map((id, i) => [id, 1 << i]));
  // Each finer source fades into what is under it over about 40 m; its seams up to about 30 m
  // wide and its holes up to about 50 m across are filled from its own depths round them.
  const feather = Math.max(2, Math.min(16, Math.round(40 / grid.cell)));
  const thinGap = Math.max(2, Math.round(30 / grid.cell));
  const smallHole = Math.max(9, Math.round((50 / grid.cell) ** 2));
  const gave = {};
  const steps = order.length + 1;
  const lat = (grid.south + grid.north) / 2;

  for (let s = 0; s < order.length; s++) {
    const id = order[s];
    const share = (f) => (s + f) / steps;
    layer.fill(NaN);
    let got = 0;
    if (id === 'gmrt') {
      progress(share(0), 'Asking GMRT for the depths underneath…');
      const block = await geographicBlock(net.GeoTIFF, await net.tiff(gmrtUrl(padded(grid, Math.max(0.004, (grid.east - grid.west) * 0.02))), SOURCES.gmrt.who), net.signal);
      got = await resampleGeographic(layer, grid, block, null, tick);
    } else if (id === 'emodnet') {
      progress(share(0), "Asking EMODnet's server…");
      const block = await geographicBlock(net.GeoTIFF, await net.tiff(emodnetUrl(padded(grid, 2 * EMODNET_CELL)), SOURCES.emodnet.who), net.signal);
      got = await resampleGeographic(layer, grid, block, null, tick);
    } else if (id === 'noaa') {
      // Asked for at the grid's own detail, but never coarser than NOAA draws its models.
      const pieces = chunks(grid, Math.min(grid.dx, NOAA_MAX_CELL), Math.min(grid.dy, NOAA_MAX_CELL));
      let done = 0;
      progress(share(0), `Asking NOAA's server${pieces.length > 1 ? ` (${pieces.length} parts)` : ''}…`);
      await inTurn(pieces, 2, async (piece) => {
        const block = await geographicBlock(net.GeoTIFF, await net.tiff(noaaExportUrl(piece.box, piece.cols, piece.rows), SOURCES.noaa.who), net.signal);
        got += await resampleGeographic(layer, grid, block, piece.core, tick);
        done++;
        progress(share(done / pieces.length), `NOAA's depths: ${done} of ${pieces.length} parts`);
      });
    } else if (id === 'nonna') {
      const native = NONNA_MERCATOR_CELL * Math.cos(lat * (Math.PI / 180));
      // Its own cells when the grid is about as fine; thinned by the server for a bigger box.
      const thin = grid.cell > native * 1.5;
      const pieces = chunks(grid, thin ? grid.dx : NONNA_MERCATOR_CELL / 111320, thin ? grid.dy : NONNA_MERCATOR_CELL / 111320 * Math.cos(lat * (Math.PI / 180)));
      let done = 0;
      progress(share(0), "Asking the Canadian Hydrographic Service's server…");
      await inTurn(pieces, 2, async (piece) => {
        const block = await geographicBlock(net.GeoTIFF, await net.tiff(nonnaUrl(piece.box, thin ? [piece.cols, piece.rows] : null), SOURCES.nonna.who), net.signal);
        got += await resampleGeographic(layer, grid, block, piece.core, tick);
        done++;
        progress(share(done / pieces.length), `CHS surveys: ${done} of ${pieces.length} parts`);
      });
    } else if (id === 'linz' || id === 'dep') {
      const entry = found.find((f) => f.id === id);
      const list = id === 'linz' ? entry.sheets : entry.items;
      const forward = net.proj4('EPSG:4326', id === 'linz' ? NZTM : PDC_MERCATOR).forward;
      // PDC Mercator's metres are smaller on the ground away from the equator.
      const groundScale = id === 'dep' ? Math.cos(lat * (Math.PI / 180)) : 1;
      for (let t = 0; t < list.length; t++) {
        progress(share(t / list.length), id === 'linz' ? `Reading LINZ's lidar: tile ${t + 1} of ${list.length}…` : `Reading the satellite depths: tile ${t + 1} of ${list.length}…`);
        const level = await openLevel(net.GeoTIFF, list[t].href, net, SOURCES[id].who, grid.cell, groundScale);
        got += await resampleProjected(layer, grid, {
          width: level.width, height: level.height, bbox: level.bbox, tileHeight: level.tileHeight,
          toSource: (lng, lat2) => forward([id === 'dep' ? normaliseLng(lng) : lng, lat2]),
          read: readWindow(level, net.signal)
        }, { tick });
      }
    }
    if (got > 0) {
      progress(share(0.95), 'Putting the depths together…');
      if (id !== 'gmrt') {
        await fillThinGaps(layer, cols, rows, thinGap, tick);
        await fillSmallHoles(layer, cols, rows, smallHole, tick);
      }
      gave[id] = await blendInto(out, layer, cols, rows, id === 'gmrt' ? 0 : feather, mask, bits.get(id), tick);
    }
  }

  const finer = found.filter((f) => gave[f.id] > 0);
  if (!finer.length) {
    const names = found.map((f) => SOURCES[f.id].name);
    throw new NothingHere(`${capitalised(names.join(' and '))} ${names.length > 1 ? 'have' : 'has'} no depths in this box, so there is nothing finer than the worldwide depths here. Try Worldwide.`);
  }
  progress((steps - 1) / steps, 'Putting the depths together…');
  const empty = fillGaps(out, cols, rows, 8);
  let usedBits = 0;
  for (let k = 0; k < n; k++) usedBits |= mask[k];
  // Finest first: the sources on top, then what fills under them.
  const used = [...order].reverse().filter((id) => usedBits & bits.get(id));
  progress((steps - 0.5) / steps, 'Writing the file…');
  const blob = await writeGeoTiff(out, grid, { tick });
  return { blob, credits: used.map((id) => SOURCES[id].credit), used, gave, stats: { ...statsOf(out), emptyAfterFill: empty } };
}
