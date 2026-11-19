// The app's tests: it is opened in WebKit (Safari's engine) set up as an iPhone, over HTTPS on
// this computer, and used the way a person would.
//
//   npm test                 WebKit
//   ENGINE=chromium          the same steps in Chromium
//   HEADED=1                 shows the browser
//
// On Linux and on a Mac every check runs, in a browser profile kept on disk.
//
// WebKit on Windows is a cut-down build. With a profile kept on disk it fetches files very
// slowly, its service worker never finishes installing, and it can't write to private file
// storage at all ("Backend does not support this operation"). So on Windows the tests use a
// private window and leave out the three checks that need files kept on disk and a restart.
// Chromium runs those here, and so does WebKit in the Playwright container (see the README).
// PASS=kept runs the slow kept-profile pass on Windows anyway (service worker off), and
// PASS=both runs the two one after the other. A real iPhone has none of these limits.

import { webkit, chromium, devices } from 'playwright';
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve, appRoot, workDir } from './server.mjs';
import { writeFixtures, AREA, surveyDepth } from './fixtures.mjs';

const engineName = process.env.ENGINE || 'webkit';
const windowsWebkit = engineName === 'webkit' && process.platform === 'win32';
const pass = process.env.PASS || (windowsWebkit ? 'private' : 'kept');

// Both passes asked for: run each on its own and put the two tables together.
if (pass === 'both') {
  let failed = 0;
  const all = [];
  for (const one of ['private', 'kept']) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, ENGINE: engineName, PASS: one } });
    failed += run.status === 0 ? 0 : 1;
    try {
      all.push(...JSON.parse(readFileSync(path.join(workDir, `results-${engineName}-${one}.json`), 'utf8')).results.map((r) => ({ ...r, pass: one })));
    } catch { /* that pass didn't get as far as writing its results */ }
  }
  const ran = all.filter((r) => r.ok !== null);
  console.log(`\n${engineName}: ${ran.filter((r) => r.ok).length} of ${ran.length} checks passed over both passes.`);
  writeFileSync(path.join(workDir, `results-${engineName}.json`), JSON.stringify(all, null, 2));
  process.exit(failed ? 1 : 0);
}

/** A profile kept on disk, or a private window. */
const kept = pass === 'kept';
/** Picked files can be copied into the app's file storage here (see the note at the top). */
const stores = kept && !windowsWebkit;
/** The service worker is left off in Windows WebKit's kept profile. */
const worker = !(kept && windowsWebkit);
const APP_PORT = kept ? 8443 : 8453;
const DATA_PORT = APP_PORT + 1;
const APP = `https://localhost:${APP_PORT}/`;
const DATA = `https://localhost:${DATA_PORT}/`;
const engine = engineName === 'chromium' ? chromium : webkit;
const profile = path.join(workDir, `profile-${engineName}`);
const shots = path.join(workDir, 'shots', `${engineName}-${pass}`);
const FIX = { latitude: -20.21, longitude: 149.08, accuracy: 6 };
const MID = { lng: (AREA.west + AREA.east) / 2, lat: (AREA.south + AREA.north) / 2 };
/** WebKit with a kept profile is slow to fetch on Windows: the waits allow for it. */
const LOAD = 300000;

const results = [];
const problems = [];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Runs one check. [when] false leaves it out of this pass and says so. */
async function step(name, work, when = true) {
  if (!when) {
    results.push({ name, ok: null, note: 'not in this pass' });
    console.log(`skip  ${name}`);
    return;
  }
  const started = Date.now();
  try {
    const note = (await work()) || '';
    results.push({ name, ok: true, note });
    console.log(`PASS  ${name}${note ? `  (${note})` : ''}  ${Date.now() - started} ms`);
  } catch (error) {
    results.push({ name, ok: false, note: String(error.message || error).split('\n')[0] });
    console.log(`FAIL  ${name}\n      ${String(error.message || error).split('\n').slice(0, 3).join('\n      ')}`);
  }
}

const options = {
  ...devices['iPhone 15'],
  ignoreHTTPSErrors: true,
  permissions: ['geolocation'],
  geolocation: FIX,
  acceptDownloads: true,
  serviceWorkers: worker ? 'allow' : 'block'
};
const launchOptions = {
  headless: !process.env.HEADED,
  // Chromium won't start a service worker behind this computer's own certificate without this.
  ...(engineName === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {})
};
let browser = null;

async function launch() {
  if (kept) return engine.launchPersistentContext(profile, { ...options, ...launchOptions });
  browser = await engine.launch(launchOptions);
  return browser.newContext(options);
}

async function shut(context) {
  await context.close();
  await browser?.close();
  browser = null;
}

function watch(page) {
  // WebKit reports this harmless note about a resize it will handle a frame later as an error.
  page.on('pageerror', (error) => { if (!/ResizeObserver loop/.test(error.message)) problems.push(`page error: ${error.message}`); });
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource|net::ERR|certificate|openfreemap|eox|openstreetmap|could not connect|offline|ServiceWorker/i.test(message.text())) {
      problems.push(`console: ${message.text().slice(0, 200)}`);
    }
  });
}

/** Opens the app again and gets past the install screen and the agreement when they show. */
async function open(page) {
  await page.goto(APP, { waitUntil: 'load', timeout: LOAD });
  await page.waitForFunction(() => window.seabathy || !document.querySelector('#fatal').hidden, null, { timeout: LOAD });
  const fatal = await page.evaluate(() => (document.querySelector('#fatal').hidden ? null : document.querySelector('#fatal-text').textContent));
  expect(!fatal, `the app did not start: ${fatal}`);
  if (await page.locator('#install').isVisible()) await page.click('#install-skip');
  const agree = page.locator('#terms-agree');
  if (await agree.count()) {
    await agree.click();
    await page.click('#updates-ask');
  }
  await page.waitForFunction(() => window.seabathy.map.loaded(), null, { timeout: LOAD });
}

const charts = (page) => page.evaluate(() => window.seabathy.charts.list().map((c) => ({
  id: c.id, kind: c.kind, where: c.where, view: c.view, name: c.name, depthField: c.depthField, positiveDown: c.positiveDown, session: Boolean(c.session), ramp: c.ramp
})));

const waitFeatures = (page, id, layer) => page.waitForFunction(([chart, sourceLayer]) => {
  const map = window.seabathy.map;
  return map.getSource(`chart-${chart}`) && map.querySourceFeatures(`chart-${chart}`, { sourceLayer }).length > 0;
}, [id, layer], { timeout: 90000 });

const goTo = (page, lng, lat, zoom) => page.evaluate(([x, y, z]) => new Promise((resolve) => {
  const map = window.seabathy.map;
  map.once('idle', resolve);
  map.jumpTo({ center: [x, y], zoom: z });
}), [lng, lat, zoom]);

