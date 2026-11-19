// A quick look at whether the app starts at all: opens it once and prints what the page says.
// ENGINE=chromium for Chromium. Used while working on the app; the real tests are run.mjs.

import { webkit, chromium, devices } from 'playwright';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { serve, appRoot, workDir } from './server.mjs';

const engine = process.env.ENGINE === 'chromium' ? chromium : webkit;
const profile = path.join(workDir, 'profile-smoke');
rmSync(profile, { recursive: true, force: true });
const server = await serve({ root: appRoot, port: 8445 });
const context = await engine.launchPersistentContext(profile, { ...devices['iPhone 15'], ignoreHTTPSErrors: true, headless: !process.env.HEADED });
const page = context.pages()[0] || await context.newPage();
page.on('console', (m) => console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
const t0 = Date.now();
page.on('request', (r) => console.log(`${Date.now() - t0} ms  ask ${r.url().replace('https://localhost:8445/', '')}`));
page.on('response', (r) => console.log(`${Date.now() - t0} ms  [${r.status()}] ${r.url().replace('https://localhost:8445/', '')}`));
page.on('requestfailed', (r) => console.log(`[failed] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
await page.goto('https://localhost:8445/', { waitUntil: 'load', timeout: 30000 }).catch((e) => console.log('goto:', e.message));
await page.waitForTimeout(Number(process.env.WAIT) || 8000);
console.log(await page.evaluate(() => ({
  seabathy: typeof window.seabathy,
  fatal: document.querySelector('#fatal')?.hidden === false ? document.querySelector('#fatal-text').textContent : null,
  install: document.querySelector('#install')?.hidden === false,
  webgl: (() => { try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2')) + '/' + Boolean(c.getContext('webgl')); } catch (e) { return String(e); } })(),
  sw: 'serviceWorker' in navigator,
  secure: window.isSecureContext,
  ua: navigator.userAgent.slice(0, 90)
})).catch((e) => `evaluate failed: ${e.message}`));
await page.screenshot({ path: path.join(workDir, 'smoke.png') }).catch(() => {});
await context.close();
server.close();
