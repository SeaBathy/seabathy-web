// Free seabed depths, fetched by the app itself and kept on the phone, as in the Android and
// Desktop apps. The person draws an area on the chart, and what arrives is a GeoTIFF that then
// works like any survey, offline and in 3D:
//
// - Worldwide: GMRT (Global Multi-Resolution Topography, CC BY 4.0), which blends ship surveys
//   with the GEBCO grid. Its server picks the finest detail that fits about 55 MB.
// - High detail, Australian waters: the IMAS multi-resolution bathymetry composite (Flukes
//   2026, CC BY 4.0), 10 m on the shelf. IMAS's own map server cuts the area out and sends
//   it (a WCS GetCoverage request), so nothing sits between the phone and IMAS. The Android
//   app reads the same composite from IMAS's files, which a web page is not allowed to do.
// - High detail elsewhere: the USA, Canada, Europe, New Zealand and the Pacific islands, each
//   from its own maker's server, with GMRT under them for what they don't cover. The phone
//   puts them together into one GeoTIFF (see overseas.js).

import * as charts from './charts.js';
import * as files from './files.js';
import * as overseas from './overseas.js';
import { pickArea } from './areapicker.js';
import { card, el, toast, progressCard, holdScreenOn, closeSheet, loadScript } from './ui.js';

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
 * The same limit holds outside Australia.
 */
const HIGH_DETAIL_CELLS = 9_000_000;
const BYTES_PER_CELL = 2.4;
const COVERAGE = 'bathy_composites__Aus_multires_bathymetry_composite_EEZ';

const servers = {
  gmrt: 'https://www.gmrt.org/services/GridServer',
  imas: 'https://geoserver.imas.utas.edu.au/geoserver/bathy_composites/wcs'
};

/**
 * Points a download at another address that answers the same way. The tests use their own.
 * [which] is gmrt, imas, or one of the high-detail sources outside Australia (noaa, nonna,
 * emodnet, linz, dep).
 */
export function useServer(url, which = 'gmrt') {
  if (which in servers) servers[which] = url;
  overseas.useServer(which, url);
  overseas.forgetLists();
}

/**
 * The area to ask for, from a box on the chart; east may be past 180 when the date line is
 * inside it. It is never smaller than [minSpan] degrees each way.
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

/** True when any of [area] (the chart on screen) is somewhere high detail can be had. */
export const highDetailNear = (area) => inAustralianWaters(area) || overseas.touchesOverseas(area);

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

/**
 * A failure whose message is for the person as it stands. [check] is a link they can open to
 * see for themselves whether this device reaches the server, and [detail] the small print.
 */
class Told extends Error {
  constructor(message, { check = null, detail = '' } = {}) {
    super(message);
    this.check = check;
    this.detail = detail;
  }
}

/**
 * Links that show whether a device can reach each depth server at all. IMAS's server has no
 * front page to open (its plain address answers with an error page even when all is well), so
 * its check is a small picture of the seabed that it draws on request.
 */
const CHECKS = {
  imas: {
    url: 'https://geoserver.imas.utas.edu.au/geoserver/bathy_composites/wms?service=WMS&version=1.1.1&request=GetMap&layers=bathy_composites:AusEEZ_bathy_composite_multires&bbox=148.8,-20.2,149.1,-19.9&width=400&height=400&srs=EPSG:4326&format=image/png',
    label: "Open a test picture from IMAS's server",
    means: 'A small coloured picture of the seabed means this device can reach the server. An error, or a page that never finishes loading, means this connection can\'t.'
  },
  gmrt: {
    url: 'https://www.gmrt.org/',
    label: 'Open the GMRT website',
    means: 'If the website opens, this device can reach GMRT. An error, or a page that never finishes loading, means this connection can\'t.'
  }
};

/** A server that hasn't started to answer by now isn't going to. */
const ANSWER_TIMEOUT_MS = 120000;
const RETRY_WAIT_MS = 1500;
const capital = (text) => text[0].toUpperCase() + text.slice(1);

/**
 * Asks [who] for [url]. Nothing coming back is tried once more before giving up, and the
 * reason given is the real one: a phone that is offline, a server that is slow, or a request
 * that never got an answer (which is not the same as having no internet).
 */
