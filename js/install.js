// The agreement shown before first use, the "add it to your Home Screen" screen an iPhone
// shows in Safari, and the About panel.

import { setting } from './db.js';
import { add, card, el, openSheet, heading, note, row, toast } from './ui.js';

export const VERSION = '0.1.0';
/** Raise when the wording changes in a way people should agree to again. */
const TERMS_VERSION = 1;
const TERMS_URL = 'https://seabathy.com/terms';
const SUMMARY = 'SeaBathy is not a nautical chart and must not be used for navigation.';
const POINTS = [
  'Depths and maps come from free public data and from the files you load. They can be wrong, missing or out of date.',
  "The boat's position and your waypoints are aids only. Keep a proper lookout and use official charts, notices to mariners and your own judgement.",
  'In an emergency, call for help first: VHF channel 16, 000, or your EPIRB.',
  'SeaBathy is free software, given as is, with no warranty. You use it at your own risk.'
];

/** Opened from the Home Screen as its own app, not in a browser tab. */
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** An iPhone or iPad (an iPad says it is a Mac, but a Mac has no touch screen). */
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

/** The agreement, if it hasn't been accepted yet. It can't be put aside without agreeing. */
export async function showTermsIfNeeded() {
  if ((await setting.get('termsAccepted', 0)) >= TERMS_VERSION) return;
  await card({
    badge: 'Before you start', title: 'Not for navigation', subtitle: SUMMARY, paragraphs: POINTS, fine: `Full terms: ${TERMS_URL}`,
    actions: [{ id: 'agree', label: 'I agree', primary: true, domId: 'terms-agree' }]
  });
  await setting.set('termsAccepted', TERMS_VERSION);
}

/**
 * On an iPhone in Safari: how to add the app to the Home Screen, shown before the chart. Charts
 * loaded in Safari don't carry over to the installed app, so it's better to install first.
 */
export function showInstallIfNeeded() {
  const screen = document.getElementById('install');
  if (!isIos() || isStandalone() || sessionStorage.getItem('installSkipped')) return Promise.resolve();
  screen.hidden = false;
  return new Promise((resolve) => {
    document.getElementById('install-skip').addEventListener('click', () => {
      sessionStorage.setItem('installSkipped', '1');
      screen.hidden = true;
      resolve();
    }, { once: true });
  });
}

const INSTALL_STEPS = [
  'Open this page in Safari.',
  'Tap the Share button (a square with an arrow pointing up). On newer iPhones it is under the ••• button.',
  'Scroll down and tap Add to Home Screen.',
  'Leave "Open as Web App" on, then tap Add.',
  'Open SeaBathy from its new icon while you still have internet, so it can save itself for offline use.'
];

export function openAbout() {
  openSheet('About and safety', (body) => {
    add(body, 
      note(`SeaBathy web app, version ${VERSION}. Free and open source, with no account, ads or tracking.`),
      heading('NOT FOR NAVIGATION'),
      note(SUMMARY),
      POINTS.map(note),
      row('Full terms', TERMS_URL, () => window.open(TERMS_URL, '_blank', 'noopener')),
      heading('INSTALL ON AN IPHONE OR IPAD'),
      el('ol', { class: 'steps' }, INSTALL_STEPS.map((text) => el('li', { text }))),
      note(isStandalone() ? 'This copy is running from the Home Screen.' : 'This copy is running in the browser. Charts and waypoints kept here do not move to the installed app: install first, then load your charts.'),
      installPrompt ? row('Install this app', 'Add it to this device', async () => {
        installPrompt.prompt();
        installPrompt = null;
      }) : null,
      heading('LOADING CHARTS'),
      note('Charts: PMTiles files (.pmtiles) with depth shapes, contour lines, depth grids or chart pictures. Surveys: GeoTIFF depth files (.tif). Copy them to the Files app, then Charts, Load a file from this phone.'),
      note('An MBTiles file must be converted first, on a computer: pmtiles convert chart.mbtiles chart.pmtiles (the free "pmtiles" tool from Protomaps).'),
      heading('PRIVACY'),
      note('Your position, waypoints and charts stay on this phone. The app only talks to the map servers of the maps you turn on, and to any web address you add yourself. They see the usual things a web request shows (your internet address and the area of map asked for). A survey in an unusual map projection makes the app ask epsg.io once for that projection\'s definition.'),
      heading('CREDITS'),
      note('Basemaps: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors (ODbL). OpenTopoMap (CC-BY-SA). USGS The National Map.'),
      note('Satellite: Sentinel-2 cloudless by EOX IT Services GmbH (https://s2maps.eu), contains modified Copernicus Sentinel data 2024, CC BY-NC-SA 4.0. Daily true colour: NASA Global Imagery Browse Services (GIBS).'),
      note('Built with MapLibre GL JS and PMTiles (BSD 3-Clause), geotiff.js and proj4js (MIT), and Open Sans (SIL Open Font Licence). SeaBathy itself is under the GNU GPL version 3.'),
      row('seabathy.com', 'The Android and Windows apps, and the guide', () => window.open('https://seabathy.com', '_blank', 'noopener')),
      row('Check for an update', 'The app updates itself when you are online', async () => {
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration) {
          toast('Offline use is not set up in this browser.');
          return;
        }
        await registration.update().catch(() => {});
        toast(registration.waiting || registration.installing ? 'An update is ready: tap the bar at the top to use it.' : 'This is the latest version.');
      }));
  });
}
