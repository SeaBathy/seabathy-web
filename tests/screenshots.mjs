// Makes the pictures in the README: the app at iPhone size, with real high-detail depths it
// downloads for the north of Hook Island in the Whitsundays. Needs the internet (IMAS's
// server, the basemap and the satellite picture). Run with: node tests/screenshots.mjs

import { chromium, devices } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { serve, appRoot, workDir } from './server.mjs';

const out = path.join(appRoot, 'screenshots');
mkdirSync(out, { recursive: true });
const server = await serve({ root: appRoot, port: 8499 });
const profile = path.join(workDir, 'profile-screenshots');
rmSync(profile, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profile, {
  ...devices['iPhone 15'], deviceScaleFactor: 2, ignoreHTTPSErrors: true, args: ['--ignore-certificate-errors']
});
const page = context.pages()[0];
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 84 });
const settle = (ms) => page.waitForTimeout(ms);
const idle = () => page.evaluate(() => new Promise((resolve) => {
  const map = window.seabathy.map;
  if (map.areTilesLoaded() && !map.isMoving()) resolve();
  else map.once('idle', resolve);
}));
const ready3d = () => page.waitForFunction(() => {
  const w = document.querySelector('#view3d')?.contentWindow;
  return w?.__terrainTest && w.__terrainTest.state().cols > 0 && w.__terrainTest.frames() > 2 && w.document.querySelector('#busy').hidden;
}, null, { timeout: 120000 });

await page.goto('https://localhost:8499/');
await page.waitForFunction(() => window.seabathy);
await shot('install');
await page.click('#install-skip');
await page.click('#terms-agree');
await page.click('#updates-auto');
// Wide enough that the box drawn below takes in the north of Hook Island.
// Marine park zones and reef and island names, in the Whitsundays.
await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.98, -20.22], zoom: 9.6 }));
await page.evaluate(async () => {
  Object.assign(window.seabathy.places.state, { mode: 'all', names: true, ack: true });
  await window.seabathy.places.install();
  window.seabathy.basemap.refreshCredits();
});
await page.waitForFunction(() => window.seabathy.map.getLayer('sb-over-zones-fill') && window.seabathy.map.queryRenderedFeatures({ layers: ['sb-over-zones-fill'] }).length > 0, null, { timeout: 60000 });
await settle(4000);
await idle();
await shot('places');
await page.evaluate(async () => {
  Object.assign(window.seabathy.places.state, { mode: 'off', names: false });
  await window.seabathy.places.install();
  window.seabathy.basemap.refreshCredits();
});

await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.93, -20.1], zoom: 11.35 }));
await settle(4000);
await idle();

await page.click('#btn-menu');
await page.click('#menu-seabed');
await settle(300);
await shot('get-depths');
await page.click('#seabed-high');
// The area is drawn on the chart: a box over the water wanted.
await page.waitForSelector('#area-bar');
const { width, height } = page.viewportSize();
await page.mouse.move(width * 0.25, height * 0.14);
await page.mouse.down();
await page.mouse.move(width * 0.5, height * 0.4, { steps: 4 });
await page.mouse.move(width * 0.75, height * 0.62, { steps: 4 });
await page.mouse.up();
await page.waitForFunction(() => !document.querySelector('#area-go').disabled);
await settle(300);
await shot('draw-area');
await page.click('#area-go');
await page.waitForFunction(() => window.seabathy.charts.list().length === 1, null, { timeout: 180000 });
// The "saved" message has gone and the chart has settled, with the crosshair over deep water.
await settle(8000);
await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.936, -20.046], zoom: 12.6 }));
await settle(1500);
await idle();
await settle(600);
await shot('chart');

// The Layers panel with the depth layer in it, then the layer's colours, then Settings.
await page.click('#btn-menu');
await settle(400);
await shot('menu');
await page.click('.layer-more');
await page.locator('#ramp-palette').scrollIntoViewIfNeeded();
await settle(400);
await shot('depth-colours');
await page.click('#sheet-close');
await page.click('#menu-settings');
await settle(400);
await shot('settings');
await page.click('#sheet-close');
await page.click('#drawer-close');