async function ask(url, who, check, progress, asking) {
  for (let attempt = 1; ; attempt++) {
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), ANSWER_TIMEOUT_MS);
    // Cancel stops the wait, and the download after it.
    progress.signal.addEventListener('abort', () => waiting.abort(), { once: true });
    try {
      return await fetch(url, { signal: waiting.signal });
    } catch (error) {
      if (progress.signal.aborted) throw error;
      if (!navigator.onLine) throw new Told('This device is offline. The depths need the internet to download.');
      if (waiting.signal.aborted) throw new Told(`${capital(who)} took too long to answer. It may be busy: try again in a few minutes, or draw a smaller box.`, { check });
      if (attempt >= 2) {
        throw new Told(
          `${capital(who)} did not answer. Your internet may be fine: the server may be down for a moment, or something on this device or its connection is stopping the request, such as a VPN, security software, an ad blocker or a work or public network. Try again in a few minutes.`,
          { check, detail: `The browser said: ${String(error?.message || error).slice(0, 80)}.` });
      }
      progress.set(null, `No answer from ${who}. Trying once more…`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
      if (progress.signal.aborted) throw error;
      progress.set(null, asking);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Downloads a GeoTIFF that a server cuts out on request, and answers its bytes in pieces.
 * [noData] is what to say when the server sends words instead of a file. A server that is
 * busy is asked once more when [again] is set.
 */
async function receive(url, { who, check = null, progress, asking, noData, again = false }) {
  progress.set(null, asking);
  const response = await ask(url, who, check, progress, asking);
  if ((response.status === 429 || response.status >= 500) && again) {
    progress.set(null, `${capital(who)} is busy. Trying once more…`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS * 2));
    if (progress.signal.aborted) throw new Error('Cancelled');
    return receive(url, { who, check, progress, asking, noData });
  }
  if (response.status === 429 || response.status >= 500) throw new Told(`${capital(who)} is busy or having trouble just now (it answered ${response.status}). Try again in a few minutes.`);
  // A map server explains a refusal in the body of a "400"; anything else is a failure.
  if (!response.ok && response.status !== 400) throw new Told(`${capital(who)} answered ${response.status}, not the depths. Try again later.`);
  const parts = [];
  let got = 0;
  try {
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
  } catch (error) {
    if (progress.signal.aborted) throw error;
    throw new Told(`The download from ${who} was cut off part-way (${files.formatBytes(got)} had arrived). Check the connection and try again.`, { check });
  }
  if (!parts.length || !looksLikeTiff(parts[0])) {
    const said = parts.length ? serverSaid(parts[0]) : '';
    throw new Told(/too (big|large)|exceed|limit/i.test(said) ? 'That area is more than the depth service will send at once. Draw a smaller box and try again.' : noData);
  }
  return parts;
}

/**
 * Runs [work] under a progress card, then keeps the GeoTIFF it makes as a depth layer and shows
 * it. [work](progress) answers { file, credit }. Any failure is explained, and nothing is kept.
 */
async function fetchAndKeep(title, noData, work) {
  const progress = progressCard(title, 'Keep SeaBathy open and on screen until this finishes.');
  const letSleep = await holdScreenOn();
  try {
    const { file, credit } = await work(progress);
    let chart;
    try {
      // Its values are heights: negative under water, positive on land, whatever the area holds.
      chart = await charts.importTiff(file, progress, { heights: true, attribution: credit });
    } catch (error) {
      // A file that arrived whole but holds nothing: open sea beyond the data, or all land.
      throw /no data/i.test(error.message || '') ? new Told(noData) : error;
    }
    progress.close();
    // Asking the browser to keep the data must not hold this up: some browsers ask the person.
    files.keep().catch(() => {});
    closeSheet();
    charts.flyTo(chart);
    toast(chart.session
      ? "The depths are loaded, but this browser can't keep files: they stay only until the app closes."
      : 'The depths are saved on this phone. Tap 3D to fly over them.', 7000);
  } catch (error) {
    progress.close();
    if (progress.signal.aborted || files.isCancel(error) || error?.name === 'AbortError') {
      toast('Stopped. Nothing was kept.');
    } else {
      // A failure stays on screen until it has been read.
      const why = files.isFull(error) ? 'This device has no room for these depths. Free up space, or delete a layer under Storage.'
        : error instanceof Told ? error.message
          : `Something went wrong while loading the depths${error?.message ? `: ${error.message}` : '.'}`;
      const test = error instanceof Told ? error.check : null;
      card({
        title: "Couldn't get the depths", paragraphs: [why], dismissable: true,
        // A link to try in this same browser, and what its result means.
        body: test ? [
          el('p', { class: 'card-text' }, el('a', { href: test.url, target: '_blank', rel: 'noopener', id: 'seabed-check', text: test.label })),
          el('p', { class: 'card-text', text: test.means })
        ] : null,
        fine: [error instanceof Told ? error.detail : '', 'Nothing was kept.'].filter(Boolean).join(' '),
        actions: [{ id: 'ok', label: 'OK', primary: true, domId: 'seabed-failed-ok' }]
      });
    }
  } finally {
    letSleep();
  }
}

/** One GeoTIFF, cut out and sent by a server, kept as it comes. */
async function download({ url, name, title, credit, asking, noData, who, check }) {
  await fetchAndKeep(title, noData, async (progress) => {
    const parts = await receive(url, { who, check, progress, asking, noData });
    return { file: new File(parts, `${name}.tif`, { type: 'image/tiff' }), credit };
  });
}

/**
 * Depths already on the phone, from the same source, that cover [area] at about the same
 * detail. Both services give a smaller area finer detail, so asking for well under what is
 * held is a new download. [credit] is the layer's credit, or a test of it.
 */
function alreadyHeld(area, credit) {
  const same = typeof credit === 'function' ? credit : (attribution) => attribution === credit;
  const span = Math.max(area.north - area.south, area.east - area.west);
  return charts.list().find((c) => {
    if (!same(c.attribution || '')) return false;
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
    url: seabedUrl(area), name: seabedName(area), title: 'Seabed depths', credit: SEABED_CREDIT, who: 'the GMRT depth service', check: CHECKS.gmrt,
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
    url: highDetailUrl(plan), name, title: 'High-detail depths', credit: HIGH_DETAIL_CREDIT, who: "IMAS's server", check: CHECKS.imas,
    asking: "Asking IMAS's server to cut out this area… up to a minute",
    noData: 'There are no high-detail depths for this area. Try the worldwide depths.'
  });
}

// ---------------------------------------------------------------- high detail elsewhere

const NO_HIGH_DETAIL = 'No high-detail depths here. Cancel and choose Worldwide.';
/** The finer sources' credits: a layer holding any of them is high detail from outside Australia. */
const OVERSEAS_CREDITS = Object.entries(overseas.SOURCES).filter(([id]) => id !== 'gmrt').map(([, s]) => s.credit);

/** A fetch that gives up after [ms], for the quick questions asked while the box is drawn. */
async function quickFetch(url, ms = 20000) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const response = await fetch(url, { signal: stop.signal });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function libraries() {
  await loadScript('vendor/geotiff.js');
  await loadScript('vendor/proj4.js');
  return { GeoTIFF: globalThis.GeoTIFF, proj4: globalThis.proj4 };
}

/** What overseas.js fetches with while a download runs: every failure is told plainly. */
function downloadNet(progress, { GeoTIFF, proj4 }) {
  const cutOff = (who, error) => new Told(`The download from ${who} was cut off part-way. Check the connection and try again.`,
    { detail: `The browser said: ${String(error?.message || error).slice(0, 80)}.` });
  /** A part-file read from a file store, with the same patience as any other request. */
  async function part(url, init, who, signal) {
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), ANSWER_TIMEOUT_MS);
    const stop = () => waiting.abort();
    progress.signal.addEventListener('abort', stop, { once: true });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: waiting.signal });
      if (response.status === 429 || response.status >= 500) throw new Told(`${capital(who)} is busy or having trouble just now (it answered ${response.status}). Try again in a few minutes.`);
      if (!response.ok) throw new Told(`${capital(who)} answered ${response.status}, not the depths. Try again later.`);
      return response;
    } catch (error) {
      if (progress.signal.aborted || error instanceof Told) throw error;
      if (!navigator.onLine) throw new Told('This device is offline. The depths need the internet to download.');
      if (waiting.signal.aborted) throw new Told(`${capital(who)} took too long to answer. It may be busy: try again in a few minutes, or draw a smaller box.`);
      throw cutOff(who, error);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    GeoTIFF, proj4, signal: progress.signal,
    progress: (fraction, text) => progress.set(fraction, text),
    async json(url, who) {
      const asking = 'Finding which depths cover this box…';
      progress.set(null, asking);
      const response = await ask(url, who, null, progress, asking);
      if (response.status === 429 || response.status >= 500) throw new Told(`${capital(who)} is busy or having trouble just now (it answered ${response.status}). Try again in a few minutes.`);
      if (!response.ok) throw new Told(`${capital(who)} answered ${response.status}. Try again later.`);
      try {
        return await response.json();
      } catch (error) {
        if (progress.signal.aborted) throw error;
        throw cutOff(who, error);
      }
    },
    async tiff(url, who) {
      const parts = await receive(url, {
        who, progress, asking: `Asking ${who}… this can take a minute`, again: true,
        noData: `${capital(who)} sent no depths for this box. Try again later, or choose Worldwide.`
      });
      return new Blob(parts).arrayBuffer();
    },
    async range(url, headers, signal, who) {
      const response = await part(url, { headers }, who, signal);
      try {
        return { status: response.status, headers: response.headers, data: await response.arrayBuffer() };
      } catch (error) {
        if (progress.signal.aborted) throw error;
        throw cutOff(who, error);
      }
    },
    async size(url, signal, who) {
      return Number((await part(url, { method: 'HEAD' }, who, signal)).headers.get('content-length')) || 2 ** 40;
    }
  };
}

