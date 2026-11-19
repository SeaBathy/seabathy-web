// Free seabed depths, fetched by the app itself and kept on the phone, as in the Android and
// Desktop apps. Two sources, both asked for the area on screen and both answering with a
// GeoTIFF that then works like any survey, offline and in 3D:
//
// - Worldwide: GMRT (Global Multi-Resolution Topography, CC BY 4.0), which blends ship surveys
//   with the GEBCO grid. Its server picks the finest detail that fits about 55 MB.
// - High detail, Australian waters: the IMAS multi-resolution bathymetry composite (Flukes
//   2026, CC BY 4.0), 10 m on the shelf. IMAS's own map server cuts the area out and sends
//   it (a WCS GetCoverage request), so nothing sits between the phone and IMAS. The Android
//   app reads the same composite from IMAS's files, which a web page is not allowed to do.

import * as charts from './charts.js';
import * as files from './files.js';
import { card, toast, progressCard, holdScreenOn, closeSheet, loadScript } from './ui.js';

export const SEABED_CREDIT = 'Depths: GMRT, Ryan et al. 2009 (CC BY 4.0)';
export const HIGH_DETAIL_CREDIT = 'Depths: IMAS multi-resolution bathymetry composite, Flukes 2026 (CC BY 4.0)';
const MAX_SPAN_DEG = 4;
const MAX_SPAN_KM = 440;
/** Zoomed right in, still enough around the crosshair to be useful. */
const MIN_SPAN_DEG = 0.25;
/** High detail is asked for the screen itself, down to a few kilometres. */
const HIGH_DETAIL_MIN_SPAN_DEG = 0.03;
const MAX_LAT = 85;
const MAX_LNG = 180;

/** Australian waters, roughly: the EEZ and the external territories nearest the mainland. */
const AUSTRALIA = { west: 92, east: 172, south: -60, north: -8 };
/** The most one high-detail download covers each way, as on the phone. */
const HIGH_DETAIL_SPAN_KM = 110;
/** The composite's own cell, metres. It is held in GDA2020 Australian Albers (EPSG:9473). */
const HIGH_DETAIL_CELL_M = 10;
const ALBERS = '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
/**
 * The most cells one high-detail download holds: about 30 km square at the full 10 m, and a
 * file of 20 MB or so. A bigger area is thinned by IMAS's server to fit, so it comes coarser.
 */
const HIGH_DETAIL_CELLS = 9_000_000;
const BYTES_PER_CELL = 2.4;
const COVERAGE = 'bathy_composites__Aus_multires_bathymetry_composite_EEZ';

const servers = {
  gmrt: 'https://www.gmrt.org/services/GridServer',
  imas: 'https://geoserver.imas.utas.edu.au/geoserver/bathy_composites/wcs'
};

/** Points a download at another address that answers the same way. The tests use their own. */
export function useServer(url, which = 'gmrt') {
  servers[which] = url;
}

/**
 * The area to ask for, from what's on screen; east may be past 180 when the date line is on
 * screen. It is never smaller than [minSpan] degrees each way.
 */
export function seabedArea(south, west, north, east, centreLat, centreLng, minSpan = MIN_SPAN_DEG) {
  let w = west;
  let e = east;
  // Back into -180..180, on the crosshair's side of the date line.
  const centre = ((centreLng + 540) % 360) - 180;
  const shift = centre - centreLng;
  w += shift;
  e += shift;
  if (e > MAX_LNG) e = MAX_LNG;
  if (w < -MAX_LNG) w = -MAX_LNG;
  const trimmed = north - south > MAX_SPAN_DEG || e - w > MAX_SPAN_DEG;
  const fit = (lo, hi, middle) => {
    const span = Math.min(MAX_SPAN_DEG, Math.max(minSpan, hi - lo));
    const at = hi - lo > MAX_SPAN_DEG ? middle : (lo + hi) / 2;
    return [at - span / 2, at + span / 2];
  };
  const [s, n] = fit(south, north, centreLat);
  const [a, b] = fit(w, e, centre);
  return {
    south: Math.max(-MAX_LAT, s), west: Math.max(-MAX_LNG, a),
    north: Math.min(MAX_LAT, n), east: Math.min(MAX_LNG, b), trimmed
  };
}