const openMenu = async (page, item) => {
  await page.evaluate(() => document.querySelector('#sheet-close').click());
  await page.click('#btn-menu');
  await page.click(`#${item}`);
};
const closeSheet = (page) => page.evaluate(() => document.querySelector('#sheet-close').click());
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {});
const only = (page, where) => page.evaluate((keep) => {
  for (const c of window.seabathy.charts.list()) {
    c.visible = keep === 'all' || c.where === keep;
    window.seabathy.charts.restyle(c, { save: false });
  }
}, where);
const tileOf = `(lng, lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [Math.floor(((lng + 180) / 360) * 2 ** z), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z)];
}`;

// ---------------------------------------------------------------- the run

rmSync(profile, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const fixtures = await writeFixtures(path.join(workDir, 'data'));
/** Files the app's server answers with something other than what is on disk (a newer version). */
const swap = new Map();
const appServer = await serve({ root: appRoot, port: APP_PORT, swap });
const dataServer = await serve({ root: path.join(workDir, 'data'), port: DATA_PORT, cors: true });
console.log(`\n${engineName} on ${process.platform}, set up as an iPhone 15, at ${APP}: ${kept ? 'a profile kept on disk' : 'a private window'}${worker ? '' : ', service worker off'}\n`);

let context = await launch();
let page = context.pages()[0] || await context.newPage();
watch(page);
let local = null;

await step('Opens over HTTPS; the install screen shows first, then the agreement', async () => {
  await page.goto(APP, { waitUntil: 'load', timeout: LOAD });
  await page.waitForFunction(() => window.seabathy || !document.querySelector('#fatal').hidden, null, { timeout: LOAD });
  const fatal = await page.evaluate(() => (document.querySelector('#fatal').hidden ? null : document.querySelector('#fatal-text').textContent));
  expect(!fatal, `the app did not start: ${fatal}`);
  expect(await page.locator('#install').isVisible(), 'no install screen in Safari mode');
  expect((await page.locator('#install').innerText()).includes('Add to Home Screen'), 'the install steps are missing');
  await shot(page, '1-install-screen');
  await page.click('#install-skip');
  await page.waitForSelector('#terms-agree');
  expect((await page.locator('.card').innerText()).includes('must not be used for navigation'), 'the agreement text is missing');
  await shot(page, '2-agreement');
  await page.click('#terms-agree');
  // Then, once: automatic updates, or a tap each time.
  await page.waitForSelector('#updates-ask');
  expect((await page.locator('.card').innerText()).includes('Keep SeaBathy up to date'), 'the question about updates is missing');
  await shot(page, '2b-updates');
  await page.click('#updates-ask');
  await page.waitForFunction(() => !document.querySelector('.overlay'));
  expect(await page.evaluate(() => window.seabathy.updates.mode()) === 'ask', 'the choice about updates was not kept');
  // The blank basemap for the tests: they then need nothing from the internet.
  await page.evaluate(() => window.seabathy.basemap.setBasemap('none'));
  await page.waitForFunction(() => window.seabathy.map.loaded() && Boolean(window.seabathy.map.getLayer('sb-top')), null, { timeout: LOAD });
  return page.evaluate(() => `secure context: ${window.isSecureContext}, version ${window.seabathy.version}`);
});

await step('The chart draws (WebGL) and shows the position under the crosshair', async () => {
  const info = await page.evaluate(() => {
    const canvas = window.seabathy.map.getCanvas();
    return { w: canvas.width, h: canvas.height, text: document.querySelector('#readout-pos').textContent, credits: document.querySelector('#credits').textContent };
  });
  expect(info.w > 0 && info.h > 0, 'the chart has no size');
  expect(/°.*′[NS] .*°.*′[EW]/.test(info.text), `the position reads "${info.text}"`);
  expect(info.credits.startsWith('Not for navigation'), 'the credit line does not lead with "Not for navigation"');
  return `${info.w}×${info.h} px`;
});

await step('The service worker installs, takes control and caches every app file', async () => {
  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    for (let i = 0; i < 600 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
    const names = await caches.keys();
    const cache = await caches.open(names.find((n) => n.startsWith('seabathy-')) || 'none');
    return { active: Boolean(registration.active), controlled: Boolean(navigator.serviceWorker.controller), names, files: (await cache.keys()).length };
  });
  expect(state.active, 'no active service worker');
  expect(state.controlled, 'the page is not controlled by the service worker');
  expect(state.files >= 30, `only ${state.files} files cached`);
  return `${state.files} files in ${state.names.join(', ')}`;
}, worker);

await step('Storage: private file storage is there, and the app asks to keep its data', async () => {
  const state = await page.evaluate(async () => ({
    opfs: await window.seabathy.files.available(),
    kept: await window.seabathy.files.keep(),
    storage: await window.seabathy.files.storage()
  }));
  expect(state.opfs, 'no private file storage (OPFS) in this browser');
  return `persist() answered ${state.kept}; quota ${state.storage.quota === null ? 'not told' : `${Math.round(state.storage.quota / 1e9)} GB`}${stores ? '' : '; this build of WebKit cannot write files there'}`;
}, kept);

await step(stores ? 'A PMTiles chart picked from a file is copied into the app\'s storage and drawn' : 'A PMTiles chart picked from a file is read and drawn (held in memory: no file storage to write to here)', async () => {
  await openMenu(page, 'menu-charts');
  await page.setInputFiles('#chart-file', fixtures.pmtiles);
  await page.waitForFunction(() => window.seabathy.charts.list().length === 1, null, { timeout: LOAD });
  [local] = await charts(page);
  expect(local.kind === 'pmtiles' && local.view === 'vector', `it was read as ${local.kind}/${local.view}`);
  expect(local.depthField === 'depth', `the depth value found was ${local.depthField}`);
  expect(local.session === !stores, stores ? 'it was only held in memory, not saved' : 'it claims to be saved where there is no file storage');
  await goTo(page, MID.lng, MID.lat, 10);
  await waitFeatures(page, local.id, 'bathymetry');
  await waitFeatures(page, local.id, 'contours');
  if (!stores) return `${fixtures.tiles} tiles, read from the picked file`;
  const saved = await page.evaluate(() => window.seabathy.files.list());
  expect(saved.some((f) => f.name.endsWith('.pmtiles') && f.size > 0), 'the chart file is not in the app\'s storage');
  return `${saved[0].size} bytes in the app's storage, ${fixtures.tiles} tiles`;
});