/** High detail outside Australia: the finer sources with GMRT under them, put together on the phone. */
async function getOverseas(area, surveyed) {
  const name = seabedName(area, 'High detail');
  const fine = (attribution) => OVERSEAS_CREDITS.some((credit) => attribution.includes(credit));
  const held = charts.list().find((x) => x.name === name) || alreadyHeld(area, fine);
  if (held) {
    await goTo(held);
    return;
  }
  if (!navigator.onLine) {
    toast('No internet: the seabed depths need a connection to download.');
    return;
  }
  await fetchAndKeep('High-detail depths', 'There are no high-detail depths for this area. Try the worldwide depths.', async (progress) => {
    progress.set(0, 'Finding which depths cover this box…');
    const net = downloadNet(progress, await libraries());
    // What was found while the box was drawn, unless a server couldn't be asked then.
    const found = surveyed && !surveyed.unknown ? surveyed : await overseas.survey(area, net, { strict: true });
    const plan = overseas.planFor(area, found.found, HIGH_DETAIL_CELLS);
    if (!plan) throw new Told(`${found.place || 'Here'}: no high-detail depths in this box. Try the worldwide depths.`);
    let made;
    try {
      made = await overseas.build(area, found.found, plan, net);
    } catch (error) {
      throw error instanceof overseas.NothingHere ? new Told(error.message) : error;
    }
    return { file: new File([made.blob], `${name}.tif`, { type: 'image/tiff' }), credit: made.credits.join(' • ') };
  });
}

