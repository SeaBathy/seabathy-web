// The agreement shown before first use, the "add it to your Home Screen" screen an iPhone
// shows in Safari, and the About panel.

import { setting } from './db.js';
import * as updates from './updates.js';
import { add, button, card, closeSheet, confirmCard, el, openSheet, refreshSheet, topSheet, heading, note, row, toast, toggle } from './ui.js';

export const VERSION = '0.3.6';
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

/** The browser's own offer to install, where it makes one (Chrome, Edge, Brave and their kin). */
let installPrompt = null;
const INSTALL_TITLE = 'Install SeaBathy';
window.addEventListener('beforeinstallprompt', (event) => {
  // The browser's own small offer (Chrome on Android shows one) is left to show: the offer is
  // only kept here as well, for the Install button.
  installPrompt = event;
  if (topSheet()?.title === INSTALL_TITLE) refreshSheet();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('SeaBathy is installed. Open it from its own icon.', 6000);
});

/** Which browser this is, as far as installing goes. */
function browser() {
  const ua = navigator.userAgent;
  if (isIos()) return 'ios';
  const android = /Android/.test(ua);
  if (/Firefox\//.test(ua)) return android ? 'firefoxAndroid' : 'firefox';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg\//.test(ua)) return android ? 'chromeAndroid' : 'edge';
  // Brave, Opera and Vivaldi say they are Chrome, and install the same way.
  if (/Chrome\//.test(ua)) return android ? 'chromeAndroid' : 'chrome';
  if (/Safari\//.test(ua)) return 'safariMac';
  return 'other';
}

/** How to install by hand, browser by browser: a page can't do it itself except through installPrompt. */
const BY_HAND = {
  ios: ['iPhone and iPad', ['Open this page in Safari.', 'Tap the Share button (a square with an arrow pointing up). On newer iPhones it is under the ••• button.', 'Scroll down and tap Add to Home Screen, then Add.']],
  chromeAndroid: ['Chrome, Brave or Edge on Android', ['Open the browser\'s ⋮ menu.', 'Tap Add to Home screen, then Install.']],
  firefoxAndroid: ['Firefox on Android', ['Open the ⋮ menu.', 'Tap Add app to Home screen (on some versions it is called Install).']],
  samsung: ['Samsung Internet', ['Tap the ☰ menu at the bottom.', 'Tap Add to, then Home screen.']],
  chrome: ['Chrome or Brave on a computer', ['Click the install button at the right-hand end of the address bar (a small screen with an arrow).', 'If it isn\'t there, open the browser\'s menu and look for Install SeaBathy, under Save and share.']],
  edge: ['Edge on a computer', ['Open the ⋯ menu, then Apps, then Install this site as an app.']],
  safariMac: ['Safari on a Mac', ['In the menu bar choose File, then Add to Dock.']],
  firefox: ['Firefox on a computer', ['On Windows, recent versions have an "add to taskbar" button at the right-hand end of the address bar: it opens SeaBathy in a window of its own.', 'Otherwise Firefox on a computer can\'t install web apps. Press F11 for a full screen without the address bar, or open this address in Chrome, Edge or Brave and install it there.']],
  other: ['Another browser', ['Look for Install or Add to Home screen in the browser\'s menu.', 'On a computer, F11 gives a full screen without the address bar.']]
};

/** True where the app can still be installed: it is running in a browser tab. */
export const canInstall = () => !isStandalone();

/** "Install SeaBathy": one tap where the browser offers it, and the steps by hand for every browser. */
export function openInstall() {
  openSheet(INSTALL_TITLE, (body) => {
    const mine = browser();
    const steps = ([title, lines]) => [heading(title.toUpperCase()), el('ol', { class: 'steps' }, lines.map((text) => el('li', { text })))];
    add(body,
      note('Installed, SeaBathy opens from its own icon in a window of its own, without the browser\'s address bar. It is the same app, and still free.'),
      installPrompt ? el('div', { class: 'actions' }, button('Install now', async () => {
        const offer = installPrompt;
        installPrompt = null;
        offer.prompt();
        const choice = await offer.userChoice.catch(() => null);
        if (choice?.outcome === 'accepted') closeSheet();
        else refreshSheet();
      }, { primary: true, id: 'install-now' })) : null,
      steps([installPrompt ? 'Or by hand, in this browser' : 'In this browser', BY_HAND[mine][1]]),
      note(isIos()
        ? 'Install first, then get your depths: what Safari holds does not move to the installed app.'
        : 'What you have already downloaded in this browser is there in the installed app too.'),
      heading('OTHER BROWSERS'),
      Object.entries(BY_HAND).filter(([key]) => key !== mine && key !== 'other').map(([, [title, lines]]) => note(`${title}: ${lines.join(' ')}`)));
  });
}

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

/** The licence texts kept with the app, so they read with no signal. */
const LICENCES = [
  ['SeaBathy', 'GNU General Public License, version 3', 'LICENSE'],
  ['The libraries inside', 'MapLibre GL JS, PMTiles, three.js, geotiff.js, proj4js and what they are built from', 'THIRD-PARTY-NOTICES.txt'],
  ['Open Sans, the chart\'s lettering', 'SIL Open Font License 1.1', 'glyphs/LICENSE.txt']
];

function openLicence(title, file) {
  const text = el('pre', { class: 'licence', text: 'Loading…' });
  fetch(file).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then(
    (body) => { text.textContent = body; },
    () => { text.textContent = 'This text could not be loaded just now. It is also in the app\'s source code.'; });
  openSheet(title, (body) => add(body, text));
}

function openLicences() {
  openSheet('Licences', (body) => {
    add(body,
      note('SeaBathy is free software: you may use it, share it and change it under the GNU General Public License, version 3. It comes with no warranty.'),
      LICENCES.map(([title, detail, file]) => row(title, detail, () => openLicence(title, file))),
      note('Maps and depths are not part of the app: they come from their own servers, and their makers are credited under Credits in About.'));
  });
}

async function checkForUpdate() {
  toast('Looking for a newer version…');
  const answer = await updates.check();
  if (answer === 'unavailable') {
    toast('Offline use is not set up in this browser, so there is nothing to update.');
    return;
  }
  if (answer === 'offline') {
    toast('Could not look just now. Try again when you are online.');
    return;
  }
  if (answer === 'latest') {
    toast(`Version ${VERSION} is the latest.`);
    return;
  }
  const version = updates.readyVersion();
  if (await confirmCard(version ? `Version ${version} is ready` : 'A new version is ready', 'SeaBathy will close this panel and open again in the new version. Your depths, charts and waypoints stay.', 'Update now')) updates.useNow();
  else refreshSheet();
}

const INSTALL_STEPS = [
  'Open this page in Safari.',
  'Tap the Share button (a square with an arrow pointing up). On newer iPhones it is under the ••• button.',
  'Scroll down and tap Add to Home Screen.',
  'Leave "Open as Web App" on, then tap Add.',
  'Open SeaBathy from its new icon while you still have internet, so it can save itself for offline use.'
];

export function openAbout() {
  const auto = toggle('Update automatically', 'A newer version is used the next time you open the app. Off: a bar at the top waits for your tap.', false,
    (on) => updates.setMode(on ? 'auto' : 'ask'), 'updates-auto-switch');
  openSheet('About', (body) => {
    const ready = updates.readyVersion();
    add(body, 
      note(`SeaBathy web app, version ${VERSION}. Free and open source, with no account, ads or tracking.`),
      heading('NOT FOR NAVIGATION'),
      note(SUMMARY),
      POINTS.map(note),
      row('Full terms', TERMS_URL, () => window.open(TERMS_URL, '_blank', 'noopener')),
      heading('INSTALL ON AN IPHONE OR IPAD'),
      el('ol', { class: 'steps' }, INSTALL_STEPS.map((text) => el('li', { text }))),
      note(isStandalone() ? 'This copy is running from the Home Screen.' : 'This copy is running in the browser. Charts and waypoints kept here do not move to the installed app: install first, then load your charts.'),
      canInstall() ? row('Install SeaBathy', 'One tap where the browser allows it, and the steps for every other browser', openInstall, { id: 'about-install' }) : null,
      heading('GETTING DEPTHS'),
      note('Layers, Get seabed depths: draw a box on the chart over the water you want, and the app downloads free depths for it and keeps them on the phone. They work with no signal, and the 3D button flies you over them.'),
      note('In Australian waters you can choose High detail: the IMAS composite, 10 m on the shelf, sent by IMAS\'s own server. A box up to about 30 km square comes at the full 10 m; a bigger one comes coarser, so draw a small box for the spot that matters. Anywhere else, and as the other choice in Australia, the depths are the worldwide GMRT model.'),
      note('Your own files load too: GeoTIFF depth surveys (.tif), and PMTiles charts (.pmtiles) with depth shapes, contour lines or chart pictures. Copy them to the Files app, then Settings, Depths, Load GeoTIFF or PMTiles file.'),
      note('An MBTiles file must be converted first, on a computer: pmtiles convert chart.mbtiles chart.pmtiles (the free "pmtiles" tool from Protomaps).'),
      heading('PRIVACY'),
      note('Your position, waypoints and charts stay on this phone. The app talks only to: the map servers of the maps you turn on; the depth servers when you download depths (GMRT, or IMAS for high detail); its own web address, to look for a newer version of itself; and any web address you add yourself. They see the usual things a web request shows (your internet address and the area of map asked for). A survey in an unusual map projection makes the app ask epsg.io once for that projection\'s definition.'),
      heading('CREDITS'),
      note('High-detail depths: Flukes, E. (2026). Multi-resolution bathymetry composite surface for Australian waters (EEZ) [Dataset]. Institute for Marine and Antarctic Studies. https://doi.org/10.25959/Y9VF-V723. Licence: CC BY 4.0. Not to be used for navigation.'),
      note('Worldwide depths: GMRT, the Global Multi-Resolution Topography synthesis (Ryan et al. 2009), CC BY 4.0. Not to be used for navigation.'),
      note('SeaBathy shows both resampled to the screen and coloured, and a bigger area comes as a coarser grid. Their makers do not endorse SeaBathy.'),
      note('Marine park zones, from each authority\'s own zoning (all CC BY): Australian Marine Parks, DCCEEW; Great Barrier Reef Marine Park Authority; Queensland Government; NSW Department of Primary Industries (Fisheries); SA Department for Environment and Water; WA Department of Primary Industries and Regional Development; and CAPAD 2024, DCCEEW. A guide only: the official zoning map and rules for each park are the law.'),
      note('Reef and island names: Composite Gazetteer of Australia, Geoscience Australia and the states and territories (CC BY 4.0); Great Barrier Reef Features, Great Barrier Reef Marine Park Authority (CC BY 4.0). Boat ramps: © OpenStreetMap contributors (ODbL).'),
      note('Buoys, beacons, pipelines and cables (a beta layer, not for navigation): Transport for NSW, WA Department of Transport, Victorian and Queensland Governments, AMSA, NOPTA, Geoscience Australia, ACMA, and © OpenStreetMap contributors.'),
      note('Basemaps: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors (ODbL). OpenTopoMap: map data © OpenStreetMap contributors, SRTM; map style © OpenTopoMap (CC-BY-SA). USGS The National Map.'),
      note('Satellite: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0, for non-commercial use. Daily true colour: NASA Global Imagery Browse Services (GIBS), part of NASA\'s ESDIS.'),
      note('Built with MapLibre GL JS and PMTiles (BSD 3-Clause), three.js, geotiff.js and proj4js (MIT), and Open Sans (SIL Open Font Licence). SeaBathy itself is under the GNU GPL version 3.'),
      row('Licences', 'SeaBathy, the libraries inside it and the font', openLicences, { id: 'about-licences' }),
      row('seabathy.com', 'The Android and Windows apps, and the guide', () => window.open('https://seabathy.com', '_blank', 'noopener')),
      heading('UPDATES'),
      note('When you are online, SeaBathy looks at its own web address for a newer version and downloads it. Nothing about you or the phone is sent, and your depths, charts and waypoints stay through every update.'),
      auto,
      row(ready === null ? 'Check for an update' : (ready ? `Version ${ready} is ready` : 'A new version is ready'), ready === null ? `This is version ${VERSION}` : 'Tap to use it now', checkForUpdate, { id: 'about-update' }));
  });
  updates.mode().then((mode) => { auto.querySelector('input').checked = mode === 'auto'; });
}
