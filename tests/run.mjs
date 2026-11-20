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
import { writeFixtures, AREA, surveyDepth, withExif } from './fixtures.mjs';

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

/** Back to the chart: every panel closed, one Close at a time, then the Layers panel. */
const closeSheet = (page) => page.evaluate(() => {
  for (let i = 0; i < 12 && !document.querySelector('#sheet-layer').hidden; i++) document.querySelector('#sheet-close').click();
  if (!document.querySelector('#drawer').hidden) document.querySelector('#drawer-close').click();
});
/** Where each panel is: the taps that lead to it from the Layers panel. */
const PATHS = {
  'menu-seabed': ['#menu-seabed'],
  'menu-settings': ['#menu-settings'],
  'menu-install': ['#menu-settings', '#menu-install'],
  'menu-display': ['#menu-settings', '#settings-display'],
  'menu-charts': ['#menu-settings', '#menu-charts'],
  'menu-maps': ['#menu-settings', '#settings-maps', '#menu-maps'],
  'menu-offline': ['#menu-settings', '#settings-maps', '#menu-offline'],
  'menu-storage': ['#menu-settings', '#settings-maps', '#menu-storage'],
  'menu-boat': ['#menu-settings', '#settings-boat'],
  'menu-routes': ['#menu-settings', '#settings-boat', '#menu-routes'],
  'menu-places': ['#menu-settings', '#menu-places'],
  'menu-backup': ['#menu-settings', '#settings-backup'],
  'menu-about': ['#menu-settings', '#menu-about']
};
const openMenu = async (page, item) => {
  await closeSheet(page);
  await page.click('#btn-menu');
  for (const tap of PATHS[item]) await page.click(tap);
};
/** The Layers panel, opened from the chart. */
const openLayers = async (page) => {
  await closeSheet(page);
  await page.click('#btn-menu');
};
/** A layer's own panel (its depth colours and options): the newest layer's, or the one named. */
const openLayer = async (page, name = null) => {
  await openLayers(page);
  await (name ? page.locator('.layer', { hasText: name }) : page.locator('.layer:not(#layer-sat)')).first().locator('.layer-more').click();
};
/** Removes the newest layer with its Remove button in the Layers panel. */
const removeLayer = async (page) => {
  await openLayers(page);
  await page.locator('.layer:not(#layer-sat) .layer-remove').first().click();
  await page.click('#confirm-yes');
};
/** Picks a unit: Settings, Boat and navigation, the unit's row, then the choice. */
const setUnit = async (page, key, id) => {
  await openMenu(page, 'menu-boat');
  await page.click(`#boat-${key}`);
  await page.click(`#unit-${key}-${id}`);
};
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

// ---------------------------------------------------------------- drawing an area on the chart

/** The box the tests draw, as fractions of the screen: clear of the buttons and of the bar. */
const BOX = { from: [0.12, 0.2], to: [0.88, 0.58] };

/** Draws a box on the chart with the mouse, corner to corner, and waits for it to be taken. */
async function drawBox(page, from = BOX.from, to = BOX.to) {
  const { width, height } = page.viewportSize();
  await page.mouse.move(width * from[0], height * from[1]);
  await page.mouse.down();
  await page.mouse.move(width * (from[0] + to[0]) / 2, height * (from[1] + to[1]) / 2, { steps: 3 });
  await page.mouse.move(width * to[0], height * to[1], { steps: 3 });
  await page.mouse.up();
}

/** Where [BOX] is on the chart now, in degrees. */
const boxOnChart = (page) => page.evaluate(({ from, to }) => {
  const map = window.seabathy.map;
  const a = map.unproject([innerWidth * from[0], innerHeight * from[1]]);
  const c = map.unproject([innerWidth * to[0], innerHeight * to[1]]);
  return { west: Math.min(a.lng, c.lng), east: Math.max(a.lng, c.lng), south: Math.min(a.lat, c.lat), north: Math.max(a.lat, c.lat) };
}, BOX);

/** One finger on the chart: the kind of touch the app is sent on a phone. */
const finger = (page, type, x, y) => page.evaluate(([kind, px, py]) => {
  const target = window.seabathy.map.getCanvasContainer();
  const touch = { identifier: 1, clientX: px, clientY: py, pageX: px, pageY: py, target };
  const event = new Event(kind, { bubbles: true, cancelable: true });
  const down = kind === 'touchend' || kind === 'touchcancel' ? [] : [touch];
  Object.defineProperty(event, 'touches', { value: down });
  Object.defineProperty(event, 'targetTouches', { value: down });
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  target.dispatchEvent(event);
}, [type, x, y]);

/** A finger dragged from one point to another. */
async function fingerDrag(page, [x0, y0], [x1, y1]) {
  await finger(page, 'touchstart', x0, y0);
  for (let i = 1; i <= 4; i++) await finger(page, 'touchmove', x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * i) / 4);
  await finger(page, 'touchend', x1, y1);
}

/** The box as drawn on screen, or null while there is none. */
const boxOnScreen = (page) => page.evaluate(() => {
  const edge = document.querySelector('.area-edge');
  if (!edge || edge.style.display === 'none') return null;
  const n = (name) => Math.round(Number(edge.getAttribute(name)));
  return { x: n('x'), y: n('y'), w: n('width'), h: n('height'), tooBig: document.querySelector('.area-pick').classList.contains('too-big') };
});
const pickerSays = (page) => page.evaluate(() => ({
  size: document.querySelector('#area-size')?.textContent || '', info: document.querySelector('#area-info')?.textContent || '',
  ready: document.querySelector('#area-go') ? !document.querySelector('#area-go').disabled : null
}));
const pickerReady = (page) => page.waitForFunction(() => document.querySelector('#area-go') && !document.querySelector('#area-go').disabled, null, { timeout: 15000 });

/**
 * Clicks something that hands the person a file, and answers the file's text. Where the browser
 * has a share sheet for the file (a Mac, as on an iPhone) the app hands it there: a test can't
 * tap a share sheet, so it stands in for it. Elsewhere the file comes as a download.
 */
async function fileFrom(page, selector) {
  await page.evaluate(() => {
    window.sharedFile = null;
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.sharedFile = await data.files[0].text(); } });
  });
  const download = page.waitForEvent('download', { timeout: 30000 }).then(async (d) => {
    const target = path.join(workDir, 'data', `handed-${Date.now()}`);
    await d.saveAs(target);
    return readFileSync(target, 'utf8');
  });
  const shared = page.waitForFunction(() => window.sharedFile, null, { timeout: 30000 }).then((h) => h.jsonValue());
  download.catch(() => {});
  shared.catch(() => {});
  await page.click(selector);
  return Promise.any([download, shared]);
}

// ---------------------------------------------------------------- the run

rmSync(profile, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const fixtures = await writeFixtures(path.join(workDir, 'data'));
/** Files the app's server answers with something other than what is on disk (a newer version). */
const swap = new Map();
const appServer = await serve({ root: appRoot, port: APP_PORT, swap });
const dataServer = await serve({ root: path.join(workDir, 'data'), port: DATA_PORT, cors: true, any: new Map([['/xyz/', path.join(workDir, 'data', 'tile.png')]]) });
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
  await openLayer(page);
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
  await removeLayer(page);
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

await step('Depth layers: slope colours, contour lines with their depths, and shallow water marked in red', async () => {
  await closeSheet(page);
  await goTo(page, MID.lng, MID.lat, 11);
  const id = (await charts(page)).find((c) => c.kind === 'geotiff').id;
  const ramp = () => page.evaluate((chart) => window.seabathy.charts.byId(chart).ramp, id);
  // A tile of the survey as it is drawn: its middle pixel, and how many of its pixels are the stripes' red and white.
  const tile = (lng) => page.evaluate(new Function('place', `return (async ([lng, lat, id]) => {
    const s = window.seabathy;
    const [x, y] = (${tileOf})(lng, lat, 11);
    const picture = await s.survey.renderTile(s.charts.byId(id), 11, x, y);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context2d = canvas.getContext('2d');
    context2d.drawImage(picture, 0, 0);
    const data = context2d.getImageData(0, 0, 256, 256).data;
    let red = 0;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 229 && data[i + 1] === 20 && data[i + 2] === 30) red++;
      else if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
    }
    const middle = (128 * 256 + 128) * 4;
    return { middle: [data[middle], data[middle + 1], data[middle + 2], data[middle + 3]], red, white };
  })(place)`), [lng, MID.lat, id]);
  const near = (a, b, by = 5) => a.every((v, i) => Math.abs(v - b[i]) <= by);

  // Slope colours, on a made-up seabed of 10 m cells: flat, then 10 degrees, then 45.
  const made = await page.evaluate(() => {
    const { depth } = window.seabathy;
    const cols = 30;
    const rows = 6;
    const values = new Float32Array(cols * rows);
    const drop = [0, Math.tan((10 * Math.PI) / 180) * 10, 10];
    for (let r = 0; r < rows; r++) {
      let z = -50;
      for (let c = 0; c < cols; c++) {
        values[r * cols + c] = z;
        z -= drop[Math.floor(c / 10)];
      }
    }
    const ramp = { ...depth.defaultRamp(), shallowMetres: 0, deepMetres: -1000, colourBy: 'slope', slopeMax: 20, hillshadeExaggeration: 0 };
    const pixels = depth.renderDepth(values, cols, rows, ramp, { cellX: 10, cellY: 10, shallow: 0 });
    const slopes = depth.slopeDegrees(values, cols, rows, 10, 10);
    const at = (c) => [...pixels.slice((3 * cols + c) * 4, (3 * cols + c) * 4 + 3)];
    return { flat: at(4), mid: at(15), steep: at(25), degrees: [4, 15, 25].map((c) => slopes[3 * cols + c]) };
  });
  expect(Math.abs(made.degrees[0]) < 0.01 && Math.abs(made.degrees[1] - 10) < 0.05 && Math.abs(made.degrees[2] - 45) < 0.05, `the slopes were worked out as ${made.degrees}`);
  expect(near(made.flat, [23, 56, 128]) && near(made.mid, [245, 214, 66]) && near(made.steep, [199, 20, 26]), `flat, 10 degrees and 45 degrees were coloured ${JSON.stringify(made)}`);

  // On the chart: the layer's own panel offers it, and the survey (a gentle slope) turns the blue of flat seabed.
  const byDepth = await tile(MID.lng);
  await openLayer(page, 'test-survey');
  expect(await page.locator('#ramp-palette').isVisible() && await page.locator('#ramp-slope-max').count() === 0, 'the slope angle is offered before slope colours are chosen');
  await page.selectOption('#ramp-colour-by', 'slope');
  await page.waitForFunction((chart) => window.seabathy.charts.byId(chart).ramp.colourBy === 'slope' && document.querySelector('#ramp-slope-max'), id);
  expect(await page.locator('#ramp-palette').count() === 0 && /red is 20° or steeper/.test(await page.locator('#sheet-body').innerText()), 'the panel does not explain the slope colours');
  await page.selectOption('#ramp-slope-max', '5');
  await page.waitForFunction((chart) => window.seabathy.charts.byId(chart).ramp.slopeMax === 5 && /red is 5° or steeper/.test(document.querySelector('#sheet-body').innerText), id, { timeout: 10000 });
  const bySlope = await tile(MID.lng);
  expect(bySlope.middle[2] > 100 && bySlope.middle[0] < 60 && bySlope.middle[3] === 255 && !near(bySlope.middle, byDepth.middle, 30), `coloured by slope, the middle of the tile is ${bySlope.middle} (by depth it was ${byDepth.middle})`);
  await shot(page, '4b-slope-panel');
  await page.selectOption('#ramp-colour-by', 'depth');
  await page.waitForFunction((chart) => window.seabathy.charts.byId(chart).ramp.colourBy === 'depth' && document.querySelector('#ramp-palette'), id);
  expect(near((await tile(MID.lng)).middle, byDepth.middle, 1) && (await ramp()).slopeMax === 5, 'going back to depth colours did not bring them back as they were');

  // Contour lines. First the working out, on a made-up cone that deepens 2 m a cell from its top.
  const cone = await page.evaluate(() => {
    const { contours } = window.seabathy;
    const n = 41;
    const values = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) values[r * n + c] = -Math.hypot(c - 20, r - 20) * 2;
    const found = contours.trace(values, n, n, 10);
    const ten = found.find((f) => f.level === -10);
    const ring = ten.lines[0];
    const radii = ring.map(([x, y]) => Math.hypot(x - 20, y - 20));
    return {
      levels: found.map((f) => f.level), rings: ten.lines.length, closed: ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1],
      least: Math.min(...radii), most: Math.max(...radii), auto: contours.stepFor(-60, 0), wide: contours.stepFor(-3000, 0, 1),
      feet: [contours.labelFor(-20, { perMetre: 3.28084, label: 'ft' }), contours.labelFor(-1, { perMetre: 3.28084, label: 'ft' }), contours.labelFor(-20, { perMetre: 1, label: 'm' })]
    };
  });
  expect(cone.levels.join() === '-50,-40,-30,-20,-10,0' && cone.rings === 1 && cone.closed && cone.least > 4.7 && cone.most < 5.1, `the 10 m line round the cone: ${JSON.stringify(cone)}`);
  expect(cone.auto === 5 && cone.wide === 50 && cone.feet.join('|') === '66 ft|3.3 ft|20 m', `intervals and labels: ${JSON.stringify(cone)}`);

  // On the chart: switched on in the layer's panel, the lines are drawn where the survey has those depths.
  expect(await page.locator('#contour-every').count() === 0, 'the interval is offered before contour lines are on');
  await page.locator('#contour-on').check();
  await page.waitForSelector('#contour-every');
  await shot(page, '4c-contour-panel');
  await closeSheet(page);
  const lines = () => page.evaluate(async (chart) => {
    const s = window.seabathy;
    const data = s.contours.dataOf(chart);
    if (!data || !data.features.length) return null;
    const feature = data.features[Math.floor(data.features.length / 2)];
    const [lng, lat] = feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];
    return {
      count: data.features.length, step: data.step, labels: [...new Set(data.features.map((f) => f.properties.label))], depths: [...new Set(data.features.map((f) => f.properties.depth))],
      line: feature.properties.depth, there: -(await s.survey.depthAt(s.charts.byId(chart), lng, lat)),
      layers: [`contours-${chart}-line`, `contours-${chart}-label`].every((layer) => s.map.getLayer(layer)),
      order: s.map.getStyle().layers.map((l) => l.id)
    };
  }, id);
  await page.waitForFunction((chart) => window.seabathy.contours.dataOf(chart)?.features.length > 0, id, { timeout: 30000 });
  const auto = await lines();
  expect(auto.layers && auto.count >= 3 && [1, 2, 5, 10].includes(auto.step), `contour lines on: ${JSON.stringify({ ...auto, order: undefined })}`);
  expect(auto.depths.every((d) => d >= 5 && d <= 65 && Math.abs(d / auto.step - Math.round(d / auto.step)) < 1e-6) && auto.labels.every((l) => /^\d+ m$/.test(l)), `the lines are at ${auto.depths} m, labelled ${auto.labels}`);
  expect(Math.abs(auto.line - auto.there) < 0.5, `the ${auto.line} m line runs where the survey is ${auto.there} m deep`);
  expect(auto.order.indexOf(`contours-${id}-line`) > auto.order.indexOf(`chart-${id}-raster`), 'the lines are under the depths they belong to');
  await page.waitForTimeout(600);
  await shot(page, '4d-contours');
  // A line every 10 m, picked by hand.
  await openLayer(page, 'test-survey');
  await page.selectOption('#contour-every', '10');
  await page.waitForFunction((chart) => window.seabathy.contours.dataOf(chart)?.step === 10, id, { timeout: 30000 });
  const tens = await lines();
  expect(tens.depths.length >= 2 && tens.depths.every((d) => d % 10 === 0), `every 10 m gave lines at ${tens.depths}`);
  // The labels follow the depth unit chosen in Settings.
  await setUnit(page, 'depth', 'ft');
  await page.waitForFunction((chart) => window.seabathy.contours.dataOf(chart)?.features.every((f) => / ft$/.test(f.properties.label)), id, { timeout: 30000 });
  expect((await lines()).labels.includes('98 ft'), `in feet the 30 m line is not labelled 98 ft: ${(await lines()).labels}`);
  await setUnit(page, 'depth', 'm');
  await page.waitForFunction((chart) => window.seabathy.contours.dataOf(chart)?.features.every((f) => / m$/.test(f.properties.label)), id, { timeout: 30000 });
  // A hidden layer takes its lines with it; switched off, they go and the choice is remembered.
  await closeSheet(page);
  const linesShown = () => page.evaluate((chart) => Boolean(window.seabathy.map.getLayer(`contours-${chart}-line`)), id);
  await page.evaluate(async (chart) => { const c = window.seabathy.charts.byId(chart); c.visible = false; await window.seabathy.charts.restyle(c, { save: false }); }, id);
  expect(!(await linesShown()), 'a hidden layer left its contour lines on the chart');
  await page.evaluate(async (chart) => { const c = window.seabathy.charts.byId(chart); c.visible = true; await window.seabathy.charts.restyle(c, { save: false }); }, id);
  expect(await linesShown(), 'showing the layer again did not bring its contour lines back');
  await openLayer(page, 'test-survey');
  await page.locator('#contour-on').uncheck();
  await page.waitForFunction((chart) => !window.seabathy.map.getLayer(`contours-${chart}-line`) && !window.seabathy.map.getSource(`contours-${chart}`) && !document.querySelector('#contour-every'), id);
  expect(JSON.stringify(await page.evaluate((chart) => window.seabathy.charts.byId(chart).contours, id)) === '{"on":false,"metres":10}', 'switching the lines off did not keep the interval');
  if (stores) expect((await page.evaluate(() => window.seabathy.db.all('charts'))).find((c) => c.id === id).contours.metres === 10, 'the contour settings were not saved with the layer');

  // Shallow water in red: picked in Settings, striped on the survey where it is shallower, and off again.
  const WEST = AREA.west + 0.02;
  expect((await tile(WEST)).red === 0, 'there are red stripes before any depth is picked');
  await openMenu(page, 'menu-boat');
  expect(/Off/.test(await page.locator('#boat-shallow').innerText()), 'shallow water is marked before it is asked for');
  await page.click('#boat-shallow');
  await page.click('#shallow-20');
  await page.waitForFunction(() => /Shallower than 20 m/.test(document.querySelector('#boat-shallow')?.innerText || ''));
  expect(await page.evaluate(() => window.seabathy.depth.getShallowMark() === 20 && window.seabathy.db.setting.get('shallowMetres')) === 20, 'the depth picked was not kept');
  await shot(page, '4e-shallow-setting');
  await closeSheet(page);
  // West of the middle the survey is 5 to 20 m: stripes there, and none where it is 30 m and more.
  const shallow = await tile(WEST);
  const deep = await tile(MID.lng);
  expect(shallow.red > 5000 && shallow.white > 1500 && shallow.red < 3.5 * shallow.white, `the shallow tile has ${shallow.red} red and ${shallow.white} white pixels`);
  expect(deep.red === 0 && near(deep.middle, byDepth.middle, 1), `the tile over ${surveyDepth(MID.lng)} m has ${deep.red} red pixels`);
  // A chart of depth shapes is marked the same way, with a pattern over its shallow shapes.
  const shapes = await page.evaluate(() => {
    const s = window.seabathy;
    const layers = s.map.getStyle().layers.filter((l) => /-shallow-\d+$/.test(l.id));
    return { layers: layers.length, pattern: layers[0]?.paint['fill-pattern'], picture: s.map.hasImage('sb-shallow') };
  });
  expect(shapes.layers >= 1 && shapes.pattern === 'sb-shallow' && shapes.picture, `the depth shapes are marked with ${JSON.stringify(shapes)}`);
  await goTo(page, WEST + 0.03, MID.lat, 11);
  await page.waitForTimeout(800);
  await shot(page, '4f-shallow');
  await openMenu(page, 'menu-boat');
  await page.click('#boat-shallow');
  await page.click('#shallow-off');
  await page.waitForFunction(() => /Off/.test(document.querySelector('#boat-shallow')?.innerText || ''));
  await closeSheet(page);
  expect((await tile(WEST)).red === 0 && await page.evaluate(() => !window.seabathy.map.getStyle().layers.some((l) => /-shallow-\d+$/.test(l.id))), 'switched off, the red stripes stayed');
  await goTo(page, MID.lng, MID.lat, 11);
  return `slope ${made.degrees.map((v) => v.toFixed(0)).join('°, ')}°; ${auto.count} lines every ${auto.step} m, then every 10 m; ${shallow.red} red pixels where it is shallower than 20 m`;
});