await step('Depth bands are coloured by a paint expression, and the depth shows at the crosshair', async () => {
  await page.waitForFunction(() => window.seabathy.charts.list()[0].positiveDown !== null, null, { timeout: 30000 });
  await page.waitForFunction(() => /^(5|15|30|60)\.0 m$|^20\.0 m line$/.test(document.querySelector('#readout-depth').textContent), null, { timeout: 30000 });
  const info = await page.evaluate(() => {
    const { map, charts: all } = window.seabathy;
    const chart = all.list()[0];
    const fill = map.getStyle().layers.find((l) => l.source === `chart-${chart.id}` && l.type === 'fill');
    return { paint: fill.paint['fill-color'], positiveDown: chart.positiveDown, ramp: chart.ramp, readout: document.querySelector('#readout-depth').textContent };
  });
  expect(Array.isArray(info.paint) && info.paint[0] === 'interpolate', 'the fill colour is not a depth expression');
  expect(info.positiveDown === true, 'the chart\'s positive depths were not recognised');
  await shot(page, '3-pmtiles-chart');
  return `crosshair ${info.readout}; range fitted to ${-info.ramp.shallowMetres} to ${-info.ramp.deepMetres} m`;
});

await step('The depth colour range and palette can be changed', async () => {
  await openMenu(page, 'menu-charts');
  await page.locator('#sheet-body .row').first().click();
  await page.selectOption('#ramp-palette', 'ocean');
  await page.fill('#ramp-from', '2');
  await page.fill('#ramp-to', '40');
  await page.locator('#ramp-to').dispatchEvent('change');
  await page.waitForFunction(() => {
    const { map, charts: all } = window.seabathy;
    const chart = all.list()[0];
    const fill = map.getStyle().layers.find((l) => l.source === `chart-${chart.id}` && l.type === 'fill');
    return chart.ramp.deepMetres === -40 && fill?.paint['fill-color'][3] === -40;
  }, null, { timeout: 10000 });
  const info = await page.evaluate(() => {
    const { map, charts: all } = window.seabathy;
    const chart = all.list()[0];
    const fill = map.getStyle().layers.find((l) => l.source === `chart-${chart.id}` && l.type === 'fill');
    return { ramp: chart.ramp, first: fill.paint['fill-color'][3], last: fill.paint['fill-color'].at(-2) };
  });
  expect(info.ramp.paletteId === 'ocean' && info.ramp.shallowMetres === -2, 'the range was not taken');
  expect(info.first === -40 && info.last === -2, `the expression runs from ${info.first} to ${info.last}`);
  await closeSheet(page);
  return 'Ocean blues, 2 to 40 m';
});

await step('A GeoTIFF depth survey loads, draws tiles and reads the right depth', async () => {
  await openMenu(page, 'menu-charts');
  await page.setInputFiles('#chart-file', fixtures.tiff);
  await page.waitForFunction(() => window.seabathy.charts.list().length === 2, null, { timeout: LOAD });
  const tiff = (await charts(page)).find((c) => c.kind === 'geotiff');
  expect(tiff && tiff.session === !stores, 'the survey was not kept as expected');
  await goTo(page, MID.lng, MID.lat, 11);
  const info = await page.evaluate(new Function('place', `return (async ([lng, lat]) => {
    const { map, charts: all } = window.seabathy;
    const chart = all.list().find((c) => c.kind === 'geotiff');
    const survey = await import('./js/survey.js');
    const [x, y] = (${tileOf})(lng, lat, 11);
    const picture = await survey.renderTile(chart, 11, x, y);
    const canvas = document.createElement('canvas');
    canvas.width = picture.width;
    canvas.height = picture.height;
    const context2d = canvas.getContext('2d');
    context2d.drawImage(picture, 0, 0);
    return {
      size: [picture.width, picture.height], pixel: [...context2d.getImageData(128, 128, 1, 1).data],
      depth: (await all.depthAt(map.project(map.getCenter()), { lng, lat })).depth,
      bounds: chart.bounds, ramp: chart.ramp, crs: chart.tiff.crs.label
    };
  })(place)`), [MID.lng, MID.lat]);
  expect(info.size[0] === 256 && info.pixel[3] === 255, `the tile's middle pixel is ${info.pixel}`);
  expect(Math.abs(info.depth - surveyDepth(MID.lng)) < 0.5, `depth ${info.depth} where ${surveyDepth(MID.lng)} was expected`);
  expect(Math.abs(info.bounds[0] - AREA.west) < 1e-3 && Math.abs(info.bounds[3] - AREA.north) < 1e-3, `bounds ${info.bounds}`);
  await page.waitForFunction(() => document.querySelector('#readout-depth').textContent === '35.0 m', null, { timeout: 30000 });
  await page.evaluate(() => new Promise((resolve) => (window.seabathy.map.areTilesLoaded() ? resolve() : window.seabathy.map.once('idle', resolve))));
  // The survey sits over the chart loaded before it, and stays there when that chart is redrawn.
  const order = await page.evaluate(() => {
    const { map, charts: all } = window.seabathy;
    all.restyle(all.list()[0]);
    const ids = map.getStyle().layers.map((l) => l.id);
    return ids.findIndex((i) => i.endsWith('-raster')) > ids.findIndex((i) => i.includes('-fill-'));
  });
  expect(order, 'redrawing the older chart put it over the survey');
  await page.waitForTimeout(800);
  await shot(page, '4-geotiff-survey');
  return `${info.crs}; depth ${info.depth.toFixed(1)} m at the middle; range fitted ${-info.ramp.shallowMetres} to ${-info.ramp.deepMetres} m`;
});

