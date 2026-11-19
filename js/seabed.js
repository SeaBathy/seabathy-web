// Free seabed depths for anywhere in the world, fetched by the app itself, as in the Android
// and Desktop apps: GMRT (Global Multi-Resolution Topography, CC BY 4.0), which blends ship
// surveys with the GEBCO grid. Its server picks the finest detail that fits about 55 MB, so a
// small area comes sharper than a big one. The file it sends is a GeoTIFF, which is then kept
// on the phone like any survey: it works offline and in 3D.

import * as charts from './charts.js';
import * as files from './files.js';
import { card, toast, progressCard, holdScreenOn, closeSheet } from './ui.js';

export const SEABED_CREDIT = 'Depths: GMRT, Ryan et al. 2009 (CC BY 4.0)';
const MAX_SPAN_DEG = 4;
const MAX_SPAN_KM = 440;
/** Zoomed right in, still enough around the crosshair to be useful. */
const MIN_SPAN_DEG = 0.25;
const MAX_LAT = 85;
const MAX_LNG = 180;

/** The area to ask for, from what's on screen; east may be past 180 when the date line is on screen. */
export function seabedArea(south, west, north, east, centreLat, centreLng) {
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
    const span = Math.min(MAX_SPAN_DEG, Math.max(MIN_SPAN_DEG, hi - lo));
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
export function seabedName(area) {
  const lat = (area.south + area.north) / 2;
  const lng = (area.west + area.east) / 2;
  return `Seabed ${Math.abs(lat).toFixed(2)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lng).toFixed(2)}${lng < 0 ? 'W' : 'E'} (${Math.max(area.north - area.south, area.east - area.west).toFixed(2)}°)`;
}

let server = 'https://www.gmrt.org/services/GridServer';

/** Points the download at another address that answers the same way. The tests use their own. */
export function useServer(url) {
  server = url;
}

export const seabedUrl = (a) => `${server}?` +
  `north=${a.north.toFixed(5)}&south=${a.south.toFixed(5)}&east=${a.east.toFixed(5)}&west=${a.west.toFixed(5)}&layer=topo&format=geotiff&resolution=high`;

/** A TIFF starts "II*" or "MM" then 42; anything else is the service saying it has nothing here. */
const looksLikeTiff = (b) => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42));

async function download(area, name, map) {
  const progress = progressCard('Seabed depths', 'Keep SeaBathy open and on screen until this finishes.');
  const letSleep = await holdScreenOn();
  try {
    progress.set(null, 'Asking the depth service… this can take a minute');
    const response = await fetch(seabedUrl(area), { signal: progress.signal });
    if (!response.ok) throw new Error(`The depth service answered ${response.status}. Try again later.`);
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
    if (!parts.length || !looksLikeTiff(parts[0])) throw new Error('The depth service has no data for this area.');
    const file = new File(parts, `${name}.tif`, { type: 'image/tiff' });
    // Its values are heights: negative under water, positive on land, whatever the area holds.
    const chart = await charts.importTiff(file, progress, { heights: true, attribution: SEABED_CREDIT });
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
    else toast(error.message || "Couldn't get the seabed depths.", 7000);
  } finally {
    letSleep();
  }
}

/**
 * Seabed depths already on the phone that cover [area] at about the same detail. The service
 * gives a smaller area finer detail, so asking for well under what is held is a new download.
 */
function alreadyHeld(area) {
  const span = Math.max(area.north - area.south, area.east - area.west);
  return charts.list().find((c) => {
    if (c.attribution !== SEABED_CREDIT) return false;
    const [west, south, east, north] = c.bounds;
    const held = Math.max(north - south, east - west);
    const slack = held * 0.02;
    return area.west >= west - slack && area.east <= east + slack && area.south >= south - slack && area.north <= north + slack && span >= held * 0.6;
  }) || null;
}

/** "Get seabed depths": asks, then downloads the area on screen and adds it as a depth layer. */
export async function show(map) {
  const c = map.getCenter();
  const b = map.getBounds();
  const area = seabedArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), c.lat, c.lng);
  const name = seabedName(area);
  const existing = charts.list().find((x) => x.name === name) || alreadyHeld(area);
  if (existing) {
    if (existing.visible === false) {
      existing.visible = true;
      await charts.restyle(existing);
    }
    closeSheet();
    charts.flyTo(existing);
    toast(`${existing.name} is already on this phone.`);
    return;
  }
  const note = area.trimmed ? ` The most one download holds is about ${MAX_SPAN_KM} km across, so this is the middle of the screen.` : '';
  const answer = await card({
    title: 'Get seabed depths?',
    paragraphs: [
      'Downloads depths for the area on screen from GMRT, which blends ship surveys with the global GEBCO grid, and adds them as a layer that also works in 3D and offline.',
      `Detail is best where ships have surveyed; elsewhere it's much coarser. Up to about 55 MB.${note}`
    ],
    fine: 'Not for navigation.',
    dismissable: true,
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'go', label: 'Download', primary: true, domId: 'seabed-go' }]
  });
  if (answer !== 'go') return;
  if (!navigator.onLine) {
    toast('No internet: the seabed depths need a connection to download.');
    return;
  }
  await download(area, name, map);
}