await step('Choosing the area: it starts empty, a finger draws the box, moves it and resizes it, and nothing downloads until asked', async () => {
  await page.evaluate((url) => window.seabathy.seabed.useServer(url), `${DATA}seabed-service`);
  const requests = () => page.evaluate((prefix) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(prefix)), `${DATA}seabed-service`);
  const before = await page.evaluate(() => window.seabathy.charts.list().length);
  await goTo(page, MID.lng, MID.lat, 10.5);
  await openMenu(page, 'menu-seabed');
  const said = await page.locator('.card').innerText();
  expect(/draw/i.test(said) && said.includes('GMRT'), 'the card does not say the area is drawn on the chart');
  await page.click('#seabed-go');
  await page.waitForSelector('#area-bar');
  // Empty to start with: no box, nothing to confirm, and the menu out of the way.
  let says = await pickerSays(page);
  expect(await boxOnScreen(page) === null && says.ready === false && /^Drag/.test(says.size), `it did not start empty: ${JSON.stringify(says)}`);
  expect(await page.locator('#sheet').isHidden() && await page.locator('#btn-menu').isHidden(), 'the menu is still in the way');
  await shot(page, '4c-area-empty');
  // A finger dragged across the chart draws the box.
  await fingerDrag(page, [80, 150], [300, 380]);
  await pickerReady(page);
  let box = await boxOnScreen(page);
  says = await pickerSays(page);
  expect(box && Math.abs(box.x - 80) <= 1 && Math.abs(box.y - 150) <= 1 && Math.abs(box.w - 220) <= 2 && Math.abs(box.h - 230) <= 2, `the box drawn is ${JSON.stringify(box)}`);
  expect(/^\d[\d.]* km × \d[\d.]* km$/.test(says.size) && says.info.includes('GMRT'), `the bar says ${JSON.stringify(says)}`);
  await shot(page, '4d-area-drawn');
  // A drag inside the box moves it; a drag from a corner resizes it; a drag outside draws a new one.
  await fingerDrag(page, [190, 265], [220, 225]);
  box = await boxOnScreen(page);
  expect(Math.abs(box.x - 110) <= 2 && Math.abs(box.y - 110) <= 2 && Math.abs(box.w - 220) <= 2 && Math.abs(box.h - 230) <= 2, `after moving it the box is ${JSON.stringify(box)}`);
  await fingerDrag(page, [330, 340], [350, 400]);
  box = await boxOnScreen(page);
  expect(Math.abs(box.x - 110) <= 2 && Math.abs(box.y - 110) <= 2 && Math.abs(box.w - 240) <= 3 && Math.abs(box.h - 290) <= 3, `after resizing it the box is ${JSON.stringify(box)}`);
  await fingerDrag(page, [30, 160], [100, 250]);
  box = await boxOnScreen(page);
  expect(Math.abs(box.x - 30) <= 2 && Math.abs(box.y - 160) <= 2 && Math.abs(box.w - 70) <= 2 && Math.abs(box.h - 90) <= 2, `a new box drawn outside the old one is ${JSON.stringify(box)}`);
  // A touch that barely moves is not a box.
  await fingerDrag(page, [200, 300], [206, 304]);
  expect(JSON.stringify(await boxOnScreen(page)) === JSON.stringify(box), 'a slip of the finger changed the box');
  // The box belongs to the chart: it moves with it.
  await page.evaluate(() => window.seabathy.map.panBy([40, 0], { animate: false }));
  const moved = await boxOnScreen(page);
  expect(Math.abs(moved.x - (box.x - 40)) <= 2 && Math.abs(moved.w - box.w) <= 2, `after the chart moved 40 px the box is ${JSON.stringify(moved)}`);
  // Two fingers are for the chart: they zoom it and draw nothing (real touches, which only Chromium can be sent here).
  let pinch = 'two-finger zoom not tried in this browser';
  if (engineName === 'chromium') {
    const zoom = () => page.evaluate(() => window.seabathy.map.getZoom());
    const zoomBefore = await zoom();
    const cdp = await context.newCDPSession(page);
    const points = (gap) => [{ x: 200 - gap, y: 300, id: 1 }, { x: 200 + gap, y: 300, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
    for (const gap of [45, 60, 80, 100, 120]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(gap) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(700);
    const zoomAfter = await zoom();
    const kept = await boxOnScreen(page);
    expect(zoomAfter > zoomBefore + 0.5, `two fingers did not zoom the chart: ${zoomBefore.toFixed(2)} to ${zoomAfter.toFixed(2)}`);
    expect(kept && kept.w > moved.w * 1.3, `the box did not grow with the chart: ${JSON.stringify(kept)}`);
    pinch = `two fingers zoomed the chart from ${zoomBefore.toFixed(1)} to ${zoomAfter.toFixed(1)} and drew nothing`;
  }
  // Too big a box is shown as such and can't be confirmed.
  await page.evaluate(() => window.seabathy.map.jumpTo({ zoom: 4 }));
  await fingerDrag(page, [40, 150], [350, 400]);
  await page.waitForFunction(() => /^Too big/.test(document.querySelector('#area-info').textContent), null, { timeout: 5000 });
  box = await boxOnScreen(page);
  says = await pickerSays(page);
  expect(box.tooBig && says.ready === false, `a box hundreds of kilometres across was allowed: ${JSON.stringify(says)}`);
  await shot(page, '4e-area-too-big');
  // Cancel: everything as it was, and nothing was ever asked of the depth service.
  await page.click('#area-cancel');
  await page.waitForFunction(() => !document.querySelector('#area-bar') && !document.body.classList.contains('picking') && !document.querySelector('.area-pick'));
  expect(await page.locator('#btn-menu').isVisible(), 'the menu did not come back');
  expect((await requests()).length === 0, 'the depth service was asked although nothing was confirmed');
  expect(await page.evaluate(() => window.seabathy.charts.list().length) === before, 'a chart appeared without a download');
  await goTo(page, MID.lng, MID.lat, 10.5);
  return `drawn, moved, resized and redrawn by finger; ${pinch}`;
});

await step('Get seabed depths: the box drawn on the chart is downloaded and kept as a depth layer', async () => {
  // The tests' own server stands in for the depth service, and sends back the test survey.
  await page.evaluate((url) => window.seabathy.seabed.useServer(url), `${DATA}seabed-service`);
  const requests = () => page.evaluate((prefix) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(prefix)), `${DATA}seabed-service`);
  await goTo(page, MID.lng, MID.lat, 10.5);
  await openMenu(page, 'menu-seabed');
  expect((await page.locator('.card').innerText()).includes('GMRT'), 'the download was not explained first');
  await page.click('#seabed-go');
  await page.waitForSelector('#area-bar');
  const drawn = await boxOnChart(page);
  await drawBox(page);
  await pickerReady(page);
  expect((await requests()).length === 0, 'the depths were asked for before the box was confirmed');
  await page.click('#area-go');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 3, null, { timeout: LOAD });
  // The layer is drawn and credited a moment after it joins the list.
  await page.waitForFunction(() => document.querySelector('#credits').textContent.includes('GMRT'), null, { timeout: 10000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const c = window.seabathy.charts.list().at(-1);
    return { name: c.name, kind: c.kind, credit: c.attribution, flipped: c.tiff.flipped, min: c.tiff.min, max: c.tiff.max, session: Boolean(c.session), credits: document.querySelector('#credits').textContent };
  });
  const seabedAsked = await requests();
  expect(seabedAsked.length === 1, `the depth service was asked ${seabedAsked.length} times`);
  const asked = new URL(seabedAsked[0]).searchParams;
  // What was asked for is the box that was drawn (the service's smallest area, round its middle), not the screen.
  const want = { lat: (drawn.north + drawn.south) / 2, lng: (drawn.east + drawn.west) / 2 };
  const got = { north: Number(asked.get('north')), south: Number(asked.get('south')), east: Number(asked.get('east')), west: Number(asked.get('west')) };
  expect(Math.abs((got.north + got.south) / 2 - want.lat) < 0.003 && Math.abs((got.east + got.west) / 2 - want.lng) < 0.003 && Math.abs(want.lat - MID.lat) > 0.01,
    `the box was round ${want.lat.toFixed(3)}, ${want.lng.toFixed(3)} and the area asked for was ${seabedAsked[0].split('?')[1]}`);
  expect(got.north - got.south >= drawn.north - drawn.south - 1e-6 && got.north - got.south < 0.3 && got.east - got.west < 0.3, `the area asked for spans ${(got.north - got.south).toFixed(3)}° by ${(got.east - got.west).toFixed(3)}°`);
  expect(asked.get('format') === 'geotiff' && asked.get('layer') === 'topo', 'the request is not for a depth GeoTIFF');
  expect(/^Seabed 20\.\d\dS 149\.\d\dE/.test(info.name) && info.kind === 'geotiff', `it was saved as "${info.name}"`);
  expect(info.credit.includes('GMRT') && info.credits.includes('GMRT'), 'the depth data is not credited on the chart');
  expect(!info.flipped && info.min < -60 && info.max > -6, `its depths read ${info.min} to ${info.max}`);
  expect(info.session === !stores, 'the depths were not kept as expected');
  await page.waitForFunction(() => !document.querySelector('#btn-3d').hidden, null, { timeout: 10000 });
  // Asking again for the same area goes to the copy on the phone.
  await goTo(page, MID.lng, MID.lat, 10.5);
  await openMenu(page, 'menu-seabed');
  await page.click('#seabed-go');
  await page.waitForSelector('#area-bar');
  await drawBox(page);
  await pickerReady(page);
  await page.click('#area-go');
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
  await page.waitForSelector('#area-bar');
  expect((await page.locator('#area-bar').innerText()).toUpperCase().includes('HIGH-DETAIL DEPTHS'), 'the bar does not say which depths the box is for');
  const drawn = await boxOnChart(page);
  await drawBox(page);
  await pickerReady(page);
  const told = await pickerSays(page);
  expect(/full 10 m detail/.test(told.info) && /KB|MB/.test(told.info), `the bar says "${told.info}" about a box a few kilometres across`);
  await shot(page, '4f-area-high-detail');
  expect((await requests()).length === 0, 'the depths were asked for before the box was confirmed');
  await page.click('#area-go');
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
  // What is asked for is the box that was drawn, in the composite's own grid, on whole 10 m cells.
  const corners = await page.evaluate((b) => {
    const forward = (p) => window.proj4('EPSG:4326', '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs').forward(p);
    const all = [[b.west, b.south], [b.west, b.north], [b.east, b.south], [b.east, b.north]].map(forward);
    return { e0: Math.min(...all.map((p) => p[0])), e1: Math.max(...all.map((p) => p[0])), n0: Math.min(...all.map((p) => p[1])), n1: Math.max(...all.map((p) => p[1])) };
  }, drawn);
  expect(Number(e0) % 10 === 0 && Number(n1) % 10 === 0 && Number(e0) < mx && Number(e1) > mx && Number(n0) < my && Number(n1) > my, `the box asked for was ${subsets}`);
  expect(Math.abs(Number(e0) - corners.e0) < 40 && Math.abs(Number(e1) - corners.e1) < 40 && Math.abs(Number(n0) - corners.n0) < 40 && Math.abs(Number(n1) - corners.n1) < 40,
    `the box drawn is E ${Math.round(corners.e0)} to ${Math.round(corners.e1)}, N ${Math.round(corners.n0)} to ${Math.round(corners.n1)}, and what was asked for is ${subsets}`);
  expect(Number(e1) - Number(e0) < 30000 && Number(e1) - Number(e0) > 3000 && !url.searchParams.has('scalefactor'), `a box drawn at zoom 12 was asked for as ${subsets} ${url.searchParams.get('scalefactor') || ''}`);
  const probe = fixtures.albersProbe;
  const info = await page.evaluate(async ([lng, lat]) => {
    const c = window.seabathy.charts.list().at(-1);
    const survey = await import('./js/survey.js');
    return { name: c.name, credit: c.attribution, crs: c.tiff.crs.label, flipped: c.tiff.flipped, depth: await survey.depthAt(c, lng, lat), session: Boolean(c.session), credits: document.querySelector('#credits').textContent };
  }, [probe.lng, probe.lat]);
  expect(/^High detail 20\.\d\dS 149\.\d\dE/.test(info.name), `it was saved as "${info.name}"`);
  expect(/Albers/.test(info.crs) && !info.flipped, `it was read as ${info.crs}`);
  expect(Math.abs(info.depth - probe.depth) < 0.1, `depth ${info.depth} where ${probe.depth} was written`);
  expect(info.credit.includes('IMAS') && info.credits.includes('IMAS'), 'the IMAS composite is not credited on the chart');
  expect(info.session === !stores, 'the depths were not kept as expected');
  // Asking again for the same area goes to the copy on the phone.
  await goTo(page, MID.lng, MID.lat, 12);
  await openMenu(page, 'menu-seabed');
  await page.click('#seabed-high');
  await page.waitForSelector('#area-bar');
  await drawBox(page);
  await pickerReady(page);
  await page.click('#area-go');
  await page.waitForFunction(() => /already on this phone/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  expect((await requests()).length === 1, 'the same area was downloaded twice');
  // Tidied away for the checks that follow.
  await removeLayer(page);
  await page.waitForFunction(() => window.seabathy.charts.list().length === 3, null, { timeout: 10000 });
  await closeSheet(page);
  return `${info.name}; ${info.crs}; ${info.depth.toFixed(2)} m where ${probe.depth.toFixed(2)} m was written; box ${Math.round((Number(e1) - Number(e0)) / 1000)} × ${Math.round((Number(n1) - Number(n0)) / 1000)} km at full detail`;
});

await step('A download that fails says why: a server that does not answer is not called "no internet"', async () => {
  const before = await page.evaluate(() => window.seabathy.charts.list().length);
  const attempt = async (address) => {
    await page.evaluate((url) => window.seabathy.seabed.useServer(url, 'imas'), address);
    await goTo(page, MID.lng, MID.lat, 12);
    await openMenu(page, 'menu-seabed');
    await page.click('#seabed-high');
    await page.waitForSelector('#area-bar');
    await drawBox(page);
    await pickerReady(page);
    await page.click('#area-go');
    await page.waitForSelector('#seabed-failed-ok', { timeout: 60000 });
    const said = `${await page.locator('.card').innerText()} [link: ${await page.locator('#seabed-check').count() ? await page.locator('#seabed-check').getAttribute('href') : 'none'}]`;
    await page.click('#seabed-failed-ok');
    await page.waitForFunction(() => !document.querySelector('.overlay'));
    return said;
  };
  // Nothing listens at this address: the request never gets an answer, and is tried twice.
  const silent = await attempt('https://localhost:59999/nothing');
  expect(/IMAS's server did not answer/.test(silent) && /internet may be fine/.test(silent) && !/no internet|offline/i.test(silent), `with no answer the app said: ${silent.replace(/\s+/g, ' ')}`);
  // The card gives a link that really tests the server (a picture it draws), not its front page, which is an error page.
  expect(/test picture/.test(silent) && /\[link: https:\/\/geoserver\.imas\.utas\.edu\.au\/geoserver\/bathy_composites\/wms\?.*GetMap/.test(silent) && !/geoserver\/web/.test(silent) && /The browser said: /.test(silent),
    `the card gives nothing to check with: ${silent.replace(/\s+/g, ' ')}`);
  // An address that answers, but not with depths.
  const wrong = await attempt(`${DATA}no-such-service`);
  expect(/IMAS's server answered 404/.test(wrong), `to a "404" the app said: ${wrong.replace(/\s+/g, ' ')}`);
  expect(await page.evaluate(() => window.seabathy.charts.list().length) === before, 'a failed download left a layer behind');
  await page.evaluate((url) => window.seabathy.seabed.useServer(url, 'imas'), `${DATA}high-detail-service`);
  return 'no answer: "did not answer, your internet may be fine"; a 404: "answered 404"';
});

await step('3D: the seabed opens in 3D; height, a depth band, colours, the boat and a waypoint all work', async () => {
  await closeSheet(page);
  // The whole survey on screen and the chart at rest, so 3D opens on all of it.
  await goTo(page, MID.lng, MID.lat, 9.6);
  // Water shallower than 40 m is to be marked in red: the 3D view takes that from the app when it opens.
  await page.evaluate(() => window.seabathy.depth.setShallowMark(40));
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
  // Shallow water has red stripes over it: the picture changes where the seabed is above 40 m, and
  // not at all for a depth shallower than the whole survey.
  expect(first.shallow === 40, `3D opened marking water shallower than ${first.shallow} m, not 40 m`);
  await shot(page, '8-3d-shallow');
  const striped = await inside(async (w, d) => {
    const pixels = async () => {
      const image = new w.Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = w.__terrainTest.picture(); });
      const canvas = d.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context2d = canvas.getContext('2d');
      context2d.drawImage(image, 0, 0);
      return context2d.getImageData(0, 0, image.width, image.height).data;
    };
    const changed = (a, b) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) count++;
      return count;
    };
    const marked = await pixels();
    w.__terrainTest.shallowTo(1);
    const tooShallow = await pixels();
    w.__terrainTest.shallowTo(0);
    const plain = await pixels();
    return { stripes: changed(marked, plain), none: changed(tooShallow, plain) };
  });
  expect(striped.stripes > 300 && striped.none < 30, `the stripes changed ${striped.stripes} pixels of the 3D picture, and ${striped.none} for a depth shallower than the survey`);
  await page.evaluate(() => { window.seabathy.depth.setShallowMark(0); window.seabathy.charts.redrawDepths(); });
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

  // A tap on the seabed reads the depth and puts a ball there, which stays while the view is turned and goes with the readout.
  await frame.locator('#view canvas').click({ position: { x: 190, y: 190 } });
  const corner = await inside((w, d) => { const box = d.querySelector('#view canvas').getBoundingClientRect(); return { x: box.left, y: box.top }; });
  const ballAt = () => inside((w) => w.__terrainTest.tapMark());
  const onSpot = (ball) => Boolean(ball) && Math.abs(ball.x - (corner.x + 190)) < 4 && Math.abs(ball.y - (corner.y + 190)) < 4;
  let ball = null;
  for (let i = 0; i < 50 && !onSpot(ball); i++) {
    await page.waitForTimeout(100);
    ball = await ballAt();
  }
  expect(onSpot(ball), `the ball is at ${JSON.stringify(ball)}, not where the seabed was tapped (${corner.x + 190}, ${corner.y + 190})`);
  expect(await inside((w, d) => !d.querySelector('#readout').hidden && /[0-9] m/.test(d.querySelector('#readout').textContent)), 'the depth is not shown with the ball');
  await shot(page, '8c-3d-tap');
  const view = await page.locator('#view3d').boundingBox();
  // The drag starts on the seabed, clear of the readout and the options below.
  await page.mouse.move(view.x + 60, view.y + 240);
  await page.mouse.down();
  await page.mouse.move(view.x + 150, view.y + 255, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const turned = await ballAt();
  expect(turned && await inside((w, d) => !d.querySelector('#readout').hidden), 'turning the view took the ball or the depth away');
  expect(!onSpot(turned), 'the ball did not move with the seabed when the view was turned');
  await frame.locator('#readout-close').click();
  expect(await ballAt() === null, 'the ball stayed after the readout was closed');

  // The boat: the 3D view's Boat button turns the GPS on, and the boat shows on the water with the depth under it and a line down to the seabed.
  const boat = () => inside((w, d) => {
    const label = d.querySelector('.boat-label');
    const chip = d.querySelector('#boat-chip');
    return { ...(w.__terrainTest.boat() || {}), label: label && label.style.display !== 'none' ? label.textContent : null, chip: chip.hidden ? null : chip.textContent };
  });
  const boatShown = async (tries = 150) => {
    let seen = await boat();
    for (let i = 0; i < tries && !(seen.label && seen.radius); i++) {
      await page.waitForTimeout(100);
      seen = await boat();
    }
    return seen;
  };
  // The ring is drawn 14 px from the boat's middle: it must be seen, and must not fill the screen.
  const ringFits = (seen) => seen.radius > 11 && seen.radius < 18;
  expect((await boat()).label === null, 'a boat shows in 3D with the GPS off');
  await inside((w, d) => d.querySelector('#btn-boat').click());
  let afloat = await boatShown();
  expect(/^You · [0-9.]+ m deep$/.test(afloat.label || '') && /m deep/.test(afloat.chip || ''), `with the GPS on over the survey, 3D says ${JSON.stringify(afloat)}`);
  expect(ringFits(afloat), `with the whole survey in view, the boat's ring reaches ${afloat.radius} px from its middle`);
  expect(afloat.line > 0, 'no line runs from the boat down to the seabed');
  await shot(page, '8d-3d-boat');
  // The Boat button again brings the boat to the middle; a double tap beside it flies in, and the boat is still the same size.
  await inside((w, d) => d.querySelector('#btn-boat').click());
  await page.waitForTimeout(500);
  const middle = await boat();
  await page.mouse.dblclick(view.x + middle.x, view.y + middle.y + 18);
  await page.waitForTimeout(1500);
  const near = await boat();
  expect(near.distance < middle.distance * 0.9, `a double tap did not fly in: ${middle.distance} then ${near.distance}`);
  expect(ringFits(near), `closer in, the boat's ring reaches ${near.radius} px from its middle`);
  await shot(page, '8e-3d-boat-near');
  if (await inside((w, d) => !d.querySelector('#readout').hidden)) await frame.locator('#readout-close').click();

  // A waypoint dropped on the seabed arrives in the app, with its depth.
  await frame.locator('#btn-wpt-mode').click();
  await frame.locator('#view canvas').click({ position: { x: 190, y: 190 } });
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 1, null, { timeout: 15000 });
  const dropped = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  expect(/m deep \(from the 3D view\)/.test(dropped.desc) && dropped.lng > 148.9 && dropped.lng < 149.3 && dropped.lat > -20.4 && dropped.lat < -20.0, `the waypoint is ${JSON.stringify(dropped)}`);

  expect(first.partial === false, 'with the whole survey on screen, 3D opened on only part of it');
  await frame.locator('#btn-close').click();
  await page.waitForFunction(() => !document.querySelector('#view3d') && !window.SeaBathy3D, null, { timeout: 10000 });
  // With the GPS on already, the boat is there as soon as 3D opens: it does not wait for the phone's next report.
  await page.click('#btn-3d');
  await ready();
  afloat = await boatShown(30);
  expect(/^You · [0-9.]+ m deep$/.test(afloat.label || '') && ringFits(afloat), `opened with the GPS on, 3D shows ${JSON.stringify(afloat)}`);
  await frame.locator('#btn-close').click();
  await page.waitForFunction(() => !document.querySelector('#view3d') && !window.SeaBathy3D, null, { timeout: 10000 });
  await page.click('#btn-gps');
  if (await page.locator('#gps-hud').isVisible()) await page.click('#btn-gps');
  expect(await page.locator('#gps-hud').isHidden(), 'the GPS did not turn off after the 3D view');
  // The chart followed the boat: back to where this check began, for the checks that follow.
  await goTo(page, MID.lng, MID.lat, 9.6);
  // Tidied away for the checks that follow: the waypoint, then the depths.
  await openLayers(page);
  await page.locator('#wpt-list .wrow-edit').first().click();
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 0);
  await removeLayer(page);
  await page.waitForFunction(() => window.seabathy.charts.list().length === 2, null, { timeout: 10000 });
  await closeSheet(page);
  return `${first.cols}×${first.rows} cells, ${first.info.trim()}; a tap read ${first.tap.depth.toFixed(1)} m; band ${band.min.toFixed(1)} to ${band.max.toFixed(1)} m; ${frames} frames drawn`;
});