await step('A GeoTIFF in a UTM projection is placed and read correctly, then deleted', async () => {
  await openMenu(page, 'menu-charts');
  await page.setInputFiles('#chart-file', fixtures.utm);
  await page.waitForFunction(() => window.seabathy.charts.list().length === 3, null, { timeout: LOAD });
  const probe = fixtures.utmProbe;
  await goTo(page, probe.lng, probe.lat, 13);
  const info = await page.evaluate(new Function('place', `return (async ([lng, lat]) => {
    const chart = window.seabathy.charts.list().at(-1);
    const survey = await import('./js/survey.js');
    const [x, y] = (${tileOf})(lng, lat, 13);
    const picture = await survey.renderTile(chart, 13, x, y);
    return { crs: chart.tiff.crs.label, depth: await survey.depthAt(chart, lng, lat), tile: picture ? picture.width : 0, bounds: chart.bounds, maxZoom: chart.maxZoom };
  })(place)`), [probe.lng, probe.lat]);
  expect(/UTM 55S/.test(info.crs), `the projection was read as ${info.crs}`);
  // The seabed slopes 1 m in 500 m, so a few centimetres is a few cells.
  expect(Math.abs(info.depth - probe.depth) < 0.15, `depth ${info.depth} where ${probe.depth} was expected`);
  expect(info.tile === 256, 'no tile was drawn over the survey');
  expect(info.bounds[0] > AREA.west && info.bounds[2] < AREA.east + 0.1 && info.bounds[1] > AREA.south - 0.1 && info.bounds[3] < AREA.north, `bounds ${info.bounds}`);
  await page.waitForTimeout(600);
  await shot(page, '4b-utm-survey');
  await openMenu(page, 'menu-charts');
  await page.locator('#sheet-body .row').first().click();
  await page.click('#chart-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 2, null, { timeout: 10000 });
  if (stores) {
    // The files go a moment after the chart leaves the list.
    let files = 0;
    for (let i = 0; i < 40 && files !== 3; i++) {
      await page.waitForTimeout(150);
      files = await page.evaluate(async () => (await window.seabathy.files.list()).length);
    }
    expect(files === 3, `${files} files left in the app's storage after the delete`);
  }
  await closeSheet(page);
  return `${info.crs}; depth ${info.depth.toFixed(2)} m where ${probe.depth.toFixed(2)} m was written; zooms in to ${info.maxZoom}`;
});

await step('Get seabed depths: the area on screen is downloaded and kept as a depth layer', async () => {
  // The tests' own server stands in for the depth service, and sends back the test survey.
  await page.evaluate((url) => window.seabathy.seabed.useServer(url), `${DATA}seabed-service`);
  const requests = () => page.evaluate((prefix) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(prefix)), `${DATA}seabed-service`);
  await goTo(page, MID.lng, MID.lat, 10.5);
  await openMenu(page, 'menu-seabed');
  expect((await page.locator('.card').innerText()).includes('GMRT'), 'the download was not explained first');
  await page.click('#seabed-go');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 3, null, { timeout: LOAD });
  const info = await page.evaluate(() => {
    const c = window.seabathy.charts.list().at(-1);
    return { name: c.name, kind: c.kind, credit: c.attribution, flipped: c.tiff.flipped, min: c.tiff.min, max: c.tiff.max, session: Boolean(c.session), credits: document.querySelector('#credits').textContent };
  });
  const seabedAsked = await requests();
  expect(seabedAsked.length === 1, `the depth service was asked ${seabedAsked.length} times`);
  const asked = new URL(seabedAsked[0]).searchParams;
  // What was asked for is the area on screen, round the crosshair.
  expect(Math.abs((Number(asked.get('north')) + Number(asked.get('south'))) / 2 - MID.lat) < 0.01 && Math.abs((Number(asked.get('east')) + Number(asked.get('west'))) / 2 - MID.lng) < 0.01,
    `the area asked for was ${seabedAsked[0].split('?')[1]}`);
  expect(asked.get('format') === 'geotiff' && asked.get('layer') === 'topo', 'the request is not for a depth GeoTIFF');
  expect(/^Seabed 20\.20S 149\.10E/.test(info.name) && info.kind === 'geotiff', `it was saved as "${info.name}"`);
  expect(info.credit.includes('GMRT') && info.credits.includes('GMRT'), 'the depth data is not credited on the chart');
  expect(!info.flipped && info.min < -60 && info.max > -6, `its depths read ${info.min} to ${info.max}`);
  expect(info.session === !stores, 'the depths were not kept as expected');
  await page.waitForFunction(() => !document.querySelector('#btn-3d').hidden, null, { timeout: 10000 });
  // Asking again for the same area goes to the copy on the phone.
  await goTo(page, MID.lng, MID.lat, 10.5);
  await openMenu(page, 'menu-seabed');
  await page.click('#seabed-go');
  await page.waitForFunction(() => /already on this phone/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  expect((await requests()).length === 1, 'the same area was downloaded twice');
  return `${info.name}; ${info.min.toFixed(1)} to ${info.max.toFixed(1)} m`;
});

await step('High detail: in Australian waters, the 10 m composite is asked for from its own server and kept', async () => {
  await page.evaluate((url) => window.seabathy.seabed.useServer(url, 'imas'), `${DATA}high-detail-service`);
  const requests = () => page.evaluate((prefix) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(prefix)), `${DATA}high-detail-service`);
  // What is asked for a small area and for a big one: full detail, or thinned to fit a phone.
  const plans = await page.evaluate(async () => {
    const seabed = await import('./js/seabed.js');
    await (await import('./js/ui.js')).loadScript('vendor/proj4.js');
    const forward = (p) => window.proj4('EPSG:4326', '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs').forward(p);
    const small = seabed.highDetailPlan({ west: 149.0, south: -20.2, east: 149.1, north: -20.1 }, forward);
    const wide = seabed.highDetailArea({ west: 148, south: -21, east: 150, north: -19 });
    return { small, wide, big: seabed.highDetailPlan(wide, forward), outside: seabed.inAustralianWaters({ west: -10, south: 40, east: -9, north: 41 }), inside: seabed.inAustralianWaters({ west: 149, south: -20.2, east: 149.1, north: -20.1 }) };
  });
  expect(plans.small.scale === 1 && plans.small.detail === 10 && plans.small.cells < 2e6, `a 10 km area is planned as ${JSON.stringify(plans.small)}`);
  expect(plans.wide.trimmed && plans.big.scale < 1 && plans.big.cells <= 9e6 && plans.big.detail > 30 && plans.big.detail < 45, `a 200 km area is planned as ${JSON.stringify(plans.big)}`);
  expect(plans.inside && !plans.outside, 'Australian waters are not told from the rest');

  await goTo(page, MID.lng, MID.lat, 12);
  await openMenu(page, 'menu-seabed');
  const said = await page.locator('.card').innerText();
  expect(/High detail/.test(said) && /IMAS/.test(said) && /10 m detail/.test(said), 'the high-detail choice is not offered or explained');
  await page.click('#seabed-high');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 4, null, { timeout: LOAD });
  const asked = await requests();
  expect(asked.length === 1, `IMAS's server was asked ${asked.length} times`);
  const url = new URL(asked[0]);
  const subsets = url.searchParams.getAll('subset').join(' ');
  const [, e0, e1] = /E\(([-\d.]+),([-\d.]+)\)/.exec(subsets) || [];
  const [, n0, n1] = /N\(([-\d.]+),([-\d.]+)\)/.exec(subsets) || [];
  const [mx, my] = fixtures.albersMiddle;
  expect(url.searchParams.get('request') === 'GetCoverage' && url.searchParams.get('coverageId').endsWith('Aus_multires_bathymetry_composite_EEZ') && url.searchParams.get('format') === 'image/tiff',
    `the request was ${asked[0].split('?')[1].slice(0, 160)}`);
  // The box asked for is in the composite's own grid, round the middle of the screen, on whole 10 m cells.
  expect(Number(e0) < mx && Number(e1) > mx && Number(n0) < my && Number(n1) > my && Number(e0) % 10 === 0 && Number(n1) % 10 === 0, `the box asked for was ${subsets}`);
  expect(Number(e1) - Number(e0) < 30000 && Number(e1) - Number(e0) > 5000 && !url.searchParams.has('scalefactor'), `a screen at zoom 12 was asked for as ${subsets} ${url.searchParams.get('scalefactor') || ''}`);
  const probe = fixtures.albersProbe;
  const info = await page.evaluate(async ([lng, lat]) => {
    const c = window.seabathy.charts.list().at(-1);
    const survey = await import('./js/survey.js');
    return { name: c.name, credit: c.attribution, crs: c.tiff.crs.label, flipped: c.tiff.flipped, depth: await survey.depthAt(c, lng, lat), session: Boolean(c.session), credits: document.querySelector('#credits').textContent };
  }, [probe.lng, probe.lat]);
  expect(/^High detail 20\.20S 149\.10E/.test(info.name), `it was saved as "${info.name}"`);
  expect(/Albers/.test(info.crs) && !info.flipped, `it was read as ${info.crs}`);
  expect(Math.abs(info.depth - probe.depth) < 0.1, `depth ${info.depth} where ${probe.depth} was written`);
  expect(info.credit.includes('IMAS') && info.credits.includes('IMAS'), 'the IMAS composite is not credited on the chart');
  expect(info.session === !stores, 'the depths were not kept as expected');
  // Asking again for the same area goes to the copy on the phone.
  await goTo(page, MID.lng, MID.lat, 12);
  await openMenu(page, 'menu-seabed');
  await page.click('#seabed-high');
  await page.waitForFunction(() => /already on this phone/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  expect((await requests()).length === 1, 'the same area was downloaded twice');
  // Tidied away for the checks that follow.
  await openMenu(page, 'menu-charts');
  await page.locator('#sheet-body .row').first().click();
  await page.click('#chart-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 3, null, { timeout: 10000 });
  await closeSheet(page);
  return `${info.name}; ${info.crs}; ${info.depth.toFixed(2)} m where ${probe.depth.toFixed(2)} m was written; box ${Math.round((Number(e1) - Number(e0)) / 1000)} × ${Math.round((Number(n1) - Number(n0)) / 1000)} km at full detail`;
});

