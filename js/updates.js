// Keeping the app up to date. The app's files come from the web address it was opened at, and
// the service worker fetches a newer set when that address has one. Here: when to look, and
// whether the newer set is switched to by itself or only after a tap.
//
// Looking for a newer version asks that one address for one small file and sends nothing about
// the person or the phone. Depths, charts and waypoints are kept apart from the app's files and
// stay through every update.

import { setting } from './db.js';
import { $, card, toast } from './ui.js';

/** While the app stays open, how often it looks again when it comes back to the front. */
const LOOK_EVERY_MS = 6 * 3600 * 1000;
/** Back from this long in the background, switching to a fetched version disturbs nobody. */
const AWAY_MS = 60 * 1000;
const SWITCH_WAIT_MS = 6000;

let registration = null;
/** A newer version, fetched and waiting to be used. */
let waiting = null;
let waitingVersion = null;
let controlled = false;
let reloading = false;
let lastLook = 0;
let hiddenAt = 0;
/** True when nothing would be lost or interrupted by loading the page again. */
let quiet = () => true;

const supported = () => 'serviceWorker' in navigator;
const within = (promise, ms) => Promise.race([promise.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/** 'auto' or 'ask'. Until the person has chosen, nothing changes without a tap. */
export const mode = () => setting.get('updates', 'ask');

export async function setMode(value) {
  await setting.set('updates', value === 'auto' ? 'auto' : 'ask');
  await present();
}

/** The version number a service worker carries, or null when it doesn't answer. */
function versionOf(worker) {
  return within(new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(typeof event.data === 'string' ? event.data.slice(0, 20) : null);
    worker.postMessage('version', [channel.port2]);
  }), 1500);
}

const waitingName = () => (waitingVersion ? `Version ${waitingVersion}` : 'A new version');

/** The bar at the top: shown while a version waits for a tap. */
async function present() {
  const bar = $('#update');
  if (!waiting || (await mode()) === 'auto') {
    bar.hidden = true;
    return;
  }
  bar.textContent = `${waitingName()} is ready. Tap to update.`;
  bar.onclick = useNow;
  bar.hidden = false;
}

/**
 * Hands the app over to [worker]; the page then loads again with the new files. Resolves false
 * if nothing happened in a few seconds (the page carries on as it was).
 */
function switchTo(worker) {
  return new Promise((resolve) => {
    try {
      worker.postMessage('skipWaiting');
    } catch {
      resolve(false);
      return;
    }
    setTimeout(() => resolve(false), SWITCH_WAIT_MS);
  });
}

/** The fetched version's number while one waits, '' when it didn't say, null when none waits. */
export const readyVersion = () => (waiting ? waitingVersion || '' : null);

/** Switches to the fetched version now. */
export function useNow() {
  return waiting ? switchTo(waiting) : Promise.resolve(false);
}

async function found(worker) {
  // The very first install is not an update.
  if (!navigator.serviceWorker.controller) return;
  waiting = worker;
  waitingVersion = await versionOf(worker);
  await present();
  if ((await mode()) === 'auto') toast(`${waitingName()} is downloaded. SeaBathy will use it the next time you open it.`, 6000);
}

async function look() {
  lastLook = Date.now();
  await registration?.update().catch(() => {});
}

async function onVisibility() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  if (waiting) {
    if (away >= AWAY_MS && (await mode()) === 'auto' && quiet()) switchTo(waiting);
    return;
  }
  if (Date.now() - lastLook > LOOK_EVERY_MS) look();
}

async function watch() {
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch (error) {
    console.warn('Offline use could not be set up', error);
    return;
  }
  // Registering looks for a newer version by itself.
  lastLook = Date.now();
  if (registration.waiting) found(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed') found(worker); });
  });
  document.addEventListener('visibilitychange', onVisibility);
}

/**
 * Called at start-up, before the chart is built. With automatic updates, a version fetched
 * earlier is switched to here, so the app opens straight into it. [isQuiet] says whether the
 * page can be loaded again later without interrupting anything.
 */
export async function start(isQuiet) {
  if (!supported()) return;
  quiet = isQuiet;
  controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install taking over needs no reload; a newer version does.
    if (!controlled) {
      controlled = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  if (controlled && (await mode()) === 'auto') {
    const earlier = await within(navigator.serviceWorker.getRegistration(), 1500);
    if (earlier?.waiting) {
      toast('Updating SeaBathy…', SWITCH_WAIT_MS);
      await switchTo(earlier.waiting);
    }
  }
  watch();
}

/**
 * Looks for a newer version now, and waits while its files are fetched. Answers 'ready',
 * 'latest', 'offline' (the look itself failed) or 'unavailable' (no offline support here).
 */
export async function check() {
  if (!registration) return 'unavailable';
  if (waiting) return 'ready';
  lastLook = Date.now();
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  const fetching = registration.installing;
  if (fetching) {
    await within(new Promise((resolve) => {
      const settle = () => { if (fetching.state !== 'installing') resolve(); };
      fetching.addEventListener('statechange', settle);
      settle();
    }), 90000);
    // found() has the version to ask for first.
    for (let i = 0; i < 20 && !waiting && fetching.state === 'installed'; i++) await new Promise((r) => setTimeout(r, 100));
  }
  return waiting ? 'ready' : 'latest';
}

/** On the first start: automatic updates, or a tap each time. */
export async function askIfNeeded() {
  if (!supported() || (await setting.get('updates', null))) return;
  const answer = await card({
    badge: 'Updates', title: 'Keep SeaBathy up to date?',
    paragraphs: [
      'When you are online, SeaBathy looks at its own web address for a newer version and downloads it.',
      'Automatic: the new version is used the next time you open the app. Ask me first: a bar at the top says it is ready, and nothing changes until you tap it.',
      'Your depths, charts and waypoints stay on the phone through every update.'
    ],
    fine: 'You can change this at any time in Settings, About.',
    actions: [{ id: 'ask', label: 'Ask me first', domId: 'updates-ask' }, { id: 'auto', label: 'Automatic', primary: true, domId: 'updates-auto' }]
  });
  await setMode(answer);
}

/** Says so once after the app has changed to another version. */
export async function noteVersion(version) {
  const before = await setting.get('version', null);
  if (before === version) return;
  await setting.set('version', version);
  if (before) toast(`SeaBathy is now version ${version}.`, 5000);
}