await step('A waypoint is added at the crosshair, named and saved', async () => {
  await page.evaluate(() => window.seabathy.terrain.close());
  await closeSheet(page);
  // The waypoint tool, as in the Android app: on, then a tap on the chart drops a mark at the crosshair.
  const marksBefore = await page.evaluate(() => window.seabathy.waypoints.list().length);
  await page.click('#btn-add');
  expect(/crosshair/.test(await page.locator('#hint').innerText()) && await page.evaluate(() => window.seabathy.tools.mode() === 'waypoint'), 'the waypoint tool did not switch on and say what a tap does');
  await page.mouse.click(200, 420);
  await page.waitForSelector('#wpt-name');
  expect(await page.evaluate(() => window.seabathy.waypoints.list().length) === marksBefore, 'a waypoint was saved before Save waypoint was tapped');
  await shot(page, '4e-new-waypoint');
  const name = 'Reef edge & "bommie" <1>';
  await page.fill('#wpt-name', name);
  await page.fill('#wpt-desc', 'Good on the run-out tide');
  await page.locator('.colour-choice').nth(3).click();
  await page.locator('.icon-choice').nth(4).click();
  await page.click('#wpt-save');
  // The tool stays on for the next mark until its button is tapped again.
  await page.click('#btn-add');
  expect(await page.locator('#hint').isHidden() && await page.evaluate(() => window.seabathy.tools.mode() === 'none'), 'the waypoint tool did not switch off');
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
  await openMenu(page, 'menu-backup');
  const gpxFile = path.join(workDir, 'data', `exported-${engineName}-${pass}.gpx`);
  // Where the browser has a share sheet for files (a Mac, as on an iPhone), the app hands the
  // file to it. A test can't tap a share sheet, so it stands in for it and takes the file.
  const shares = await page.evaluate(() => Boolean(navigator.canShare?.({ files: [new File(['x'], 'x.gpx', { type: 'application/gpx+xml' })] })));
  if (shares) {
    await page.evaluate(() => {
      window.sharedGpx = null;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.sharedGpx = await data.files[0].text(); } });
    });
    await page.click('#gpx-export');
    await page.waitForFunction(() => window.sharedGpx, null, { timeout: 20000 });
    writeFileSync(gpxFile, await page.evaluate(() => window.sharedGpx));
  } else {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#gpx-export')]);
    await download.saveAs(gpxFile);
  }
  const text = readFileSync(gpxFile, 'utf8');
  expect(text.includes('<gpx version="1.1" creator="SeaBathy"') && text.includes('&amp;') && text.includes('&lt;1&gt;'), 'the GPX file is not as expected');
  await openLayers(page);
  await page.locator('#wpt-list .wrow-edit').first().click();
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 0);
  await openMenu(page, 'menu-backup');
  await page.setInputFiles('#gpx-file', gpxFile);
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 1, null, { timeout: 10000 });
  const after = await page.evaluate(() => window.seabathy.waypoints.list()[0]);
  for (const key of ['name', 'desc', 'color', 'icon']) expect(after[key] === before[key], `${key} came back as ${after[key]}`);
  expect(Math.abs(after.lat - before.lat) < 1e-6 && Math.abs(after.lng - before.lng) < 1e-6, 'the position moved');
  await page.setInputFiles('#gpx-file', gpxFile);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.seabathy.waypoints.list().length) === 1, 'importing the same file twice made a copy');
  await closeSheet(page);
  return `${text.length} bytes of GPX, ${shares ? "handed to the share sheet" : "saved as a download"}`;
});