await step('3D: the seabed opens in 3D; height, a depth band, colours and a waypoint all work', async () => {
  await closeSheet(page);
  // The whole survey on screen and the chart at rest, so 3D opens on all of it.
  await goTo(page, MID.lng, MID.lat, 9.6);
  await page.click('#btn-3d');
  const inside = (work, arg) => page.evaluate(([code, value]) => {
    const w = document.querySelector('#view3d').contentWindow;
    return new Function('w', 'd', 'value', `return (${code})(w, d, value)`)(w, w.document, value);
  }, [work.toString(), arg]);
  const ready = () => page.waitForFunction(() => {
    const w = document.querySelector('#view3d')?.contentWindow;
    return w?.__terrainTest && w.__terrainTest.state().cols > 0 && w.__terrainTest.frames() > 2 && w.document.querySelector('#busy').hidden;
  }, null, { timeout: LOAD });
  await ready();
  const frame = page.frameLocator('#view3d');
  const first = await inside((w, d) => ({ ...w.__terrainTest.state(), tap: w.__terrainTest.tapCentre(), title: d.querySelector('#title').textContent, info: d.querySelector('#grid-info').textContent, palette: d.querySelector('#palette').value }));
  expect(first.title.startsWith('Seabed') && /cells/.test(first.info), `the 3D view says "${first.title}" and "${first.info}"`);
  expect(first.cols >= 128 && first.rows >= 128, `the grid is ${first.cols}×${first.rows}`);
  expect(first.min < -40 && first.max > -30 && first.min >= -65.5 && first.max <= -4.5, `the grid's depths run ${first.min} to ${first.max}`);
  expect(first.tap && first.tap.depth <= first.max && first.tap.depth >= first.min, `a tap in the middle read ${JSON.stringify(first.tap)}`);
  expect(first.palette === 'chart', 'it did not open with the chart\'s own colours');
  const credit3d = await inside((w, d) => (d.querySelector('#map-credit').hidden ? '' : d.querySelector('#map-credit').textContent));
  expect(credit3d.includes('GMRT'), `the depths' credit is not on the 3D view: "${credit3d}"`);
  await shot(page, '8-3d');

  // Height: 10 times.
  await frame.locator('[data-exag="10"]').click();
  await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().exaggeration === 10, null, { timeout: 10000 });

  // Just the water between 10 and 30 m, reloaded at full detail.
  await frame.locator('[data-tab="depth"]').click();
  await frame.locator('#clip-from').fill('-30');
  await frame.locator('#clip-to').fill('-10');
  await frame.locator('#clip-to').dispatchEvent('change');
  await frame.locator('#btn-isolate').click();
  await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().isolated, null, { timeout: LOAD });
  await ready();
  const band = await inside((w) => w.__terrainTest.state());
  expect(band.min >= -30.05 && band.max <= -9.95 && band.max - band.min > 15, `the 10 to 30 m band holds ${band.min} to ${band.max}`);
  expect(band.partial, 'the band is not marked as part of the layer');

  // Another palette, and colouring by slope.
  await frame.locator('[data-tab="colour"]').click();
  await frame.locator('#palette').selectOption('viridis');
  await frame.locator('#color-mode').selectOption('slope');
  await frame.locator('#color-mode').selectOption('depth');
  const frames = await inside((w) => w.__terrainTest.frames());
  await page.waitForTimeout(600);
  await shot(page, '9-3d-band');

  // Back to the whole layer.
  await frame.locator('[data-tab="depth"]').click();
  await frame.locator('#btn-show-all').click();
  await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().isolated === null, null, { timeout: LOAD });
  await ready();

  // A waypoint dropped on the seabed arrives in the app, with its depth.
  await frame.locator('#btn-wpt-mode').click();
  await frame.locator('#view canvas').click({ position: { x: 190, y: 190 } });
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 1, null, { timeout: 15000 });
  const dropped = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  expect(/m deep \(from the 3D view\)/.test(dropped.desc) && dropped.lng > 148.9 && dropped.lng < 149.3 && dropped.lat > -20.4 && dropped.lat < -20.0, `the waypoint is ${JSON.stringify(dropped)}`);

  expect(first.partial === false, 'with the whole survey on screen, 3D opened on only part of it');
  await frame.locator('#btn-close').click();
  await page.waitForFunction(() => !document.querySelector('#view3d') && !window.SeaBathy3D, null, { timeout: 10000 });
  // Tidied away for the checks that follow: the waypoint, then the depths.
  await openMenu(page, 'menu-waypoints');
  await page.locator('#wpt-list .row').first().click();
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 0);
  await openMenu(page, 'menu-charts');
  await page.locator('#sheet-body .row').first().click();
  await page.click('#chart-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 2, null, { timeout: 10000 });
  await closeSheet(page);
  return `${first.cols}×${first.rows} cells, ${first.info.trim()}; a tap read ${first.tap.depth.toFixed(1)} m; band ${band.min.toFixed(1)} to ${band.max.toFixed(1)} m; ${frames} frames drawn`;
});