/** "Seabed 20.15S 148.95E (0.30°)": the same area gets the same name. */
export function seabedName(area, kind = 'Seabed') {
  const lat = (area.south + area.north) / 2;
  const lng = (area.west + area.east) / 2;
  return `${kind} ${Math.abs(lat).toFixed(2)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lng).toFixed(2)}${lng < 0 ? 'W' : 'E'} (${Math.max(area.north - area.south, area.east - area.west).toFixed(2)}°)`;
}

export const seabedUrl = (a) => `${servers.gmrt}?` +
  `north=${a.north.toFixed(5)}&south=${a.south.toFixed(5)}&east=${a.east.toFixed(5)}&west=${a.west.toFixed(5)}&layer=topo&format=geotiff&resolution=high`;

// ---------------------------------------------------------------- high detail (Australia)

/** True when [area] takes in Australian waters, where the high-detail composite is. */
export const inAustralianWaters = (area) =>
  area.east > AUSTRALIA.west && area.west < AUSTRALIA.east && area.north > AUSTRALIA.south && area.south < AUSTRALIA.north;

/** [area], or its middle [HIGH_DETAIL_SPAN_KM] each way when it is bigger. */
export function highDetailArea(area) {
  const kmPerDegLng = 111.32 * Math.max(0.05, Math.cos((((area.south + area.north) / 2) * Math.PI) / 180));
  const maxLat = (HIGH_DETAIL_SPAN_KM / 110.57) * 0.98;
  const maxLng = (HIGH_DETAIL_SPAN_KM / kmPerDegLng) * 0.98;
  if (area.north - area.south <= maxLat && area.east - area.west <= maxLng) return { ...area, trimmed: false };
  const mid = (lo, hi, cap) => {
    const half = Math.min(hi - lo, cap) / 2;
    const centre = (lo + hi) / 2;
    return [centre - half, centre + half];
  };
  const [south, north] = mid(area.south, area.north, maxLat);
  const [west, east] = mid(area.west, area.east, maxLng);
  return { south, west, north, east, trimmed: true };
}

/**
 * What to ask IMAS's server for: the box round [area] in the composite's own grid, and how
 * much it must be thinned to fit a phone. [forward]([lng, lat]) converts to that grid.
 * Asking in its own grid means the server only cuts the piece out: exact cells, and quick.
 */
export function highDetailPlan(area, forward) {
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const [e, n] = forward([area.west + ((area.east - area.west) * i) / 4, area.south + ((area.north - area.south) * j) / 4]);
      e0 = Math.min(e0, e); e1 = Math.max(e1, e);
      n0 = Math.min(n0, n); n1 = Math.max(n1, n);
    }
  }
  const snap = (v, up) => (up ? Math.ceil(v / HIGH_DETAIL_CELL_M) : Math.floor(v / HIGH_DETAIL_CELL_M)) * HIGH_DETAIL_CELL_M;
  [e0, n0, e1, n1] = [snap(e0, false), snap(n0, false), snap(e1, true), snap(n1, true)];
  const full = ((e1 - e0) / HIGH_DETAIL_CELL_M) * ((n1 - n0) / HIGH_DETAIL_CELL_M);
  const scale = full > HIGH_DETAIL_CELLS ? Math.floor(Math.sqrt(HIGH_DETAIL_CELLS / full) * 1000) / 1000 : 1;
  return { e0, n0, e1, n1, scale, detail: HIGH_DETAIL_CELL_M / scale, cells: full * scale * scale, bytes: full * scale * scale * BYTES_PER_CELL };
}