await step('Photos: a waypoint made where a photo was taken, photos added to a waypoint and deleted, and carried in the backup', async () => {
  await closeSheet(page);
  await goTo(page, MID.lng, MID.lat, 11);
  // Three photos made here: one as a camera writes it, with its place and time; the same held on its side; and one that says nothing.
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1800;
    const context2d = canvas.getContext('2d');
    const fade = context2d.createLinearGradient(0, 0, 2400, 1800);
    fade.addColorStop(0, '#0af');
    fade.addColorStop(1, '#fa0');
    context2d.fillStyle = fade;
    context2d.fillRect(0, 0, 2400, 1800);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }), 'base64');
  const SPOT = { lat: -20.25, lng: 149.05 };
  const when = Date.UTC(2026, 5, 1, 3, 4, 5);
  const placed = path.join(workDir, 'data', `photo-placed-${engineName}.jpg`);
  const turned = path.join(workDir, 'data', `photo-turned-${engineName}.jpg`);
  const plain = path.join(workDir, 'data', `photo-plain-${engineName}.jpg`);
  writeFileSync(placed, withExif(jpeg, { ...SPOT, when: new Date(when) }));
  writeFileSync(turned, withExif(jpeg, { ...SPOT, when: new Date(when), turned: true }));
  writeFileSync(plain, jpeg);
  const said = await page.evaluate((text) => window.seabathy.photos.readExif(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer), readFileSync(placed).toString('base64'));
  expect(Math.abs(said.lat - SPOT.lat) < 1e-5 && Math.abs(said.lng - SPOT.lng) < 1e-5 && said.taken === when, `the photo's notes were read as ${JSON.stringify(said)}`);
  const nothing = await page.evaluate((text) => window.seabathy.photos.readExif(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer), jpeg.toString('base64'));
  expect(nothing.lat === null && nothing.lng === null && nothing.taken === null, `a photo with no notes was read as ${JSON.stringify(nothing)}`);
  const before = await page.evaluate(async () => ({ marks: window.seabathy.waypoints.list().length, photos: await window.seabathy.photos.count() }));
  const kept = () => page.evaluate(() => window.seabathy.photos.count());
  const marks = () => page.evaluate(() => window.seabathy.waypoints.list().length);
  /** The photo a waypoint lists at [index], as it is kept: its size, and that it is a JPEG. */
  const photoOf = (name, index) => page.evaluate(async ([wanted, n]) => {
    const waypoint = window.seabathy.waypoints.list().find((w) => w.name === wanted);
    const photo = waypoint?.photos?.[n];
    const bytes = photo && await window.seabathy.photos.get(photo.id);
    if (!bytes) return null;
    const picture = await createImageBitmap(new Blob([bytes]));
    const head = new Uint8Array(bytes.slice(0, 2));
    return { width: picture.width, height: picture.height, jpeg: head[0] === 0xff && head[1] === 0xd8, taken: photo.taken, bytes: bytes.byteLength };
  }, [name, index]);
  const thumbs = (n) => page.waitForFunction((count) => {
    const small = [...document.querySelectorAll('#wpt-photos .photo-thumb')];
    return small.length === count && small.every((s) => /^url\("blob:/.test(getComputedStyle(s).backgroundImage));
  }, n, { timeout: 30000 });

  // A waypoint from a photo: it goes where the photo was taken, the chart moves there, and its card opens with the photo on it.
  await openLayers(page);
  expect(await page.locator('#wpt-from-photo').isVisible(), 'the Layers panel does not offer a waypoint from a photo');
  await page.setInputFiles('#wpt-photo-pick', placed);
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 1, before.marks, { timeout: 30000 });
  await thumbs(1);
  const made = await page.evaluate(() => {
    const w = window.seabathy.waypoints.list().at(-1);
    const centre = window.seabathy.map.getCenter();
    return { name: w.name, desc: w.desc, lat: w.lat, lng: w.lng, photos: (w.photos || []).length, centre: [centre.lng, centre.lat], drawer: document.querySelector('#drawer').hidden };
  });
  expect(/^Photo \d+ [A-Z][a-z]{2} \d\d:\d\d$/.test(made.name) && made.desc === `From a photo taken ${made.name.slice(6)}` && made.photos === 1, `the waypoint from a photo is ${JSON.stringify(made)}`);
  expect(Math.abs(made.lat - SPOT.lat) < 1e-5 && Math.abs(made.lng - SPOT.lng) < 1e-5, `the photo was taken at ${SPOT.lat}, ${SPOT.lng}; the waypoint is at ${made.lat}, ${made.lng}`);
  expect(Math.abs(made.centre[0] - SPOT.lng) < 1e-3 && Math.abs(made.centre[1] - SPOT.lat) < 1e-3 && made.drawer, 'the chart did not go to the new waypoint with the panel put away');
  const first = await photoOf(made.name, 0);
  expect(first && first.width === 1600 && first.height === 1200 && first.jpeg && first.taken === when, `the photo was kept as ${JSON.stringify(first)}`);
  await shot(page, '6b-photo-waypoint');

  // A second photo added in the card, one the camera took on its side: it is kept upright.
  await page.setInputFiles('#wpt-photo-file', turned);
  await thumbs(2);
  const second = await photoOf(made.name, 1);
  expect(second && second.width === 1200 && second.height === 1600, `a photo taken with the camera on its side was kept as ${JSON.stringify(second)}`);
  expect(await kept() === before.photos + 2, 'two photos were added but not two kept');
  // The newest is first. It opens full size with its time, and can be deleted.
  await page.locator('#wpt-photos .photo-thumb').first().click();
  await page.waitForFunction(() => document.querySelector('#wpt-photo-full')?.naturalWidth === 1200, null, { timeout: 30000 });
  expect(/[A-Z]{3} \d+ [A-Z]{3} \d{4}, \d\d:\d\d/.test(await page.locator('#sheet-body').innerText()), 'the photo does not say when it was taken');
  await shot(page, '6c-photo-full');
  await page.click('#wpt-photo-delete');
  await page.click('#confirm-yes');
  await thumbs(1);
  expect(await kept() === before.photos + 1 && (await photoOf(made.name, 0)).width === 1600, 'deleting one photo did not leave the other');
  // What is typed in the card is still saved with Save, and the photo stays.
  await page.fill('#wpt-name', 'Bommie photo');
  await page.click('#wpt-save');
  await page.waitForFunction(() => window.seabathy.waypoints.list().some((w) => w.name === 'Bommie photo' && w.photos?.length === 1));

  // A photo that doesn't say where it was taken: nothing is made on Cancel; "At the crosshair" puts it there.
  await goTo(page, MID.lng, MID.lat, 11);
  await openLayers(page);
  expect(await page.locator('#wpt-list .wrow', { hasText: 'Bommie photo' }).locator('.wrow-photo').count() === 1 && await page.locator('#wpt-list .wrow-photo').count() === 1, 'the list does not mark the waypoint that has a photo, and only that one');
  await page.setInputFiles('#wpt-photo-pick', plain);
  await page.waitForSelector('#photo-here');
  expect(/No location in this photo/.test(await page.locator('.overlay .card').innerText()), 'a photo with no place in it was not explained');
  await page.click('#photo-cancel');
  await page.waitForFunction(() => !document.querySelector('.overlay'));
  expect(await marks() === before.marks + 1 && await kept() === before.photos + 1, 'cancelling left a waypoint or a photo behind');
  // "Where I am now" puts it at the phone's own position, from its GPS, with the GPS button off.
  await page.setInputFiles('#wpt-photo-pick', plain);
  await page.waitForSelector('#photo-gps');
  expect(/where you are now, from the phone's GPS/.test(await page.locator('.overlay .card').innerText()), 'the card does not offer the GPS position');
  await shot(page, '6d-photo-no-place');
  await page.click('#photo-gps');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 2, before.marks, { timeout: 60000 });
  await thumbs(1);
  const atBoat = await page.evaluate(() => { const w = window.seabathy.waypoints.list().at(-1); return { lat: w.lat, lng: w.lng, desc: w.desc, gps: window.seabathy.gps.isOn() }; });
  expect(Math.abs(atBoat.lat - FIX.latitude) < 1e-4 && Math.abs(atBoat.lng - FIX.longitude) < 1e-4 && !atBoat.gps, `a photo put "where I am now" went to ${atBoat.lat}, ${atBoat.lng}; the phone is at ${FIX.latitude}, ${FIX.longitude}`);
  expect(/^From a photo taken /.test(atBoat.desc) && !/wind|tide|swell|wave/i.test(atBoat.desc), `the waypoint's note is "${atBoat.desc}"`);
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 1, before.marks);
  await goTo(page, MID.lng, MID.lat, 11);
  await openLayers(page);
  await page.setInputFiles('#wpt-photo-pick', plain);
  await page.click('#photo-here');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 2, before.marks, { timeout: 30000 });
  await thumbs(1);
  const here = await page.evaluate(() => { const w = window.seabathy.waypoints.list().at(-1); return { lat: w.lat, lng: w.lng, name: w.name }; });
  expect(Math.abs(here.lat - MID.lat) < 1e-4 && Math.abs(here.lng - MID.lng) < 1e-4, `a photo with no place went to ${here.lat}, ${here.lng}, not the crosshair`);
  await closeSheet(page);

  // The backup holds the photos, and brings them back with their waypoints.
  const built = await page.evaluate(() => window.seabathy.backup.build('test'));
  const listed = built.waypoints.filter((w) => w.photos?.length === 1);
  expect(listed.length === 2 && Object.keys(built.photos).length === 2 && listed.every((w) => typeof built.photos[w.photos[0].id] === 'string'), `the backup lists ${listed.length} waypoints with a photo and holds ${Object.keys(built.photos).length} photos`);
  const removeMark = async (name) => {
    await openLayers(page);
    await page.locator('#wpt-list .wrow', { hasText: name }).locator('.wrow-edit').click();
    await page.click('#wpt-delete');
    await page.click('#confirm-yes');
  };
  await removeMark('Bommie photo');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 1, before.marks);
  expect(await kept() === before.photos + 1, "deleting a waypoint left its photo on the phone");
  await removeMark(here.name);
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n, before.marks);
  expect(await kept() === before.photos, 'photos were left behind with no waypoint');
  const back = await page.evaluate((backup) => window.seabathy.backup.restore(backup), built);
  expect(back.waypoints === 2 && await kept() === before.photos + 2, `restoring added ${back.waypoints} waypoints and there are ${await kept()} photos`);
  const again = await photoOf('Bommie photo', 0);
  expect(again && again.width === 1600 && again.height === 1200 && again.taken === when, `the photo came back from the backup as ${JSON.stringify(again)}`);
  // Left as it was found.
  await removeMark('Bommie photo');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n + 1, before.marks);
  await removeMark(here.name);
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n, before.marks);
  expect(await kept() === before.photos, 'the photos were not cleared away');
  await closeSheet(page);
  return `a ${jpeg.length.toLocaleString()}-byte photo kept as ${first.bytes.toLocaleString()} bytes at 1600 px; one held sideways kept upright; in and out of a backup`;
});