await step('A waypoint is added at the crosshair, named and saved', async () => {
  await page.evaluate(() => window.seabathy.terrain.close());
  await closeSheet(page);
  await page.click('#btn-add');
  await page.waitForSelector('#wpt-name');
  const name = 'Reef edge & "bommie" <1>';
  await page.fill('#wpt-name', name);
  await page.fill('#wpt-desc', 'Good on the run-out tide');
  await page.locator('.swatch').nth(3).click();
  await page.locator('.icon-choice').nth(4).click();
  await page.click('#wpt-save');
  // Saved, and drawn on the chart under its new name.
  await page.waitForFunction((wanted) => document.querySelector('.wpt .wpt-name')?.textContent === wanted, name, { timeout: 10000 });
  const w = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  expect(w.name === name && w.color === '#22C55E' && w.icon === 'fish', `saved as ${JSON.stringify(w)}`);
  expect(await page.locator('.wpt').count() === 1, 'more than one marker for one waypoint');
  return `${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`;
});

await step('GPS: the boat shows, with speed and accuracy, and the chart follows it', async () => {
  await goTo(page, 150, -22, 9);
  await page.click('#btn-gps');
  await page.waitForSelector('#gps-hud:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(([lng, lat]) => {
    const centre = window.seabathy.map.getCenter();
    return Math.abs(centre.lng - lng) < 0.01 && Math.abs(centre.lat - lat) < 0.01;
  }, [FIX.longitude, FIX.latitude], { timeout: 20000 });
  const hud = await page.locator('#gps-hud').innerText();
  expect(/kn/.test(hud) && /±6 m/.test(hud), `the readout says "${hud}"`);
  // The crosshair is on the boat now, over the survey: its depth there.
  await page.waitForFunction(() => document.querySelector('#readout-depth').textContent === '32.0 m', null, { timeout: 15000 });
  expect(await page.locator('#boat').count() === 1, 'no boat marker');
  await shot(page, '5-gps');
  await page.click('#btn-gps');
  expect(await page.locator('#gps-hud').isHidden(), 'GPS did not turn off');
  return hud;
});

await step('GPX: export, delete the waypoint, import the file, and it comes back the same', async () => {
  const before = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  await openMenu(page, 'menu-waypoints');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#gpx-export')]);
  const gpxFile = path.join(workDir, 'data', `exported-${engineName}-${pass}.gpx`);
  await download.saveAs(gpxFile);
  const text = readFileSync(gpxFile, 'utf8');
  expect(text.includes('<gpx version="1.1" creator="SeaBathy"') && text.includes('&amp;') && text.includes('&lt;1&gt;'), 'the GPX file is not as expected');
  await page.locator('#wpt-list .row').first().click();
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 0);
  await page.setInputFiles('#gpx-file', gpxFile);
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 1, null, { timeout: 10000 });
  const after = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  for (const key of ['name', 'desc', 'color', 'icon']) expect(after[key] === before[key], `${key} came back as ${after[key]}`);
  expect(Math.abs(after.lat - before.lat) < 1e-6 && Math.abs(after.lng - before.lng) < 1e-6, 'the position moved');
  await page.setInputFiles('#gpx-file', gpxFile);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.seabathy.waypoints.list().length) === 1, 'importing the same file twice made a copy');
  await closeSheet(page);
  return `${text.length} bytes of GPX`;
});

await step('A web chart is read with part-file requests from another site', async () => {
  await openMenu(page, 'menu-charts');
  await page.fill('#chart-url', `${DATA}test-chart.pmtiles`);
  await page.click('#chart-add-url');
  await page.waitForFunction(() => window.seabathy.charts.list().some((c) => c.where === 'remote'), null, { timeout: 90000 });
  const remote = (await charts(page)).find((c) => c.where === 'remote');
  // The other charts are hidden so only the web chart is asked for tiles.
  await only(page, 'remote');
  await goTo(page, MID.lng, MID.lat, 10);
  await waitFeatures(page, remote.id, 'bathymetry');
  return remote.name;
});

await step('Save for offline: the area on screen is saved, at a gentle pace', async () => {
  await openMenu(page, 'menu-offline');
  // The least detail, so the save is a handful of tiles.
  await page.locator('#offline-detail').fill('10');
  const summary = await page.locator('#offline-summary').innerText();
  const started = Date.now();
  await page.click('#offline-save');
  await page.waitForFunction(() => window.seabathy.offline.list().length === 1, null, { timeout: 180000 });
  const pack = await page.evaluate(() => window.seabathy.offline.list()[0]);
  expect(pack.tiles > 0 && pack.failed === 0, `saved ${pack.tiles} tiles, ${pack.failed} failed`);
  const perSecond = pack.tiles / ((Date.now() - started) / 1000);
  expect(perSecond <= 22, `saved at ${perSecond.toFixed(1)} tiles a second`);
  await closeSheet(page);
  return `${pack.tiles} tiles, ${pack.bytes} bytes, zoom ${pack.minZoom} to ${pack.maxZoom}; the panel said "${summary}"`;
});

await step('Maps: satellite overlay with its opacity, a basemap change, and a bad tile link refused', async () => {
  await only(page, 'all');
  await openMenu(page, 'menu-maps');
  await page.locator('#sat-on').check();
  await page.waitForFunction(() => Boolean(window.seabathy.map.getLayer('sb-sat')), null, { timeout: 10000 });
  await page.waitForSelector('#sat-opacity');
  await page.locator('#sat-opacity').fill('0.35');
  await page.waitForFunction(() => window.seabathy.map.getPaintProperty('sb-sat', 'raster-opacity') === 0.35, null, { timeout: 5000 });
  const order = await page.evaluate(() => {
    const ids = window.seabathy.map.getStyle().layers.map((l) => l.id);
    return { chartsBelowSat: ids.findIndex((i) => i.startsWith('chart-')) < ids.indexOf('sb-sat'), credits: document.querySelector('#credits').textContent };
  });
  expect(order.chartsBelowSat, 'the satellite picture is not over the charts');
  expect(order.credits.includes('EOX'), 'the satellite credit is not shown');
  await page.fill('#custom-url', 'https://example.org/tiles/{z}/{x}.png');
  await page.click('#custom-save');
  expect((await page.locator('#toast').innerText()).includes('{z}, {x} and {y}'), 'a tile link without {y} was accepted');
  await page.click('#basemap-osm');
  await page.waitForFunction(() => window.seabathy.basemap.state.basemap === 'osm' && Boolean(window.seabathy.map.getLayer('sb-base')) && Boolean(window.seabathy.map.getLayer('sb-sat')), null, { timeout: 30000 });
  const changed = await page.evaluate(() => ({
    charts: window.seabathy.charts.list().every((c) => Boolean(window.seabathy.map.getSource(`chart-${c.id}`))),
    credits: document.querySelector('#credits').textContent
  }));
  expect(changed.charts, 'the charts did not come back after the basemap changed');
  expect(changed.credits.includes('OpenStreetMap contributors'), 'the new basemap is not credited');
  await page.click('#basemap-none');
  await page.waitForFunction(() => window.seabathy.basemap.state.basemap === 'none' && !window.seabathy.map.getLayer('sb-base') && Boolean(window.seabathy.map.getLayer('sb-sat')), null, { timeout: 30000 });
  await page.locator('#sat-on').uncheck();
  await closeSheet(page);
  return 'satellite at 35%; basemap changed to OpenStreetMap and back, charts and satellite put back each time';
});