export const highDetailUrl = (plan) => `${servers.imas}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${COVERAGE}&format=image/tiff` +
  `&subset=E(${plan.e0},${plan.e1})&subset=N(${plan.n0},${plan.n1})${plan.scale < 1 ? `&scalefactor=${plan.scale}` : ''}` +
  '&geotiff:compression=DEFLATE&geotiff:tiling=true&geotiff:tilewidth=256&geotiff:tileheight=256';

async function toAlbers() {
  await loadScript('vendor/proj4.js');
  const converter = globalThis.proj4('EPSG:4326', ALBERS);
  return (lngLat) => converter.forward(lngLat);
}

const detailText = (metres) => `${metres < 10.5 ? 10 : Math.round(metres)} m`;

// ---------------------------------------------------------------- downloading

/** A TIFF starts "II*" or "MM" then 42; anything else is the service saying why it sent none. */
const looksLikeTiff = (b) => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42));

/** Why a map server sent words instead of a file, from its reply. */
function serverSaid(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, 4000));
  const said = /<(?:ows:)?ExceptionText>([\s\S]*?)<\//.exec(text)?.[1] || '';
  return said.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function download({ url, name, title, credit, asking, noData }) {
  const progress = progressCard(title, 'Keep SeaBathy open and on screen until this finishes.');
  const letSleep = await holdScreenOn();
  try {
    progress.set(null, asking);
    const response = await fetch(url, { signal: progress.signal });
    // A map server explains a refusal in the body of a "400"; anything else is a failure.
    if (!response.ok && response.status !== 400) throw new Error(`The depth service answered ${response.status}. Try again later.`);
    const parts = [];
    let got = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        progress.set(null, `Downloading the depths: ${files.formatBytes(got)}`);
      }
    } else {
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }
    if (!parts.length || !looksLikeTiff(parts[0])) {
      const said = parts.length ? serverSaid(parts[0]) : '';
      throw new Error(/too (big|large)|exceed|limit/i.test(said) ? 'That area is more than the depth service will send at once. Zoom in and try again.' : noData);
    }
    const file = new File(parts, `${name}.tif`, { type: 'image/tiff' });
    let chart;
    try {
      // Its values are heights: negative under water, positive on land, whatever the area holds.
      chart = await charts.importTiff(file, progress, { heights: true, attribution: credit });
    } catch (error) {
      // A file that arrived whole but holds nothing: open sea beyond the data, or all land.
      throw /no data/i.test(error.message || '') ? new Error(noData) : error;
    }
    progress.close();
    await files.keep();
    closeSheet();
    charts.flyTo(chart);
    toast(chart.session
      ? "The depths are loaded, but this browser can't keep files: they stay only until the app closes."
      : 'The depths are saved on this phone. Tap 3D to fly over them.', 7000);
  } catch (error) {
    progress.close();
    if (progress.signal.aborted || files.isCancel(error) || error?.name === 'AbortError') toast('Stopped. Nothing was kept.');
    else if (files.isFull(error)) toast('The phone has no room for these depths. Free up space, or delete a chart under Storage.', 8000);
    else if (!navigator.onLine || error instanceof TypeError) toast("Couldn't reach the depth service. Check the internet and try again.", 7000);
    else toast(error.message || "Couldn't get the seabed depths.", 8000);
  } finally {
    letSleep();
  }
}

/**
 * Depths already on the phone, from the same source, that cover [area] at about the same
 * detail. Both services give a smaller area finer detail, so asking for well under what is
 * held is a new download.
 */
function alreadyHeld(area, credit) {
  const span = Math.max(area.north - area.south, area.east - area.west);
  return charts.list().find((c) => {
    if (c.attribution !== credit) return false;
    const [west, south, east, north] = c.bounds;
    const held = Math.max(north - south, east - west);
    const slack = held * 0.02;
    return area.west >= west - slack && area.east <= east + slack && area.south >= south - slack && area.north <= north + slack && span >= held * 0.6;
  }) || null;
}

