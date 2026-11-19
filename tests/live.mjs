// A check of the published app, the way a phone meets it: opened at its real address in WebKit
// (Safari's engine) set up as an iPhone, with the real depth servers. Run it after publishing:
//
//   node tests/live.mjs                      WebKit, https://app.seabathy.com/
//   ENGINE=chromium node tests/live.mjs      the same in Chromium
//   node tests/live.mjs https://…            another address
//
// It draws a box and downloads a small piece of real high-detail depths, so it needs the
// internet and should not be run in a loop.

import { webkit, chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { workDir } from './server.mjs';

const address = process.argv[2] || 'https://app.seabathy.com/';
const engineName = process.env.ENGINE || 'webkit';
const shots = path.join(workDir, 'live');
mkdirSync(shots, { recursive: true });
const browser = await (engineName === 'chromium' ? chromium : webkit).launch();
// The real certificate must be good: no errors are let through here.
const context = await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => { if (!/ResizeObserver loop/.test(error.message)) problems.push(error.message); });
let failed = 0;

async function check(name, work) {
  try {
    console.log(`PASS  ${name}  (${await work()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.message || error).split('\n')[0]}`);
  }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };

await check('Opens over HTTPS with a good certificate', async () => {
  const response = await page.goto(address, { waitUntil: 'load', timeout: 60000 });
  expect(response.ok(), `the address answered ${response.status()}`);
  expect(page.url().startsWith('https://'), `ended at ${page.url()}`);
  await page.waitForFunction(() => window.seabathy || !document.querySelector('#fatal').hidden, null, { timeout: 60000 });
  expect(await page.evaluate(() => Boolean(window.seabathy)), await page.evaluate(() => document.querySelector('#fatal-text').textContent));
  if (await page.locator('#install').isVisible()) await page.click('#install-skip');
  await page.click('#terms-agree');
  await page.click('#updates-auto');
  return page.evaluate(() => `version ${window.seabathy.version} at ${location.origin}`);
});

await check('Keeps itself for offline use', async () => {
  const state = await page.evaluate(async () => {
    for (let i = 0; i < 600 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
    const names = (await caches.keys()).filter((n) => n.startsWith('seabathy-'));
    return { controlled: Boolean(navigator.serviceWorker.controller), names, files: names.length ? (await (await caches.open(names[0])).keys()).length : 0 };
  });
  expect(state.controlled, 'no service worker took charge');
  expect(state.files >= 45, `only ${state.files} files kept`);
  return `${state.files} files in ${state.names.join(', ')}`;
});

await check('Licence texts are served', async () => {
  const sizes = await page.evaluate(async () => Promise.all(['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'glyphs/LICENSE.txt'].map(async (f) => {
    const r = await fetch(f);
    return r.ok ? (await r.text()).length : 0;
  })));
  expect(sizes.every((n) => n > 3000), `sizes ${sizes.join(', ')}`);
  return `${sizes.map((n) => Math.round(n / 1000)).join(', ')} thousand characters`;
});

await check('High-detail depths download from IMAS and are kept', async () => {
  // The north of Hook Island, in the Whitsundays.
  await page.evaluate(() => window.seabathy.map.jumpTo({ center: [148.93, -20.08], zoom: 12.6 }));
  await page.waitForTimeout(1500);
  await page.click('#btn-menu');
  await page.click('#menu-seabed');
  const started = Date.now();
  await page.click('#seabed-high');
  // Nothing is asked for until a box has been drawn and confirmed.
  await page.waitForSelector('#area-bar');
  expect(await page.evaluate(() => document.querySelector('#area-go').disabled), 'the picker did not start empty');
  await page.mouse.move(60, 150);
  await page.mouse.down();
  await page.mouse.move(200, 280, { steps: 4 });
  await page.mouse.move(330, 400, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('#area-go').disabled, null, { timeout: 15000 });
  const told = await page.evaluate(() => `${document.querySelector('#area-size').textContent}: ${document.querySelector('#area-info').textContent}`);
  await page.click('#area-go');
  await page.waitForFunction(() => window.seabathy.charts.list().length === 1, null, { timeout: 180000 });
  const chart = await page.evaluate(() => {
    const c = window.seabathy.charts.list()[0];
    return { name: c.name, size: c.size, cells: `${c.tiff.width}×${c.tiff.height}`, min: c.tiff.min, max: c.tiff.max, credit: c.attribution, session: Boolean(c.session) };
  });
  expect(chart.min < -20 && chart.max > -200, `depths run ${chart.min} to ${chart.max}`);
  expect(/IMAS/.test(chart.credit), `the credit reads "${chart.credit}"`);
  await page.waitForTimeout(3000);
  expect((await page.locator('#credits').innerText()).includes('IMAS'), 'the IMAS credit is not on the chart');
  await page.screenshot({ path: path.join(shots, `${engineName}-chart.png`) });
  return `box ${told} ${chart.name}: ${chart.cells} cells, ${(chart.size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s${chart.session ? ' (held in memory: this browser build has no file storage to write to)' : ''}`;
});

await check('The seabed opens in 3D with its credit', async () => {
  await page.click('#btn-3d');
  await page.waitForFunction(() => {
    const w = document.querySelector('#view3d')?.contentWindow;
    return w?.__terrainTest && w.__terrainTest.state().cols > 0 && w.__terrainTest.frames() > 2 && w.document.querySelector('#busy').hidden;
  }, null, { timeout: 120000 });
  const view = await page.evaluate(() => {
    const w = document.querySelector('#view3d').contentWindow;
    return { ...w.__terrainTest.state(), info: w.document.querySelector('#grid-info').textContent.trim(), credit: w.document.querySelector('#map-credit').textContent };
  });
  expect(view.cols > 100 && view.rows > 100, `the grid is ${view.cols}×${view.rows}`);
  expect(/IMAS/.test(view.credit), `the 3D credit reads "${view.credit}"`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, `${engineName}-3d.png`) });
  await page.evaluate(() => window.seabathy.terrain.close());
  return view.info;
});

await check('With the network off, the app opens from its own copy', async () => {
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.seabathy?.map, null, { timeout: 60000 });
    const state = await page.evaluate(() => ({ charts: window.seabathy.charts.list().length, online: navigator.onLine }));
    return `started offline; ${state.charts} depth layer${state.charts === 1 ? '' : 's'} still there`;
  } finally {
    await context.setOffline(false);
  }
});

await browser.close();
if (problems.length) console.log(`\nErrors the page reported:\n  ${[...new Set(problems)].slice(0, 8).join('\n  ')}`);
console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'} at ${address} in ${engineName}.`);
process.exit(failed ? 1 : 0);