await step(stores ? 'Reload: charts, their colours, the waypoint and the saved area are all still there' : 'Reload: the waypoint, the web chart, the saved area and the settings are still there', async () => {
  await only(page, 'all');
  await page.evaluate(() => Promise.all(window.seabathy.charts.list().map((c) => window.seabathy.charts.restyle(c))));
  await goTo(page, MID.lng, MID.lat, 10);
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'load', timeout: LOAD });
  await page.waitForFunction(() => window.seabathy?.map.loaded(), null, { timeout: LOAD });
  const state = await page.evaluate(() => ({
    charts: window.seabathy.charts.list().map((c) => (c.where === 'remote' ? 'web' : c.kind)), waypoints: window.seabathy.waypoints.list().length,
    packs: window.seabathy.offline.list().length, ramp: window.seabathy.charts.list()[0].ramp, zoom: window.seabathy.map.getZoom(),
    basemap: window.seabathy.basemap.state.basemap, terms: document.querySelector('#terms-agree') === null
  }));
  expect(state.charts.join() === (stores ? 'pmtiles,geotiff,web' : 'web'), `the charts after the reload: ${state.charts.join() || 'none'}`);
  expect(state.waypoints === 1 && state.packs === 1, `after reload: ${JSON.stringify(state)}`);
  if (stores) expect(state.ramp.paletteId === 'ocean' && state.ramp.deepMetres === -40, 'the colour range was not kept');
  expect(Math.abs(state.zoom - 10) < 0.01 && state.basemap === 'none', 'the view or basemap was not kept');
  expect(state.terms, 'the agreement was asked for again');
  if (stores) await waitFeatures(page, local.id, 'bathymetry');
  return `${state.charts.join(', ')}; 1 waypoint; 1 saved area`;
});

await step('Offline: with the network off, the app reloads from its own copy and the saved charts still draw', async () => {
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'load', timeout: LOAD });
    await page.waitForFunction(() => window.seabathy?.map.loaded(), null, { timeout: LOAD });
    if (stores) await waitFeatures(page, local.id, 'bathymetry');
    const remote = (await charts(page)).find((c) => c.where === 'remote');
    await only(page, 'remote');
    await goTo(page, MID.lng, MID.lat, 10);
    await waitFeatures(page, remote.id, 'bathymetry');
    const state = await page.evaluate(async ([lng, lat]) => {
      const survey = window.seabathy.charts.list().find((c) => c.kind === 'geotiff');
      return {
        online: navigator.onLine, waypoints: window.seabathy.waypoints.list().length, marker: document.querySelectorAll('.wpt').length,
        depth: survey ? await (await import('./js/survey.js')).depthAt(survey, lng, lat) : null
      };
    }, [MID.lng, MID.lat]);
    expect(state.waypoints === 1 && state.marker === 1, 'the waypoint is missing offline');
    if (stores) expect(Math.abs(state.depth - surveyDepth(MID.lng)) < 0.5, 'the survey does not read offline');
    await shot(page, '6-offline');
    return `navigator.onLine was ${state.online}; ${stores ? 'the chart file, the survey, ' : ''}the saved web-chart area and the waypoint all worked`;
  } finally {
    await context.setOffline(false);
  }
}, worker);

await step(stores ? 'Restart: after the browser is closed and opened again, everything is still there' : 'Restart: after the browser is closed and opened again, the waypoint, web chart and saved area are still there', async () => {
  await shut(context);
  context = await launch();
  page = context.pages()[0] || await context.newPage();
  watch(page);
  await open(page);
  const state = await page.evaluate(async () => ({
    charts: window.seabathy.charts.list().map((c) => c.kind + (c.where === 'remote' ? '-web' : '')),
    waypoints: window.seabathy.waypoints.list().map((w) => w.name), packs: window.seabathy.offline.list().length,
    files: ((await window.seabathy.files.list()) || []).length
  }));
  expect(state.charts.join() === (stores ? 'pmtiles,geotiff,pmtiles-web' : 'pmtiles-web'), `the charts after the restart: ${state.charts.join() || 'none'}`);
  expect(state.waypoints.length === 1 && state.packs === 1, `after restart: ${JSON.stringify(state)}`);
  await only(page, 'all');
  await goTo(page, MID.lng, MID.lat, 10);
  if (stores) {
    expect(state.files === 3, `${state.files} files in the app's storage (the chart, the survey and its overview were expected)`);
    await waitFeatures(page, local.id, 'bathymetry');
  } else {
    // The web chart's saved area draws with the network off.
    await context.setOffline(true);
    try {
      await goTo(page, MID.lng, MID.lat, 10.01);
      await waitFeatures(page, (await charts(page))[0].id, 'bathymetry');
    } finally {
      await context.setOffline(false);
    }
  }
  return `${state.charts.join(', ')}; waypoint "${state.waypoints[0]}"`;
}, kept);

await step('Storage: the space used is shown, and deleting a chart frees its file', async () => {
  await openMenu(page, 'menu-storage');
  await page.waitForFunction(() => /using|doesn't say/.test(document.querySelector('#storage-usage').textContent), null, { timeout: 10000 });
  const usage = await page.locator('#storage-usage').innerText();
  await page.locator('#sheet-body .row.danger').first().click();
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 2, null, { timeout: 10000 });
  let left = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    left = await page.evaluate(async () => (await window.seabathy.files.list()).map((f) => f.name.split('.').pop()));
    if (!left.includes('pmtiles')) break;
  }
  expect(!left.includes('pmtiles'), `files left: ${left}`);
  await closeSheet(page);
  await shot(page, '7-after-delete');
  return usage;
}, stores);

await step('Licences: SeaBathy\'s own, the libraries\' and the font\'s all read inside the app', async () => {
  await openMenu(page, 'menu-about');
  await page.click('#about-licences');
  const read = async (index, words) => {
    await page.locator('#sheet-body .row').nth(index).click();
    await page.waitForFunction((wanted) => wanted.every((w) => document.querySelector('#sheet-body .licence')?.textContent.includes(w)), words, { timeout: 20000 });
    const length = await page.evaluate(() => document.querySelector('#sheet-body .licence').textContent.length);
    await page.evaluate(() => document.querySelector('#sheet-back').click());
    return length;
  };
  const own = await read(0, ['GNU GENERAL PUBLIC LICENSE', 'Version 3']);
  const libraries = await read(1, ['maplibre-gl', 'pmtiles', 'geotiff', 'proj4', 'three', 'lerc', 'Apache License', 'Copyright 2015-2021 Esri', 'Mapbox']);
  const font = await read(2, ['SIL OPEN FONT LICENSE']);
  await shot(page, '8-licences');
  await closeSheet(page);
  return `${Math.round(own / 1000)}, ${Math.round(libraries / 1000)} and ${Math.round(font / 1000)} thousand characters`;
});