async function goTo(existing) {
  if (existing.visible === false) {
    existing.visible = true;
    await charts.restyle(existing);
  }
  closeSheet();
  charts.flyTo(existing);
  toast(`${existing.name} is already on this phone.`);
}

async function getWorldwide(area) {
  const held = charts.list().find((x) => x.name === seabedName(area)) || alreadyHeld(area, SEABED_CREDIT);
  if (held) {
    await goTo(held);
    return;
  }
  if (!navigator.onLine) {
    toast('No internet: the seabed depths need a connection to download.');
    return;
  }
  await download({
    url: seabedUrl(area), name: seabedName(area), title: 'Seabed depths', credit: SEABED_CREDIT,
    asking: 'Asking the depth service… this can take a minute',
    noData: 'The depth service has no data for this area.'
  });
}

async function getHighDetail(area, plan) {
  const name = seabedName(area, 'High detail');
  const held = charts.list().find((x) => x.name === name) || alreadyHeld(area, HIGH_DETAIL_CREDIT);
  if (held) {
    await goTo(held);
    return;
  }
  if (!navigator.onLine) {
    toast('No internet: the seabed depths need a connection to download.');
    return;
  }
  await download({
    url: highDetailUrl(plan), name, title: 'High-detail depths', credit: HIGH_DETAIL_CREDIT,
    asking: "Asking IMAS's server to cut out this area… up to a minute",
    noData: 'There are no high-detail depths for this area. Try the worldwide depths.'
  });
}

/**
 * "Get seabed depths": asks which depths (high detail where Australia has it, or worldwide),
 * then downloads the area on screen and adds it as a depth layer.
 */
export async function show(map) {
  const c = map.getCenter();
  const b = map.getBounds();
  const area = seabedArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), c.lat, c.lng);
  const wide = area.trimmed ? ` The most one download holds is about ${MAX_SPAN_KM} km across, so this is the middle of the screen.` : '';
  const intro = 'Downloads depths for the area on screen and adds them as a layer that also works in 3D and offline.';
  const worldwide = 'Worldwide depths come from GMRT, which blends ship surveys with the global GEBCO grid: best where ships have surveyed, much coarser elsewhere. Up to about 55 MB.';

  if (!inAustralianWaters(area)) {
    const answer = await card({
      title: 'Get seabed depths?', paragraphs: [intro, `${worldwide}${wide}`], fine: 'Not for navigation.', dismissable: true,
      actions: [{ id: 'no', label: 'Cancel' }, { id: 'world', label: 'Download', primary: true, domId: 'seabed-go' }]
    });
    if (answer === 'world') await getWorldwide(area);
    return;
  }

  const close = highDetailArea(seabedArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), c.lat, c.lng, HIGH_DETAIL_MIN_SPAN_DEG));
  const plan = highDetailPlan(close, await toAlbers());
  const sharper = plan.scale < 1 ? ` This much area comes at about ${detailText(plan.detail)}: zoom in for the full 10 m.` : '';
  const middle = close.trimmed ? ` It covers the middle ${HIGH_DETAIL_SPAN_KM} km of the screen.` : '';
  const answer = await card({
    title: 'Get seabed depths?',
    paragraphs: [
      intro,
      `High detail: the IMAS composite of Australian waters, 10 m on the shelf, sent by IMAS's own server. About ${detailText(plan.detail)} detail and ${files.formatBytes(plan.bytes)} for this area.${sharper}${middle}`,
      `${worldwide}${wide}`
    ],
    fine: 'Not for navigation.', dismissable: true,
    actions: [
      { id: 'no', label: 'Cancel' },
      { id: 'world', label: 'Worldwide', domId: 'seabed-go' },
      { id: 'high', label: 'High detail', primary: true, domId: 'seabed-high' }
    ]
  });
  if (answer === 'world') await getWorldwide(area);
  else if (answer === 'high') await getHighDetail(close, plan);
}