/** The area a box drawn on the chart asks for; never smaller than [minSpan] degrees each way. */
const areaOfBox = (box, minSpan) =>
  seabedArea(box.south, box.west, box.north, box.east, (box.south + box.north) / 2, (box.west + box.east) / 2, minSpan);

/** Worldwide depths: the person draws the area on the chart, then it downloads. */
async function pickWorldwide(map) {
  const box = await pickArea(map, {
    title: 'SEABED DEPTHS', maxKm: MAX_SPAN_KM, maxDegrees: MAX_SPAN_DEG,
    describe: () => 'From GMRT. The size depends on the box: far less for a small one, 55 MB at the very most.'
  });
  if (box) await getWorldwide(areaOfBox(box));
}

/**
 * High detail: the person draws the area, sees where it is, what it will get and the size,
 * then it downloads. In Australian waters it is the IMAS composite; elsewhere the finer
 * sources there are asked what they hold in the box while it is drawn.
 */
async function pickHighDetail(map) {
  // Loads the projection library too, which the sources outside Australia need while the box is drawn.
  const forward = await toAlbers();
  const areaOf = (box) => highDetailArea(areaOfBox(box, HIGH_DETAIL_MIN_SPAN_DEG));
  const surveys = new Map();
  const quiet = { proj4: globalThis.proj4, json: (url) => quickFetch(url) };
  const surveyOf = (area) => {
    const key = [area.west, area.south, area.east, area.north].map((v) => v.toFixed(5)).join(',');
    if (!surveys.has(key)) surveys.set(key, overseas.survey(area, quiet));
    return surveys.get(key);
  };
  let latest = 0;
  const box = await pickArea(map, {
    title: 'HIGH-DETAIL DEPTHS', maxKm: HIGH_DETAIL_SPAN_KM,
    describe: async (drawn) => {
      const area = areaOf(drawn);
      if (overseas.inAustralia(area)) {
        const plan = highDetailPlan(area, forward);
        return plan.scale < 1
          ? `Australia: about ${detailText(plan.detail)} detail, ${files.formatBytes(plan.bytes)}. A smaller box comes at the full 10 m.`
          : `Australia: the full 10 m detail, about ${files.formatBytes(plan.bytes)}.`;
      }
      if (!overseas.sourcesFor(area).length) return { text: NO_HIGH_DETAIL, ok: false };
      // The servers are asked once the box has stopped changing.
      const mine = ++latest;
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (mine !== latest) return { text: '', ok: false };
      const found = await surveyOf(area);
      const plan = overseas.planFor(area, found.found, HIGH_DETAIL_CELLS);
      if (!plan) return { text: `${found.place}: no high-detail depths in this box. Cancel and choose Worldwide.`, ok: false };
      return overseas.describe(found.place, found.found, plan, files.formatBytes);
    }
  });
  if (!box) return;
  const area = areaOf(box);
  if (overseas.inAustralia(area)) await getHighDetail(area, highDetailPlan(area, forward));
  else if (!overseas.sourcesFor(area).length) toast(NO_HIGH_DETAIL);
  else await getOverseas(area, await surveyOf(area).catch(() => null));
}