await step('Updates: "ask first" waits for a tap, "automatic" switches at the next start, and the charts stay', async () => {
  const sw = readFileSync(path.join(appRoot, 'sw.js'), 'utf8');
  const current = /const VERSION = '([^']+)'/.exec(sw)[1];
  const newer = (version) => swap.set('/sw.js', sw.replace(`const VERSION = '${current}'`, `const VERSION = '${version}'`));
  /** The version of the copy of the app now in charge of the page. */
  const inCharge = () => page.evaluate(() => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage('version', [channel.port2]);
    setTimeout(() => resolve(null), 3000);
  })).catch(() => null);
  /** Waits through the page loading again. */
  const until = async (what, check, ms = 90000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await Promise.resolve().then(check).catch(() => false)) return;
      if (Date.now() > end) {
        const seen = await page.evaluate(async () => {
          const r = await navigator.serviceWorker.getRegistration();
          return { started: Boolean(window.seabathy?.map.loaded()), app: typeof window.seabathy, mode: await window.seabathy?.updates.mode(), waiting: Boolean(r?.waiting), installing: Boolean(r?.installing), fatal: document.querySelector('#fatal')?.hidden === false, card: document.querySelector('.overlay')?.textContent.slice(0, 80) || null };
        }).catch((e) => String(e.message).split('\n')[0]);
        throw new Error(`${what} (${JSON.stringify(seen)})`);
      }
      await page.waitForTimeout(250);
    }
  };
  // The copy in charge can't be replaced while it is kept busy answering questions, so the
  // page is marked, and nothing is asked until it has opened again without the mark.
  const mark = () => page.evaluate(() => { window.beforeUpdate = true; });
  const reopened = () => page.evaluate(() => !window.beforeUpdate && Boolean(window.seabathy?.map.loaded()));
  const kept = () => page.evaluate(() => ({ charts: window.seabathy.charts.list().length, waypoints: window.seabathy.waypoints.list().length }));
  const before = await kept();
  expect(await inCharge() === current, `the copy in charge is not version ${current}`);

  // Ask first: found from About, and nothing changes on "Cancel".
  newer('9.9.1');
  await openMenu(page, 'menu-about');
  await page.click('#about-update');
  await page.waitForSelector('#confirm-yes', { timeout: 90000 });
  expect((await page.locator('.card').innerText()).includes('Version 9.9.1 is ready'), 'the card does not name the new version');
  await page.locator('.card .btn', { hasText: 'Cancel' }).click();
  await closeSheet(page);
  await page.waitForSelector('#update:not([hidden])');
  expect((await page.locator('#update').innerText()).includes('Version 9.9.1 is ready'), 'the bar does not name the new version');
  await shot(page, '9-update-ready');
  expect(await inCharge() === current, 'the new version took over before it was asked to');
  // A tap on the bar: the app opens again in the new version.
  await mark();
  await page.click('#update');
  await until('the app did not open again after the tap', reopened);
  expect(await inCharge() === '9.9.1', 'the new version did not take over after the tap');
  expect(await page.locator('#update').isHidden(), 'the bar is still there after the update');
  expect((await page.evaluate(() => caches.keys())).filter((n) => n.startsWith('seabathy-')).join() === 'seabathy-9.9.1', 'the old copy of the app was not cleared away');

  // Automatic: fetched quietly, and used from the next start.
  await page.evaluate(() => window.seabathy.updates.setMode('auto'));
  newer('9.9.2');
  expect(await page.evaluate(() => window.seabathy.updates.check()) === 'ready', 'the second new version was not fetched');
  expect(await page.locator('#update').isHidden(), 'the bar shows although updates are automatic');
  expect(await inCharge() === '9.9.1', 'the automatic update took over while the app was in use');
  await mark();
  await page.reload({ waitUntil: 'load', timeout: LOAD });
  await until('the app did not start again', reopened);
  expect(await inCharge() === '9.9.2', 'the automatic update was not used at the next start');
  const after = await kept();
  expect(after.charts === before.charts && after.waypoints === before.waypoints, `after the updates: ${JSON.stringify(after)}, before: ${JSON.stringify(before)}`);
  return `${current} to 9.9.1 after a tap, then to 9.9.2 by itself at the next start; ${after.charts} charts and ${after.waypoints} waypoint still there`;
}, worker);

await step('The app\'s own files: all listed for offline use, and one version number throughout', async () => {
  const sw = readFileSync(path.join(appRoot, 'sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',?$/gm)].map((m) => m[1]));
  const missing = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(appRoot, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(appRoot, rel)).isDirectory()) {
        if (rel !== 'vendor/licenses') walk(rel);
      } else if (!listed.has(rel) && !/LICENSE/i.test(name)) missing.push(rel);
    }
  };
  for (const dir of ['js', 'css', 'vendor', 'glyphs', 'icons', '3d']) walk(dir);
  for (const file of ['index.html', 'manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'glyphs/LICENSE.txt']) if (!listed.has(file)) missing.push(file);
  expect(!missing.length, `not listed for offline use: ${missing.join(', ')}`);
  const absent = [...listed].filter((file) => file !== './' && !existsSync(path.join(appRoot, file)));
  expect(!absent.length, `listed for offline use but not there: ${absent.join(', ')}`);
  const versions = [
    /const VERSION = '([^']+)'/.exec(sw)?.[1],
    /export const VERSION = '([^']+)'/.exec(readFileSync(path.join(appRoot, 'js/install.js'), 'utf8'))?.[1],
    JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
  ];
  expect(new Set(versions).size === 1, `the version numbers differ: ${versions.join(', ')}`);
  return `${listed.size} files, version ${versions[0]}`;
});

await shut(context);
appServer.close();
dataServer.close();

const ran = results.filter((r) => r.ok !== null);
const failed = ran.filter((r) => !r.ok);
console.log(`\n${ran.length - failed.length} of ${ran.length} passed in ${engineName} on ${process.platform} (${kept ? 'kept profile' : 'private window'})${results.length > ran.length ? `; ${results.length - ran.length} can't run in this set-up` : ''}.`);
if (problems.length) console.log(`\nErrors the page reported:\n  ${[...new Set(problems)].slice(0, 12).join('\n  ')}`);
writeFileSync(path.join(workDir, `results-${engineName}-${pass}.json`), JSON.stringify({ engine: engineName, pass, results, problems: [...new Set(problems)] }, null, 2));
process.exit(failed.length ? 1 : 0);