await step('A web chart is read with part-file requests from another site', async () => {
  await openMenu(page, 'menu-charts');
  await page.click('#chart-web');
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

/** Sets the detail in the box's bar to a zoom with its less and more buttons. */
const detailTo = async (page, zoom) => {
  for (let i = 0; i < 24; i++) {
    const now = Number((await page.locator('#offline-detail').innerText()).replace(/\D/g, ''));
    if (now === zoom) return;
    await page.click(now > zoom ? '#offline-less' : '#offline-more');
  }
};
const tilesSaid = (text) => Number(((/^([\d,]+) tiles?/.exec(text) || [])[1] || '').replace(/,/g, ''));

await step('Save for offline: the area is drawn as a box, its detail picked there, and saved at a gentle pace', async () => {
  await openMenu(page, 'menu-offline');
  expect(/draw the area on the chart/.test(await page.locator('#sheet-body').innerText()), 'the Offline maps panel does not say the area is drawn on the chart');
  await shot(page, '7a-offline-panel');
  await page.click('#offline-choose');
  await page.waitForSelector('#area-bar');
  expect(await page.locator('#sheet-layer').isHidden() && await page.locator('#area-go').isDisabled() && (await page.locator('#area-go').innerText()).trim() === 'Save area', 'the box does not start empty, with Save area off');
  await drawBox(page);
  // Little detail, so the save is a handful of tiles; one step less is fewer still.
  await detailTo(page, 9);
  await pickerReady(page);
  const less = (await pickerSays(page)).info;
  await detailTo(page, 10);
  await pickerReady(page);
  const says = (await pickerSays(page)).info;
  await shot(page, '7b-offline-box');
  expect(tilesSaid(says) > 0 && tilesSaid(less) > 0 && tilesSaid(says) > tilesSaid(less), `at zoom 9 the box means "${less}", at zoom 10 "${says}"`);
  const drawn = await boxOnChart(page);
  const started = Date.now();
  await page.click('#area-go');
  await page.waitForFunction(() => window.seabathy.offline.list().length === 1, null, { timeout: 180000 });
  const pack = await page.evaluate(() => window.seabathy.offline.list()[0]);
  expect(pack.tiles > 0 && pack.failed === 0, `saved ${pack.tiles} tiles, ${pack.failed} failed`);
  expect(Math.abs(pack.bounds[0] - drawn.west) < 0.02 && Math.abs(pack.bounds[2] - drawn.east) < 0.02 && Math.abs(pack.bounds[1] - drawn.south) < 0.02 && Math.abs(pack.bounds[3] - drawn.north) < 0.02 && pack.maxZoom === 10 && pack.minZoom < 10,
    `the area saved is ${pack.bounds} at zoom ${pack.minZoom} to ${pack.maxZoom}; the box drawn was ${JSON.stringify(drawn)}`);
  const perSecond = pack.tiles / ((Date.now() - started) / 1000);
  expect(perSecond <= 22, `saved at ${perSecond.toFixed(1)} tiles a second`);
  expect(await page.locator('#area-bar').count() === 0, 'the box stayed on the chart after the save');
  await openMenu(page, 'menu-offline');
  expect(/SAVED AREAS/.test(await page.locator('#sheet-body').innerText()), 'the saved area is not listed');
  await closeSheet(page);
  return `${pack.tiles} tiles, ${pack.bytes} bytes, zoom ${pack.minZoom} to ${pack.maxZoom}; the box said "${says}"`;
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

  // Your own map link: drawn through the app, an area of it saved by drawing a box, and the saved tiles used when its server can't be reached.
  let asked = 0;
  const count = (request) => { if (request.url().includes('/xyz/')) asked++; };
  page.on('request', count);
  await page.fill('#custom-url', `${DATA}xyz/{z}/{x}/{y}.png`);
  await page.fill('#custom-credit', 'Test tiles');
  await page.click('#custom-save');
  await page.waitForFunction(() => window.seabathy.basemap.state.basemap === 'custom' && window.seabathy.map.getSource('base')?.tiles?.[0]?.startsWith('sb://b/custom/'), null, { timeout: 30000 });
  await closeSheet(page);
  await goTo(page, MID.lng, MID.lat, 10);
  for (let i = 0; i < 100 && !asked; i++) await page.waitForTimeout(100);
  expect(asked > 0 && (await page.locator('#credits').innerText()).includes('Test tiles'), `the map at the link was asked for ${asked} tiles, and the credit line is "${await page.locator('#credits').innerText()}"`);
  await openMenu(page, 'menu-offline');
  expect(/Your own map/.test(await page.locator('#sheet-body').innerText()) && /right to save your own map offline/.test(await page.locator('#sheet-body').innerText()), 'Offline maps does not offer your own map, with the note about its licence');
  // Only the map at the link: the others are switched off here, so nothing else is fetched.
  await page.evaluate(() => {
    for (const label of document.querySelectorAll('#sheet-body label.toggle')) {
      const box = label.querySelector('input');
      if (!label.textContent.includes('Your own map') && box.checked) box.click();
    }
  });
  await page.click('#offline-choose');
  await page.waitForSelector('#area-bar');
  await drawBox(page);
  await detailTo(page, 10);
  await pickerReady(page);
  await page.click('#area-go');
  await page.waitForFunction(() => window.seabathy.offline.list().some((p) => p.source.startsWith('base:')), null, { timeout: 180000 });
  const own = await page.evaluate(() => {
    const s = window.seabathy;
    const pack = s.offline.list().find((p) => p.source.startsWith('base:'));
    const z = pack.maxZoom;
    const lng = (pack.bounds[0] + pack.bounds[2]) / 2;
    const sin = Math.sin((((pack.bounds[1] + pack.bounds[3]) / 2) * Math.PI) / 180);
    return { label: pack.label, tiles: pack.tiles, failed: pack.failed, source: pack.source, now: s.basemap.customSource(), z, x: Math.floor(((lng + 180) / 360) * 2 ** z), y: Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** z) };
  });
  expect(own.label === 'Your own map' && own.tiles > 0 && own.failed === 0 && own.source === own.now, `the area of your own map was saved as ${JSON.stringify(own)}`);
  // With no signal, a tile inside the area still comes, from the phone; one outside it does not.
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine);
  const away = await page.evaluate(async ({ z, x, y }) => {
    const b = window.seabathy.basemap;
    const inside = await b.customTile(z, x, y);
    const outside = await b.customTile(z, x + 300, y);
    return { inside: inside ? [...new Uint8Array(inside.slice(0, 4))].join() : null, outside };
  }, own);
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine);
  expect(away.inside === '137,80,78,71' && away.outside === null, `with no signal, a saved tile came as ${away.inside} and one not saved as ${away.outside === null ? null : 'a tile'}`);
  // Another link is another map: the tiles saved from the first are not shown for it.
  const other = await page.evaluate(async ([url, { z, x, y }]) => {
    const b = window.seabathy.basemap;
    await b.setCustom(url, '');
    return { source: b.customSource(), tile: await b.customTile(z, x, y) };
  }, [`${DATA}other-map/{z}/{x}/{y}.png`, own]);
  expect(other.source !== own.source && other.tile === null, 'the tiles saved from one link were given for another');
  page.off('request', count);
  // Put away: the saved area of that map, and the link.
  await openMenu(page, 'menu-offline');
  await page.locator('#sheet-body .row.danger', { hasText: 'Your own map' }).click();
  await page.click('#confirm-yes');
  await page.waitForFunction(() => !window.seabathy.offline.list().some((p) => p.source.startsWith('base:')));
  await page.evaluate(() => window.seabathy.basemap.setCustom('', ''));
  await openMenu(page, 'menu-maps');
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

await step('A hidden layer comes off the chart and frees its memory, and draws again when shown', async () => {
  await only(page, 'all');
  await goTo(page, MID.lng, MID.lat, 10);
  const all = await charts(page);
  const chart = all.find((c) => c.kind === 'geotiff') || all[0];
  const onMap = () => page.evaluate((id) => Boolean(window.seabathy.map.getSource(`chart-${id}`)), chart.id);
  const held = () => page.evaluate(async (id) => (await import('./js/survey.js')).held().includes(id), chart.id);
  if (chart.kind === 'geotiff') {
    await page.waitForFunction(async (id) => (await import('./js/survey.js')).held().includes(id), chart.id, { timeout: 30000 });
  }
  expect(await onMap(), 'the layer is not on the chart to begin with');
  // Switched off with its switch in the Layers panel.
  const tick = `#layer-${chart.id} input[type="checkbox"]`;
  await openLayers(page);
  await page.click(tick);
  await page.waitForFunction((id) => !window.seabathy.map.getSource(`chart-${id}`), chart.id, { timeout: 10000 });
  expect(!(await held()), 'the hidden survey is still held open in memory');
  expect(await page.evaluate((id) => window.seabathy.map.getStyle().layers.every((l) => l.source !== `chart-${id}`), chart.id), 'layers of the hidden chart are still on the map');
  expect(await page.locator(tick).isChecked() === false, 'the Layers panel does not show it as hidden');
  // And on again: it is opened afresh and drawn.
  await page.click(tick);
  await closeSheet(page);
  await page.waitForFunction((id) => window.seabathy.map.getSource(`chart-${id}`) && window.seabathy.map.isSourceLoaded(`chart-${id}`), chart.id, { timeout: 30000 });
  if (chart.kind === 'geotiff') await page.waitForFunction(async (id) => (await import('./js/survey.js')).held().includes(id), chart.id, { timeout: 30000 });
  return `${chart.name}: off the chart and ${chart.kind === 'geotiff' ? 'its file closed' : 'no layers left'} while hidden, drawn again when shown`;
});

await step('Marine parks and places: zones, reef and island names and boat ramps switch on, say what they are when tapped, and are credited', async () => {
  const credits = () => page.locator('#credits').innerText();
  const count = (layer) => page.evaluate((id) => (window.seabathy.map.getLayer(id) ? window.seabathy.map.queryRenderedFeatures({ layers: [id] }).length : -1), layer);
  const shown = (layer, least) => page.waitForFunction(([id, n]) => {
    const map = window.seabathy.map;
    return map.getLayer(id) && map.queryRenderedFeatures({ layers: [id] }).length >= n;
  }, [layer, least], { timeout: 90000 });
  const tapCard = async (x, y) => {
    await page.mouse.click(x, y);
    await page.waitForSelector('#place-close', { timeout: 10000 });
    const said = await page.locator('.card').innerText();
    await page.click('#place-close');
    await page.waitForFunction(() => !document.querySelector('.overlay'));
    return said;
  };
  // The Whitsundays: marine park zones, named islands and numbered reefs.
  await goTo(page, 148.95, -20.25, 10);
  expect(await count('sb-over-names') === -1 && !(await credits()).includes('Names:'), 'names are on before they are switched on');

  // Names.
  await openMenu(page, 'menu-places');
  await page.click('#places-names');
  await closeSheet(page);
  await shown('sb-over-names', 4);
  expect((await credits()).includes('Names: Geoscience Australia'), 'the names are not credited on the chart');
  const named = await page.evaluate(() => {
    const map = window.seabathy.map;
    for (const f of map.queryRenderedFeatures({ layers: ['sb-over-names'] })) {
      const p = map.project(f.geometry.coordinates);
      if (p.x > 70 && p.x < 320 && p.y > 140 && p.y < 520) return { name: f.properties.n, x: p.x, y: p.y };
    }
    return null;
  });
  expect(named, 'no name is drawn where it can be tapped');
  const nameCard = await tapCard(named.x, named.y);
  expect(nameCard.includes(named.name) && nameCard.includes('Geoscience Australia'), `a tap on "${named.name}" said: ${nameCard.replace(/\s+/g, ' ')}`);
  await shot(page, '7b-names');

  // Zones: the notice first, once; then every zone, then the no-take ones alone.
  await openMenu(page, 'menu-places');
  await page.click('#zones-all');
  await page.waitForSelector('#places-ack');
  expect((await page.locator('.card').innerText()).includes('the law'), 'the notice does not say the official zoning is the law');
  await page.click('#places-ack');
  await closeSheet(page);
  await shown('sb-over-zones-fill', 1);
  expect((await credits()).includes('Marine park zones:'), 'the zones are not credited on the chart');
  const inZone = await page.evaluate(() => {
    const map = window.seabathy.map;
    for (let y = 150; y < 520; y += 20) {
      for (let x = 80; x < 320; x += 20) {
        const zones = map.queryRenderedFeatures([x, y], { layers: ['sb-over-zones-fill'] });
        const near = map.queryRenderedFeatures([[x - 30, y - 30], [x + 30, y + 30]], { layers: ['sb-over-names'] });
        if (zones.length && !near.length) return { x, y, classes: zones.map((z) => z.properties.c) };
      }
    }
    return null;
  });
  expect(inZone, 'no zone is drawn where it can be tapped');
  const zoneCard = await tapCard(inZone.x, inZone.y);
  expect(/No-take zone|Limited fishing|General use/i.test(zoneCard) && /Fishing: /.test(zoneCard) && zoneCard.includes('A guide only'), `a tap in a zone said: ${zoneCard.replace(/\s+/g, ' ')}`);
  // The strictest zone under the finger is the one described.
  if (inZone.classes.includes('nt')) expect(/No-take zone/i.test(zoneCard), 'the strictest zone was not the one described');
  await shot(page, '7c-zones');
  // The satellite picture, when on, lies under the zones and names.
  const order = await page.evaluate(async () => {
    await window.seabathy.basemap.setSatellite({ satOn: true });
    const ids = window.seabathy.map.getStyle().layers.map((l) => l.id);
    await window.seabathy.basemap.setSatellite({ satOn: false });
    return { sat: ids.indexOf('sb-sat'), zones: ids.indexOf('sb-over-zones-fill'), names: ids.indexOf('sb-over-names') };
  });
  expect(order.sat >= 0 && order.sat < order.zones && order.zones < order.names, `the layers are stacked ${JSON.stringify(order)}`);
  await openMenu(page, 'menu-places');
  await page.click('#zones-notake');
  await closeSheet(page);
  expect(JSON.stringify(await page.evaluate(() => window.seabathy.map.getFilter('sb-over-zones-fill'))) === JSON.stringify(['==', ['get', 'c'], 'nt']), 'no-take only does not leave out the other zones');

  // The warning on the way into a no-take zone, and the word on the way out.
  const spot = await page.evaluate(async () => {
    const data = await (await fetch('data/zones.geojson')).json();
    for (const feature of data.features) {
      if (feature.properties.c !== 'nt') continue;
      const ring = (feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates[0])[0];
      const lng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
      const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      if (await window.seabathy.places.noTakeAt(lat, lng)) return { lat, lng, park: feature.properties.n };
    }
    return null;
  });
  expect(spot, 'no point inside a no-take zone was found');
  expect(await page.evaluate(() => window.seabathy.places.noTakeAt(-30, 160)) === null, 'open sea far from any park counts as a no-take zone');
  // WebKit on Windows never reports a changed position, so there the app is told the boat's place directly.
  const boatTo = async (latitude, longitude) => {
    if (windowsWebkit) await page.evaluate(([lat, lng]) => { window.seabathy.places.boatAt({ coords: { latitude: lat, longitude: lng } }); }, [latitude, longitude]);
    else await context.setGeolocation({ latitude, longitude, accuracy: 5 });
  };
  await boatTo(spot.lat, spot.lng);
  if (!windowsWebkit && !(await page.evaluate(() => window.seabathy.gps.isOn()))) await page.click('#btn-gps');
  await page.waitForSelector('#notake-ok', { timeout: 30000 });
  const warning = await page.locator('.card').innerText();
  expect(/You're in a no-take zone/.test(warning) && warning.includes(spot.park), `the warning said: ${warning.replace(/\s+/g, ' ')}`);
  await shot(page, '7d-no-take');
  await page.click('#notake-ok');
  await boatTo(-30, 160);
  await page.waitForFunction(() => /left the no-take zone/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden, null, { timeout: 30000 });
  await page.evaluate(() => { for (let i = 0; i < 3 && window.seabathy.gps.isOn(); i++) window.seabathy.gps.tap(); });
  await context.setGeolocation(FIX);

  // Boat ramps, by the mainland.
  await openMenu(page, 'menu-places');
  await page.click('#places-ramps');
  await closeSheet(page);
  await goTo(page, 148.72, -20.27, 11);
  await shown('sb-over-ramps', 1);
  expect((await credits()).includes('Boat ramps: © OpenStreetMap'), 'the ramps are not credited on the chart');
  const ramp = await page.evaluate(() => {
    const map = window.seabathy.map;
    for (const f of map.queryRenderedFeatures({ layers: ['sb-over-ramps'] })) {
      const p = map.project(f.geometry.coordinates);
      if (p.x > 70 && p.x < 320 && p.y > 140 && p.y < 520) return { x: p.x, y: p.y };
    }
    return null;
  });
  if (ramp) expect(/Boat ramp/i.test(await tapCard(ramp.x, ramp.y)), 'a tap on a ramp did not say it is one');
  // Once fetched, each file is kept for use with no signal.
  const keptNow = () => page.evaluate(async () => (await (await caches.open('seabathy-data-1')).keys()).map((r) => r.url.split('/').pop()).sort().join());
  // The file just fetched may take a moment to show up as kept.
  if (worker) await page.waitForFunction(async () => (await (await caches.open('seabathy-data-1')).keys()).length >= 3, null, { timeout: 15000 }).catch(() => {});
  const keptFiles = worker ? await keptNow() : 'not checked';
  if (worker) expect(keptFiles === 'places.geojson,ramps.geojson,zones.geojson', `kept for offline use: ${keptFiles || 'nothing'}`);
  // All off again: nothing left on the chart or in the credits.
  await openMenu(page, 'menu-places');
  await page.click('#zones-off');
  await page.click('#places-names');
  await page.click('#places-ramps');
  await closeSheet(page);
  expect(await count('sb-over-zones-fill') === -1 && await count('sb-over-names') === -1 && await count('sb-over-ramps') === -1, 'something is still on the chart after switching everything off');
  expect(!/Names:|Marine park zones:|Boat ramps:/.test(await credits()), 'credits remain for layers that are off');
  await goTo(page, MID.lng, MID.lat, 10);
  return `"${named.name}" named; zone card and the no-take warning in ${spot.park}; ${ramp ? 'a ramp tapped' : 'ramps drawn'}; data kept: ${keptFiles}`;
});

await step('Settings: depths in feet or fathoms and speed in other units, at the crosshair and for 3D', async () => {
  await only(page, 'all');
  await goTo(page, MID.lng, MID.lat, 10);
  const depthShown = async () => {
    await page.waitForFunction(() => !document.querySelector('#readout-depth').hidden, null, { timeout: 20000 });
    return page.locator('#readout-depth').innerText();
  };
  const metres = await depthShown();
  expect(/ m\b/.test(metres), `the crosshair depth reads "${metres}"`);
  await setUnit(page, 'depth', 'ft');
  await setUnit(page, 'speed', 'kmh');
  await closeSheet(page);
  await page.waitForFunction(() => / ft\b/.test(document.querySelector('#readout-depth').textContent), null, { timeout: 10000 });
  const feet = await depthShown();
  expect(Math.abs(parseFloat(feet) - parseFloat(metres) * 3.28084) < 1.5, `${metres} became ${feet}`);
  const told = await page.evaluate(() => ({ speed: window.seabathy.units.speedText(10), depth: window.seabathy.units.depthText(-18.288), land: window.seabathy.units.depthText(3) }));
  expect(told.speed === '18.5 km/h' && told.depth === '60.0 ft' && told.land === '9.8 ft above the water', `units gave ${JSON.stringify(told)}`);
  // The choice is kept, and metres and knots come back.
  const keptUnits = await page.evaluate(() => window.seabathy.db.setting.get('units'));
  expect(keptUnits.depth === 'ft' && keptUnits.speed === 'kmh', `the units were kept as ${JSON.stringify(keptUnits)}`);
  await setUnit(page, 'depth', 'fm');
  await closeSheet(page);
  await page.waitForFunction(() => / fm\b/.test(document.querySelector('#readout-depth').textContent), null, { timeout: 10000 });
  const fathoms = await depthShown();
  await setUnit(page, 'depth', 'm');
  await setUnit(page, 'speed', 'kn');
  await closeSheet(page);
  await page.waitForFunction(() => / m\b/.test(document.querySelector('#readout-depth').textContent), null, { timeout: 10000 });
  return `${metres} = ${feet} = ${fathoms}`;
});

await step('The Layers panel: Settings, every layer with its switch, slider and buttons, the waypoints and the basemap; a layer can be renamed', async () => {
  await openLayers(page);
  await page.waitForSelector('#drawer:not([hidden])');
  const all = await charts(page);
  const said = await page.locator('#drawer').innerText();
  expect(/Layers/i.test(said) && /Settings/.test(said) && /Map layers/i.test(said) && /Satellite picture/.test(said) && /Waypoints/i.test(said) && /Basemap/i.test(said), `the Layers panel is missing a part: ${said.replace(/\s+/g, ' ').slice(0, 200)}`);
  for (const c of all) expect(said.includes(c.name), `the Layers panel does not list ${c.name}`);
  expect(await page.locator('#sheet').isHidden(), 'a panel is open over the Layers panel');
  await shot(page, '7e-drawer');
  // A layer's switch works there and then, with the panel still open.
  const chart = all[all.length - 1];
  const tick = `#layer-${chart.id} input[type="checkbox"]`;
  await page.click(tick);
  await page.waitForFunction((id) => !window.seabathy.map.getSource(`chart-${id}`), chart.id, { timeout: 10000 });
  expect(await page.locator('#drawer').isVisible(), 'switching a layer closed the Layers panel');
  await page.click(tick);
  await page.waitForFunction((id) => Boolean(window.seabathy.map.getSource(`chart-${id}`)), chart.id, { timeout: 10000 });
  // How see-through it is, on its own slider; the line under its name says so.
  const fade = `#layer-${chart.id} input[type="range"]`;
  await page.locator(fade).fill('0.5');
  await page.waitForFunction((id) => window.seabathy.charts.list().find((c) => c.id === id).opacity === 0.5 && /50%/.test(document.querySelector(`#layer-${id} .layer-sub`).textContent), chart.id, { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.locator(fade).fill('1');
  await page.waitForFunction((id) => window.seabathy.charts.list().find((c) => c.id === id).opacity === 1, chart.id, { timeout: 10000 });
  await page.waitForTimeout(400);
  // Rename: a card with the name in it.
  await page.click(`#layer-${chart.id} .layer-rename`);
  await page.fill('#chart-name', 'My best reef');
  await page.click('#chart-name-save');
  await page.waitForFunction((id) => document.querySelector(`#layer-${id} .layer-title`)?.textContent === 'My best reef', chart.id, { timeout: 10000 });
  const stored = await page.evaluate(async (id) => ({ now: window.seabathy.charts.list().find((c) => c.id === id).name, kept: ((await window.seabathy.db.all('charts')).find((c) => c.id === id) || {}).name }), chart.id);
  expect(stored.now === 'My best reef' && (chart.session || stored.kept === 'My best reef'), `after renaming: ${JSON.stringify(stored)}`);
  // Its own panel opens over the Layers panel, and Close goes back to it.
  await page.click(`#layer-${chart.id} .layer-more`);
  await page.waitForFunction(() => !document.querySelector('#sheet-layer').hidden && document.querySelector('#sheet-title').textContent === 'My best reef', null, { timeout: 10000 });
  await page.click('#sheet-back');
  expect(await page.locator('#sheet').isHidden() && await page.locator('#drawer').isVisible(), 'Close did not go back to the Layers panel');
  await page.click(`#layer-${chart.id} .layer-rename`);
  await page.fill('#chart-name', chart.name);
  await page.click('#chart-name-save');
  await page.waitForFunction(([id, name]) => document.querySelector(`#layer-${id} .layer-title`)?.textContent === name, [chart.id, chart.name], { timeout: 10000 });
  // The satellite picture is a layer here too, and the basemap is picked at the foot.
  await page.click('#layer-sat input[type="checkbox"]');
  await page.waitForFunction(() => window.seabathy.basemap.state.satOn && Boolean(window.seabathy.map.getLayer('sb-sat')), null, { timeout: 10000 });
  await page.click('#layer-sat input[type="checkbox"]');
  await page.waitForFunction(() => !window.seabathy.basemap.state.satOn, null, { timeout: 10000 });
  const base = await page.evaluate(() => window.seabathy.basemap.state.basemap);
  expect(await page.locator('#drawer-basemap').inputValue() === base, 'the basemap shown is not the one in use');
  await page.selectOption('#drawer-basemap', 'dark');
  await page.waitForFunction(() => window.seabathy.basemap.state.basemap === 'dark', null, { timeout: 30000 });
  await page.selectOption('#drawer-basemap', base);
  await page.waitForFunction((id) => window.seabathy.basemap.state.basemap === id, base, { timeout: 30000 });
  await closeSheet(page);
  expect(await page.locator('#drawer').isHidden(), 'the Layers panel did not close');
  return `${all.length} layers listed; "${chart.name}" renamed and named back`;
});

await step('Tools: measuring a distance and bearing, positions in three forms, going to a position, the night filter', async () => {
  await goTo(page, MID.lng, MID.lat, 10);
  await page.click('#btn-measure');
  expect(await page.locator('#hint').isVisible() && await page.evaluate(() => document.querySelector('#btn-measure').classList.contains('active')), 'the measure tool did not switch on');
  const marksBefore = await page.evaluate(() => window.seabathy.waypoints.list().length);
  await page.mouse.click(110, 320);
  await page.waitForFunction(() => /Tap another point/.test(document.querySelector('#toolcard').textContent));
  await page.mouse.click(290, 320);
  await page.waitForFunction(() => /°T/.test(document.querySelector('#toolcard').textContent));
  const measured = await page.locator('#toolcard').innerText();
  const want = await page.evaluate(() => {
    const map = window.seabathy.map;
    const a = map.unproject([110, 320]);
    const b = map.unproject([290, 320]);
    return window.seabathy.tools.distanceM({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  });
  const shown = parseFloat(/([\d.]+) nm/.exec(measured)?.[1] || 'NaN') * 1852;
  expect(Math.abs(shown - want) < want * 0.02 && /090°T/.test(measured), `180 px east measured as "${measured.replace(/\s+/g, ' ')}" where ${(want / 1852).toFixed(2)} nm was expected`);
  await shot(page, '7f-measure');
  await page.click('#measure-clear');
  expect(await page.locator('#toolcard').isHidden() && await page.locator('#hint').isHidden(), 'Clear did not end the measuring');
  expect(await page.evaluate(() => window.seabathy.waypoints.list().length) === marksBefore, 'measuring added a waypoint');

  // The position at the top, in each form.
  const position = () => page.locator('#readout-pos').innerText();
  const forms = { dms: '[0-9]″[NS]', dd: '^[0-9.]+°[NS]', ddm: '^[0-9]+°[0-9.]+′[NS]' };
  const setForm = async (id) => {
    await openMenu(page, 'menu-display');
    await page.click('#display-position');
    await page.click(`#unit-position-${id}`);
    await closeSheet(page);
    // The bar is written again a moment after the choice is kept.
    await page.waitForFunction((pattern) => new RegExp(pattern).test(document.querySelector('#readout-pos').textContent), forms[id], { timeout: 10000 });
  };
  await setForm('dms');
  const dms = await position();
  await setForm('dd');
  const dd = await position();
  await setForm('ddm');
  const ddm = await position();
  expect(/^\d+°\d\d′[\d.]+″[NS]\s+\d+°\d\d′[\d.]+″[EW]$/.test(dms) && /^[\d.]+°[NS]\s+[\d.]+°[EW]$/.test(dd) && /^\d+°[\d.]+′[NS]\s+\d+°[\d.]+′[EW]$/.test(ddm), `positions read "${dms}", "${dd}", "${ddm}"`);
  // A tap on it: go to a position typed in.
  const typed = await page.evaluate(() => [window.seabathy.tools.parseAngle('20 15.3 S', 90), window.seabathy.tools.parseAngle('-20.255', 90), window.seabathy.tools.parseAngle("149°06'00\"E", 180), window.seabathy.tools.parseAngle('91', 90), window.seabathy.tools.parseAngle('reef', 90)]);
  expect(Math.abs(typed[0] + 20.255) < 1e-9 && typed[1] === -20.255 && typed[2] === 149.1 && typed[3] === null && typed[4] === null, `typed positions were read as ${JSON.stringify(typed)}`);
  const read = await page.evaluate(() => ['20°15.300′S 149°06.000′E', 'S 20 15.3 E 149 6', '-20.255, 149.1', '20 15 18 S 149 6 0 E', '20.255 S', 'reef'].map((text) => window.seabathy.units.parsePosition(text)));
  expect(read.slice(0, 4).every((p) => p && Math.abs(p.lat + 20.255) < 1e-9 && Math.abs(p.lng - 149.1) < 1e-9) && read[4] === null && read[5] === null, `whole positions were read as ${JSON.stringify(read)}`);
  await page.click('#readout-pos');
  expect(await page.locator('#goto-format').inputValue() === 'ddm' && /′[NS]/.test(await page.locator('#goto-preview').innerText()), 'the card did not open on the position under the crosshair');
  await page.fill('#goto-coords', 'reef');
  expect(/Not a position/.test(await page.locator('#goto-preview').innerText()), 'a word was read as a position');
  await page.fill('#goto-coords', '20 15.3 S 149 6.0 E');
  expect(/20°15\.300′S\s+149°06\.000′E/.test(await page.locator('#goto-preview').innerText()), `the preview reads "${await page.locator('#goto-preview').innerText()}"`);
  await shot(page, '7f-goto');
  await page.click('#goto-go');
  await page.waitForFunction(() => Math.abs(window.seabathy.map.getCenter().lat + 20.255) < 1e-6 && Math.abs(window.seabathy.map.getCenter().lng - 149.1) < 1e-6, null, { timeout: 10000 });

  // The night filter: on, kept, and off again.
  await openMenu(page, 'menu-display');
  await page.click('#setting-night');
  expect(await page.evaluate(async () => document.body.classList.contains('night') && await window.seabathy.db.setting.get('night')) === true, 'the night filter did not come on');
  await shot(page, '7g-night');
  await page.click('#setting-night');
  expect(await page.evaluate(() => document.body.classList.contains('night')) === false, 'the night filter did not go off');
  await closeSheet(page);
  return `${measured.replace(/\s+/g, ' ').replace('MEASURE ', '')}; ${ddm} = ${dms} = ${dd}`;
});

await step('Man overboard: the spot is marked at the boat, the way back is shown, and End leaves the mark', async () => {
  await context.setGeolocation(FIX);
  const before = await page.evaluate(() => window.seabathy.waypoints.list().length);
  // The GPS on and settled at the boat first: a browser can hand over an older position at its first report.
  if (!(await page.evaluate(() => window.seabathy.gps.isOn()))) await page.click('#btn-gps');
  await page.waitForFunction(([lat, lng]) => {
    const fix = window.seabathy.gps.lastFix();
    return fix && Math.abs(fix.coords.latitude - lat) < 1e-6 && Math.abs(fix.coords.longitude - lng) < 1e-6;
  }, [FIX.latitude, FIX.longitude], { timeout: 30000 });
  await page.click('#btn-mob');
  await page.waitForFunction(() => window.seabathy.waypoints.list().some((w) => /^MOB /.test(w.name)), null, { timeout: 30000 });
  const mark = await page.evaluate(() => window.seabathy.waypoints.list().find((w) => /^MOB /.test(w.name)));
  expect(mark.icon === 'mob' && Math.abs(mark.lat - (-20.21)) < 1e-6 && Math.abs(mark.lng - 149.08) < 1e-6, `the mark is ${JSON.stringify(mark)}`);
  await page.waitForFunction(() => /MAN OVERBOARD/.test(document.querySelector('#toolcard').textContent) && /back, steer/.test(document.querySelector('#toolcard').textContent), null, { timeout: 15000 });
  expect(await page.evaluate(() => document.querySelector('#toolcard').classList.contains('alert') && window.seabathy.gps.isOn()), 'the alert is not up, or the GPS is off');
  let back = await page.locator('#toolcard').innerText();
  expect(/VHF channel 16/.test(back), 'the card does not say to call for help');
  // The boat a little over half a mile north of the mark: the way back is south.
  if (!windowsWebkit) {
    await context.setGeolocation({ latitude: FIX.latitude + 0.01, longitude: FIX.longitude, accuracy: 6 });
    await page.waitForFunction(() => /steer 180°T/.test(document.querySelector('#toolcard').textContent), null, { timeout: 20000 });
    back = await page.locator('#toolcard').innerText();
    expect(/0\.6\d nm back/.test(back), `from 0.01° north the card said: ${back.replace(/\s+/g, ' ')}`);
  }
  await shot(page, '7h-mob');
  await page.click('#mob-end');
  expect(await page.locator('#toolcard').isHidden(), 'End left the alert up');
  expect(await page.evaluate(() => window.seabathy.waypoints.list().length) === before + 1, 'the mark did not stay as a waypoint');
  // Tidied away for the checks that follow.
  await page.evaluate(() => { for (let i = 0; i < 3 && window.seabathy.gps.isOn(); i++) window.seabathy.gps.tap(); });
  await context.setGeolocation(FIX);
  await page.locator(`.wpt[data-id="${mark.id}"]`).evaluate((node) => node.click());
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction((n) => window.seabathy.waypoints.list().length === n, before, { timeout: 10000 });
  await closeSheet(page);
  return back.replace(/\s+/g, ' ').slice(0, 90);
});

await step('Routes: points at the crosshair, each leg with its bearing, distance, time and least depth; saved, and in and out as GPX', async () => {
  await only(page, 'all');
  await goTo(page, MID.lng, MID.lat, 10);
  await page.click('#btn-route');
  expect(await page.evaluate(() => document.querySelector('#btn-route').classList.contains('active')) && /Tap the map to add a point/.test(await page.locator('#toolcard').innerText()), 'the route tool did not open empty');
  // A tap anywhere on the chart puts the point at the crosshair; this spot is clear of the waypoint's own marker.
  const tapChart = () => page.mouse.click(300, 190);
  // A waypoint tapped while planning becomes a point of the route, with its name.
  await page.locator('.wpt').first().evaluate((node) => node.click());
  await page.waitForFunction(() => window.seabathy.routes.current().length === 1);
  expect(await page.evaluate(() => window.seabathy.routes.current()[0].name === window.seabathy.waypoints.list()[0].name) && await page.locator('#sheet').isHidden(), 'the waypoint tapped did not become the first point');
  // A tap without moving the chart off that spot adds nothing.
  await tapChart();
  await page.waitForFunction(() => /Move the chart/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden);
  expect(await page.evaluate(() => window.seabathy.routes.current().length) === 1, 'a tap on the same spot added a point');
  await goTo(page, MID.lng + 0.03, MID.lat, 10);
  await tapChart();
  await goTo(page, MID.lng + 0.03, MID.lat + 0.03, 10);
  await tapChart();
  await goTo(page, MID.lng + 0.06, MID.lat + 0.03, 10);
  await tapChart();
  await page.waitForFunction(() => window.seabathy.routes.current().length === 4);
  await page.click('#route-undo');
  const points = await page.evaluate(() => window.seabathy.routes.current());
  expect(points.length === 3 && Math.abs(points[0].lat - (-20.2)) < 1e-6 && Math.abs(points[1].lng - 149.13) < 1e-6 && Math.abs(points[2].lat - (-20.17)) < 1e-6, `the route is ${JSON.stringify(points)}`);
  const card = await page.locator('#toolcard').innerText();
  expect(/Unsaved route — 2 legs, [\d.]+ nm\s+\d+m at 20\.0 kn \(cruise\) · ETA \d\d:\d\d\s+1st leg 090°T/.test(card), `the route card says "${card.replace(/\s+/g, ' ')}"`);
  expect(await page.evaluate(() => window.seabathy.map.getLayer('sb-route-line') && window.seabathy.map.getSource('sb-route')._data !== undefined), 'the route is not drawn');
  // The legs: east, then north; with the least depth where a survey covers them.
  await page.click('#route-legs');
  await page.waitForFunction(() => document.querySelectorAll('#sheet-body [id^="leg-"]').length === 2 && [...document.querySelectorAll('#sheet-body [id^="leg-"] .row-detail')].every((d) => !/Reading/.test(d.textContent)), null, { timeout: 60000 });
  const legs = await page.locator('#sheet-body [id^="leg-"]').allInnerTexts();
  expect(/Leg 1 → Point 2\s+090°T\s+[\d.]+ nm\s+\d+m\s+arrive \d\d:\d\d\s+Total/.test(legs[0]) && /Leg 2 → Point 3\s+000°T\s+[\d.]+ nm\s+\d+m\s+arrive/.test(legs[1]), `the legs read ${JSON.stringify(legs)}`);
  expect(/2 legs, [\d.]+ nm, \d+m\s+Arrive \d\d:\d\d/.test(await page.locator('#legs-total').innerText()), 'the legs have no total');
  expect(legs.every((l) => /Least depth [\d.]+ m|No depths on the device|Crosses land/.test(l)), `the depths along the legs read ${JSON.stringify(legs)}`);
  if ((await charts(page)).some((c) => c.kind === 'geotiff')) expect(/Least depth [\d.]+ m/.test(legs[0]), `with a survey under it, the first leg reads "${legs[0]}"`);
  await shot(page, '7i-route-legs');
  await closeSheet(page);
  // The cruise speed is set on the card, and the times follow it.
  await page.fill('#route-speed', '10');
  await page.locator('#route-speed').dispatchEvent('change');
  await page.waitForFunction(() => /at 10\.0 kn/.test(document.querySelector('#toolcard').textContent), null, { timeout: 10000 });
  // Reversed, and back again.
  await page.click('#route-reverse');
  expect(await page.evaluate(() => Math.abs(window.seabathy.routes.current()[0].lat - (-20.17)) < 1e-6), 'Reverse did not turn the route round');
  await page.click('#route-reverse');
  await shot(page, '7j-route');
  // Saved by name, listed, and out as GPX.
  await page.click('#route-save');
  await page.fill('#route-name', 'To the shoal & back <1>');
  await page.click('#route-save-yes');
  await page.waitForFunction(() => window.seabathy.routes.list().length === 1);
  await page.click('#route-library');
  await page.locator('#sheet-body .row', { hasText: 'To the shoal' }).click();
  const gpx = await fileFrom(page, '#route-gpx');
  expect(gpx.includes('<rte><name>To the shoal &amp; back &lt;1&gt;</name>') && (gpx.match(/<rtept /g) || []).length === 3, 'the GPX file does not hold the route');
  // Deleted, then read back in from that file; a second read adds nothing.
  await page.click('#route-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.routes.list().length === 0);
  const read = await page.evaluate(async (text) => [await window.seabathy.waypoints.importGpxText(text), await window.seabathy.waypoints.importGpxText(text)], gpx);
  expect(read[0].routes === 1 && read[1].routes === 0, `reading the GPX file twice gave ${JSON.stringify(read)}`);
  const back = await page.evaluate(() => window.seabathy.routes.list()[0]);
  expect(back.name === 'To the shoal & back <1>' && back.points.length === 3 && Math.abs(back.points[1].lng - 149.13) < 1e-6, `the route came back as ${JSON.stringify(back)}`);
  expect((await page.evaluate(() => window.seabathy.db.setting.get('routes'))).length === 1, 'the route was not kept');
  await closeSheet(page);
  await page.click('#route-clear');
  await page.click('#btn-route');
  expect(await page.locator('#toolcard').isHidden() && await page.evaluate(() => window.seabathy.routes.current().length) === 0, 'the route tool did not clear and close');
  await goTo(page, MID.lng, MID.lat, 10);
  return `${card.replace(/\s+/g, ' ').replace(/^ROUTE\s+UNDO\s+CLEAR\s+/i, '').split(/\s+SAVE\b/i)[0]}; ${legs[0].replace(/\s+/g, ' ')}`;
});

await step('Backup: waypoints, routes and settings go into one file, and come back from it', async () => {
  await openMenu(page, 'menu-backup');
  const text = await fileFrom(page, '#backup-save');
  const backup = JSON.parse(text);
  expect(backup.app === 'SeaBathy web app' && backup.format === 1 && backup.waypoints.length === 1 && backup.routes.length === 1 && backup.settings.units && backup.settings.places, `the backup holds ${text.slice(0, 200)}`);
  expect(!text.includes('termsAccepted') && !text.includes('camera'), 'the backup carries this device\'s own state');
  // The same file read back adds nothing; one with another mark and route in it adds just those.
  const more = JSON.parse(text);
  more.waypoints.push({ ...more.waypoints[0], id: 'another', name: 'From the backup', lat: more.waypoints[0].lat + 0.01 });
  more.routes.push({ id: 'r2', name: 'Second route', points: [{ lat: -20.3, lng: 149.0 }, { lat: -20.31, lng: 149.02 }], created: 1 });
  const file = path.join(workDir, 'data', `backup-${engineName}-${pass}.json`);
  writeFileSync(file, JSON.stringify(more));
  await page.setInputFiles('#backup-file', file);
  await page.waitForSelector('#restore-marks');
  expect(/2 waypoints and 2 routes/.test(await page.locator('.card').innerText()), 'the card does not say what the backup holds');
  await page.click('#restore-marks');
  await page.waitForFunction(() => /Added 1 waypoint and 1 route; 1 already here/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  const now = await page.evaluate(() => ({ waypoints: window.seabathy.waypoints.list().map((w) => w.name), routes: window.seabathy.routes.list().map((r) => r.name) }));
  expect(now.waypoints.includes('From the backup') && now.routes.includes('Second route') && now.waypoints.length === 2 && now.routes.length === 2, `after the restore: ${JSON.stringify(now)}`);
  // A file that isn't a backup is refused with a plain word.
  const wrong = path.join(workDir, 'data', 'not-a-backup.json');
  writeFileSync(wrong, '{"hello": 1}');
  await page.setInputFiles('#backup-file', wrong);
  await page.waitForFunction(() => /isn't a SeaBathy/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  await closeSheet(page);
  // Tidied away: the extra mark and both routes.
  const extra = await page.evaluate(() => window.seabathy.waypoints.list().find((w) => w.name === 'From the backup').id);
  await page.locator(`.wpt[data-id="${extra}"]`).evaluate((node) => node.click());
  await page.click('#wpt-delete');
  await page.click('#confirm-yes');
  await page.waitForFunction(() => window.seabathy.waypoints.list().length === 1, null, { timeout: 10000 });
  await closeSheet(page);
  for (let i = 0; i < 2; i++) {
    await openMenu(page, 'menu-routes');
    await page.locator('#sheet-body .row').first().click();
    await page.click('#route-delete');
    await page.click('#confirm-yes');
    await page.waitForFunction((n) => window.seabathy.routes.list().length === n, 1 - i, { timeout: 10000 });
    await closeSheet(page);
  }
  return `${backup.waypoints.length} waypoint, ${backup.routes.length} route and ${Object.keys(backup.settings).length} settings saved; restoring added only what was new`;
});

await step('Buoys and beacons (beta): the warning each time, the marks drawn and described, credited, and off again', async () => {
  const count = () => page.evaluate(() => (window.seabathy.map.getLayer('sb-over-marks') ? window.seabathy.map.queryRenderedFeatures({ layers: ['sb-over-marks'] }).length : -1));
  await openMenu(page, 'menu-places');
  await page.click('#places-marks');
  await page.waitForSelector('#marks-ack');
  expect(/not for navigation/i.test(await page.locator('.card').innerText()), 'the warning does not say not for navigation');
  await page.click('#marks-ack');
  await closeSheet(page);
  // Sydney Harbour: channel marks, cardinals and moorings.
  await goTo(page, 151.255, -33.845, 13);
  await page.waitForFunction(() => window.seabathy.map.getLayer('sb-over-marks') && window.seabathy.map.queryRenderedFeatures({ layers: ['sb-over-marks'] }).length > 3, null, { timeout: 90000 });
  expect((await page.locator('#credits').innerText()).includes('Nav marks:'), 'the marks are not credited on the chart');
  const mark = await page.evaluate(() => {
    const map = window.seabathy.map;
    for (const f of map.queryRenderedFeatures({ layers: ['sb-over-marks'] })) {
      const p = map.project(f.geometry.coordinates);
      if (p.x > 70 && p.x < 320 && p.y > 150 && p.y < 520) return { x: p.x, y: p.y - 6, label: f.properties.label, icon: f.properties.icon };
    }
    return null;
  });
  expect(mark, 'no mark is drawn where it can be tapped');
  expect(await page.evaluate((icon) => window.seabathy.map.hasImage(`sb-mark-${icon}`), mark.icon), `there is no picture for ${mark.icon}`);
  await page.mouse.click(mark.x, mark.y);
  await page.waitForSelector('#place-close', { timeout: 10000 });
  const said = await page.locator('.card').innerText();
  expect(/Positions may be old or wrong/.test(said) && /Not for navigation/.test(said), `a tap on a mark said: ${said.replace(/\s+/g, ' ')}`);
  await shot(page, '7k-buoys');
  await page.click('#place-close');
  const shownCount = await count();
  await openMenu(page, 'menu-places');
  await page.click('#places-marks');
  await closeSheet(page);
  await page.waitForFunction(() => !window.seabathy.map.getLayer('sb-over-marks'), null, { timeout: 10000 });
  expect(!(await page.locator('#credits').innerText()).includes('Nav marks:'), 'the credit stayed after the marks went');
  // Off again at every start: the choice is not kept.
  expect(await page.evaluate(async () => JSON.stringify(await window.seabathy.db.setting.get('places')).includes('marks')) === false, 'the buoys layer was kept as on');
  await goTo(page, MID.lng, MID.lat, 10);
  return `${shownCount} marks in Sydney Harbour; a tap said "${said.split('\n').filter(Boolean).slice(1, 2).join('')}"`;
});

await step('Install: the menu offers it, with one tap where the browser makes an offer and the steps for every other browser', async () => {
  await openMenu(page, 'menu-install');
  const said = await page.locator('#sheet-body').innerText();
  // These tests run as an iPhone, so its own steps come first; every other browser is listed.
  expect(/IN THIS BROWSER/.test(said) && /Add to Home Screen/.test(said), 'the steps for this browser are missing');
  for (const name of ['Chrome, Brave or Edge on Android', 'Firefox on Android', 'Samsung Internet', 'Chrome or Brave on a computer', 'Edge on a computer', 'Safari on a Mac', 'Firefox on a computer']) {
    expect(said.includes(name), `no steps for ${name}`);
  }
  expect(await page.locator('#install-now').count() === 0, 'an Install button is shown although the browser made no offer');
  // A browser that offers to install (Chrome, Edge, Brave): the panel gains the button, and it calls on the browser.
  await page.evaluate(() => {
    const offer = new Event('beforeinstallprompt');
    offer.prompt = () => { window.installAsked = true; };
    offer.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(offer);
  });
  await page.click('#install-now');
  expect(await page.evaluate(() => window.installAsked === true), 'the Install button did not call on the browser');
  await shot(page, '8b-install');
  await closeSheet(page);
  const manifest = JSON.parse(readFileSync(path.join(appRoot, 'manifest.json'), 'utf8'));
  expect(manifest.display === 'standalone' && manifest.icons.some((i) => i.sizes === '512x512') && manifest.icons.some((i) => i.purpose === 'maskable'), 'the manifest is missing what browsers need to install the app');
  for (const picture of manifest.screenshots) expect(existsSync(path.join(appRoot, picture.src)), `the manifest names a picture that is not there: ${picture.src}`);
  return `steps for ${said.split('\n').filter((line) => /: /.test(line) && / on |Safari|Samsung|iPhone/.test(line)).length + 1} browsers; the Install button calls the browser's own offer`;
});

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
  const stampFile = readFileSync(path.join(appRoot, 'js/install.js'), 'utf8');
  /** Publishes a release: every file of a release carries its version, the app's own version line among them. */
  const newer = (version) => {
    swap.set('/sw.js', sw.replace(`const VERSION = '${current}'`, `const VERSION = '${version}'`));
    swap.set('/js/install.js', stampFile.replace(`export const VERSION = '${current}'`, `export const VERSION = '${version}'`));
  };
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

  // A release caught half-published (its service worker new, another file still the old one) is not taken.
  swap.set('/sw.js', sw.replace(`const VERSION = '${current}'`, "const VERSION = '9.9.0'"));
  expect(await page.evaluate(() => window.seabathy.updates.check()) === 'latest', 'a half-published release was taken');
  expect(await page.locator('#update').isHidden() && await inCharge() === current, 'a half-published release is offered or in charge');
  expect((await page.evaluate(() => caches.keys())).filter((n) => /^seabathy-\d/.test(n)).join() === `seabathy-${current}`, 'a half-published release left files behind');

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
  expect((await page.evaluate(() => caches.keys())).filter((n) => /^seabathy-\d/.test(n)).join() === 'seabathy-9.9.1', 'the old copy of the app was not cleared away');

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

await step('A start that meets files from two releases says so and tries again by itself', async () => {
  // A fresh browser with nothing kept, as for someone opening the address while it is being published.
  const other = await engine.launch(launchOptions);
  try {
    const fresh = await (await other.newContext(options)).newPage();
    // One file from "another release": it lacks what the others expect of it.
    swap.set('/js/gpx.js', 'export const somethingElse = 1;\n');
    await fresh.goto(APP, { waitUntil: 'load', timeout: LOAD });
    await fresh.waitForFunction(() => !document.querySelector('#fatal').hidden, null, { timeout: 30000 });
    const said = await fresh.locator('#fatal-text').innerText();
    expect(/being updated/.test(said) && /Trying again/.test(said), `the start screen said "${said}"`);
    expect(await fresh.evaluate(() => typeof window.seabathy) === 'undefined', 'the app started with a file that does not fit');
    // The site is whole again: the app comes up at its next try, with nobody touching it.
    swap.delete('/js/gpx.js');
    await fresh.waitForFunction(() => window.seabathy && document.body.classList.contains('ready') && document.querySelector('#fatal').hidden, null, { timeout: 60000 });
    return `"${said}", then it started by itself`;
  } finally {
    swap.delete('/js/gpx.js');
    await other.close();
  }
});

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