/**
 * "Get seabed depths": says what will be downloaded and asks which depths (high detail where
 * it is published, or worldwide). The person then draws the area on the chart. Nothing is
 * downloaded for what merely happens to be on screen.
 */
export async function show(map) {
  const c = map.getCenter();
  const b = map.getBounds();
  // What is on screen only decides whether high detail is offered.
  const onScreen = seabedArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), c.lat, c.lng);
  const intro = 'Downloads depths for an area you draw on the chart, and adds them as a layer that also works in 3D and offline.';
  const worldwide = `Worldwide depths come from GMRT, which blends ship surveys with the global GEBCO grid: best where ships have surveyed, much coarser elsewhere. Up to about ${MAX_SPAN_KM} km across and 55 MB; a smaller area comes sharper.`;
  const next = 'Next you draw the area on the chart.';

  if (!highDetailNear(onScreen)) {
    const answer = await card({
      title: 'Get seabed depths?', paragraphs: [intro, worldwide, next], fine: 'Not for navigation.', dismissable: true,
      actions: [{ id: 'no', label: 'Cancel' }, { id: 'world', label: 'Choose area', primary: true, domId: 'seabed-go' }]
    });
    if (answer !== 'world') return;
    closeSheet();
    await pickWorldwide(map);
    return;
  }

  const answer = await card({
    title: 'Get seabed depths?',
    paragraphs: [
      intro,
      'High detail: Australia: all waters, the IMAS composite at 10 m on the shelf. USA: all coasts, Hawaii and the US islands at about 3 m; Alaska in parts; the Great Lakes coarser. Canada: surveyed coasts and harbours. New Zealand: coasts surveyed by lidar since 2024, to about 25 m deep. Pacific islands: reef shallows to about 10 m, a satellite estimate. Europe: all seas, about 115 m. Elsewhere use Worldwide.',
      `Each is sent by its maker's own server; outside Australia the worldwide depths fill the gaps. Up to about ${HIGH_DETAIL_SPAN_KM} km across, and a smaller box comes sharper: in Australia, up to about 30 km square at the full 10 m detail.`,
      worldwide,
      next
    ],
    fine: 'Not for navigation.', dismissable: true,
    actions: [
      { id: 'no', label: 'Cancel' },
      { id: 'world', label: 'Worldwide', domId: 'seabed-go' },
      { id: 'high', label: 'High detail', primary: true, domId: 'seabed-high' }
    ]
  });
  if (answer !== 'world' && answer !== 'high') return;
  closeSheet();
  if (answer === 'world') await pickWorldwide(map);
  else await pickHighDetail(map);
}