// Contour lines with water shallower than 10 m marked, then the same seabed coloured by slope.
await page.evaluate(async () => {
  const s = window.seabathy;
  const chart = s.charts.list()[0];
  chart.contours = { on: true, metres: null };
  s.depth.setShallowMark(10);
  await s.charts.restyle(chart, { save: false });
});
await page.waitForFunction(() => window.seabathy.contours.dataOf(window.seabathy.charts.list()[0].id)?.features.length > 0, null, { timeout: 60000 });
await settle(1500);
await idle();
await settle(600);
await shot('contours');
await page.evaluate(async () => {
  const s = window.seabathy;
  const chart = s.charts.list()[0];
  chart.ramp = { ...chart.ramp, colourBy: 'slope' };
  s.depth.setShallowMark(0);
  await s.charts.restyle(chart, { save: false });
});
await settle(1500);
await idle();
await settle(600);
await shot('slope');
await page.evaluate(async () => {
  const s = window.seabathy;
  const chart = s.charts.list()[0];
  chart.contours = { on: false, metres: null };
  chart.ramp = { ...chart.ramp, colourBy: 'depth' };
  await s.charts.restyle(chart, { save: false });
});
await settle(800);

// A route across the water, with the card that says its legs.
await page.click('#btn-route');
for (const [lng, lat] of [[148.905, -20.055], [148.93, -20.042], [148.958, -20.05]]) {
  await page.evaluate(([x, y]) => window.seabathy.map.jumpTo({ center: [x, y] }), [lng, lat]);
  await settle(250);
  await page.mouse.click(width * 0.5, height * 0.3);
}
await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.932, -20.062], zoom: 12.3 }));
await settle(1500);
await idle();
await shot('route');
await page.click('#route-clear');
await page.click('#btn-route');
await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.936, -20.046], zoom: 12.6 }));
await settle(800);

await page.click('#btn-3d');
await ready3d();
const frame = page.frameLocator('#view3d');
// High detail: the full 10 m of the survey in 3D.
await frame.locator('#detail').selectOption('1024');
await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().cols > 600, null, { timeout: 60000 });
await ready3d();
await frame.locator('[data-exag="10"]').click();
await settle(1200);
await shot('3d-controls');
// With the options out of the way, the view is fitted to the taller space.
const tidy = async () => {
  await frame.locator('#sheet-handle').click();
  await settle(500);
  await frame.locator('[data-cam="45"]').click();
  await settle(1800);
};
await tidy();
await shot('3d-seabed');

// Just the water between 20 and 45 m, reloaded at full detail.
await frame.locator('#sheet-handle').click();
await frame.locator('[data-tab="depth"]').click();
await frame.locator('#clip-from').fill('-45');
await frame.locator('#clip-to').fill('-20');
await frame.locator('#clip-to').dispatchEvent('change');
await frame.locator('#btn-isolate').click();
await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().isolated, null, { timeout: 60000 });
await ready3d();
await tidy();
// The whole band in the picture.
await frame.locator('[data-cam="reset"]').click();
await settle(1800);
await shot('3d-depth-band');

// The whole area again, with the satellite picture blended over the depth colours.
await frame.locator('#sheet-handle').click();
await frame.locator('#btn-show-all').click();
await page.waitForFunction(() => document.querySelector('#view3d').contentWindow.__terrainTest.state().isolated === null, null, { timeout: 60000 });
await ready3d();
await frame.locator('[data-tab="map"]').click();
await frame.locator('.map-item', { hasText: 'Sentinel-2' }).click();
await settle(9000);
await frame.locator('#drape-mix').fill('0.8');
// The islands at three times their height, without the contour labels, for a clear picture.
await frame.locator('[data-tab="contours"]').click();
await frame.locator('#contour-labels').uncheck();
await frame.locator('[data-tab="view"]').click();
await frame.locator('#exag').fill('338');
await tidy();
await shot('3d-satellite');

await context.close();
server.close();
console.log(`pictures written to ${out}`);
