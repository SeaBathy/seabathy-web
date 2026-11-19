// The tools on the top bar that work on the chart itself: the waypoint tool, measuring, man
// overboard, and going to coordinates. One tool is on at a time; while one is on, a line at the
// foot says what a tap does, as in the Android app.

import * as gps from './gps.js';
import * as units from './units.js';
import * as waypoints from './waypoints.js';
import { $, add, card, el, field, holdScreenOn, mini, toast } from './ui.js';

export { parseAngle } from './units.js';

const EARTH_M = 6371008.8;
const M_PER_NM = 1852;
const rad = (degrees) => (degrees * Math.PI) / 180;

/** Metres between two points, along the great circle. */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The true bearing from [a] to [b], 0 to 360 degrees. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** "0.42 nm", "12.3 nm": short distances in metres. */
export function distanceText(metres) {
  const nm = metres / M_PER_NM;
  if (metres < 185.2) return `${Math.round(metres)} m`;
  return `${nm < 10 ? nm.toFixed(2) : nm.toFixed(1)} nm`;
}

/** "5.48 nm (10.2 km)": nautical miles with kilometres beside them, as the measure tool reads. */
export function distanceBoth(metres) {
  if (metres < 185.2) return distanceText(metres);
  const km = metres / 1000;
  return `${distanceText(metres)} (${km < 1 ? `${Math.round(metres)} m` : `${km.toFixed(km < 100 ? 1 : 0)} km`})`;
}

export const bearingText = (degrees) => `${String(Math.round(degrees) % 360).padStart(3, '0')}°T`;

// ---------------------------------------------------------------- which tool is on

let map = null;
let tool = 'none';
const tools = new Map();

/** 'none', 'waypoint', 'measure' or 'route'. */
export const mode = () => tool;

/** A tool that takes taps on the chart: { button, hint, on(), off(), tap(lngLat) }. */
export function register(name, handlers) {
  tools.set(name, handlers);
}

function paint() {
  for (const [name, t] of tools) $(t.button)?.classList.toggle('active', name === tool);
  const hint = $('#hint');
  hint.textContent = tools.get(tool)?.hint || '';
  hint.hidden = !hint.textContent;
  document.body.classList.toggle('tool-on', tool !== 'none');
}

/** Turns a tool on, or off again if it is the one that is on. */
export function toggle(name) {
  const next = tool === name ? 'none' : name;
  if (tool !== 'none') tools.get(tool)?.off?.();
  tool = next;
  if (tool !== 'none') tools.get(tool)?.on?.();
  paint();
}

export function stop() {
  if (tool !== 'none') toggle(tool);
}

// ---------------------------------------------------------------- the card at the foot

/**
 * The card across the foot of the chart that a tool writes in. With a [label] the first row is
 * the label and the [head] buttons, and the [lines] follow; without one the first line shares
 * the row with the buttons. [actions] are a row of buttons under the text, [extra] anything more.
 */
export function showCard({ id = null, label = null, lines = [], head = [], actions = [], extra = null, alert = false }) {
  const holder = $('#toolcard');
  const text = lines.filter(Boolean);
  holder.replaceChildren();
  holder.className = alert ? 'alert' : '';
  if (id) holder.dataset.tool = id;
  add(holder,
    el('div', { class: 'toolcard-head' },
      label ? el('div', { class: 'toolcard-label', text: label }) : el('div', { class: 'toolcard-line', text: text.shift() || '' }),
      head),
    text.map((line) => el('div', { class: 'toolcard-line', text: line })),
    actions.length ? el('div', { class: 'toolcard-actions' }, actions) : null,
    extra);
  holder.hidden = false;
  document.body.classList.add('card-on');
}

export function hideCard(id = null) {
  const holder = $('#toolcard');
  if (id && holder.dataset.tool !== id) return;
  holder.hidden = true;
  holder.replaceChildren();
  document.body.classList.remove('card-on');
}

// ---------------------------------------------------------------- measuring

const measured = [];

function drawMeasure() {
  const coordinates = measured.map((p) => [p.lng, p.lat]);
  map.getSource('sb-measure')?.setData({
    type: 'FeatureCollection',
    features: [
      ...(coordinates.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : []),
      ...coordinates.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
    ]
  });
}

/** The readout: the whole length, and the bearing of the last leg drawn. */
export function measureSummary() {
  if (!measured.length) return null;
  if (measured.length < 2) return 'Tap another point';
  let total = 0;
  for (let i = 1; i < measured.length; i++) total += distanceM(measured[i - 1], measured[i]);
  return `${distanceBoth(total)}  —  ${bearingText(bearing(measured[measured.length - 2], measured[measured.length - 1]))}`;
}

function showMeasure() {
  drawMeasure();
  const summary = measureSummary();
  if (!summary) {
    hideCard('measure');
    return;
  }
  showCard({
    id: 'measure', lines: [summary],
    head: [mini('Clear', () => {
      measured.length = 0;
      showMeasure();
      if (tool === 'measure') toggle('measure');
    }, { accent: true, id: 'measure-clear' })]
  });
}

/** The line and its points are part of the chart's style: put back after each change of basemap. */
export function installLayers() {
  if (!map) return;
  if (!map.getSource('sb-measure')) map.addSource('sb-measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getLayer('sb-measure-line')) {
    const line = { type: 'line', source: 'sb-measure', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' } };
    map.addLayer({ ...line, id: 'sb-measure-casing', paint: { 'line-color': '#111418', 'line-width': 5 } });
    map.addLayer({ ...line, id: 'sb-measure-line', paint: { 'line-color': '#F59E0B', 'line-width': 2.5 } });
    map.addLayer({ id: 'sb-measure-point', type: 'circle', source: 'sb-measure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5.5, 'circle-color': '#F59E0B', 'circle-stroke-color': '#111418', 'circle-stroke-width': 1.5 } });
  }
  drawMeasure();
}

// ---------------------------------------------------------------- man overboard

/** The waypoint marked for the person in the water, while the alert is on. */
let mob = null;
let mobWaiting = false;
let stopFixes = null;
let letSleep = null;

const endButton = () => mini('End', endMob, { id: 'mob-end' });

function showMob(position) {
  if (!mob) return;
  const here = position ? { lat: position.coords.latitude, lng: position.coords.longitude } : null;
  const back = here
    ? `${distanceText(distanceM(here, mob))} back, steer ${bearingText(bearing(here, mob))}`
    : 'Waiting for the GPS to say where the boat is now…';
  showCard({
    id: 'mob', alert: true, label: 'MAN OVERBOARD', head: [endButton()],
    lines: [back, `Marked at ${units.positionText(mob.lat, mob.lng)}. Call for help: VHF channel 16, or 000.`]
  });
}

async function markMob(position) {
  mobWaiting = false;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  mob = await waypoints.addMarked(position.coords.longitude, position.coords.latitude, { name: `MOB ${time}`, icon: 'mob', color: '#EF4444', desc: 'Man overboard' });
  try {
    navigator.vibrate?.([400, 150, 400, 150, 400]);
  } catch { /* a phone that doesn't buzz still shows the card */ }
  showMob(position);
}

async function endMob() {
  mob = null;
  mobWaiting = false;
  stopFixes?.();
  stopFixes = null;
  letSleep?.();
  letSleep = null;
  $('#btn-mob').classList.remove('active');
  hideCard('mob');
}

/** The red button: marks where the boat is now (or at its first fix) and shows the way back. */
export async function manOverboard() {
  if (mob || mobWaiting) {
    const answer = await card({
      title: 'End the man overboard alert?', paragraphs: ['The mark stays on the chart as a waypoint.'], dismissable: true,
      actions: [{ id: 'no', label: 'Keep it on' }, { id: 'yes', label: 'End', primary: true, domId: 'mob-end-yes' }]
    });
    if (answer === 'yes') endMob();
    return;
  }
  stop();
  mobWaiting = true;
  $('#btn-mob').classList.add('active');
  letSleep = await holdScreenOn();
  stopFixes = gps.subscribe((position) => {
    if (mobWaiting) markMob(position);
    else showMob(position);
  });
  const fix = gps.lastFix();
  if (fix) {
    await markMob(fix);
  } else {
    gps.turnOn();
    showCard({
      id: 'mob', alert: true, label: 'MAN OVERBOARD', head: [endButton()],
      lines: ['Waiting for the GPS: the spot is marked at its first position.', 'Call for help: VHF channel 16, or 000.']
    });
  }
}

export const mobActive = () => Boolean(mob) || mobWaiting;

// ---------------------------------------------------------------- going to coordinates

/**
 * A tap on the position at the top: coordinates are typed in, in the form picked, and the
 * chart moves there or a waypoint is made there. Laid out as the Android app's is.
 */
export async function goToPosition() {
  const centre = map.getCenter().wrap();
  let at = { lat: centre.lat, lng: centre.lng };
  const typed = el('input', { type: 'text', id: 'goto-coords', value: units.positionText(at.lat, at.lng), autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
  const preview = el('div', { class: 'readout', id: 'goto-preview' });
  const format = el('select', { id: 'goto-format' },
    Object.entries(units.POSITIONS).map(([id, form]) => el('option', { value: id, text: form.name, selected: id === units.state.position })));
  const read = () => {
    at = units.parsePosition(typed.value);
    preview.textContent = at ? units.positionText(at.lat, at.lng) : 'Not a position yet';
  };
  typed.addEventListener('input', read);
  format.addEventListener('change', async () => {
    await units.set({ position: format.value });
    // What is typed is written again in the new form.
    if (at) typed.value = units.positionText(at.lat, at.lng);
    read();
  });
  read();
  const answer = await card({
    title: 'Go to coordinates', dismissable: true,
    body: [field('Format', format), field('Coordinates', typed), field('Preview', preview)],
    fine: 'Latitude first. Minutes and seconds may be left out, and south and west may be written with a minus: -20.2550 148.9576',
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'go', label: 'Move map', domId: 'goto-go' }, { id: 'mark', label: 'Create waypoint', primary: true, domId: 'goto-mark' }]
  });
  if (answer !== 'go' && answer !== 'mark') return;
  if (!at) {
    toast("That doesn't read as a latitude and a longitude.");
    return;
  }
  map.jumpTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), 11) });
  if (answer === 'mark') waypoints.addAt(at.lng, at.lat);
}

export function start(theMap) {
  map = theMap;
  register('waypoint', {
    button: '#btn-add',
    hint: 'Tap map to drop a waypoint at the centre crosshair',
    tap: () => {
      const centre = map.getCenter().wrap();
      waypoints.addAt(centre.lng, centre.lat);
    }
  });
  register('measure', {
    button: '#btn-measure',
    hint: 'Tap map to measure — tap CLEAR when done',
    off: () => {
      measured.length = 0;
      showMeasure();
    },
    tap: (lngLat) => {
      measured.push({ lat: lngLat.lat, lng: lngLat.lng });
      showMeasure();
    }
  });
  $('#btn-add').addEventListener('click', () => toggle('waypoint'));
  $('#btn-measure').addEventListener('click', () => toggle('measure'));
  $('#btn-mob').addEventListener('click', manOverboard);
  $('#readout-pos').addEventListener('click', goToPosition);
  map.on('click', (event) => {
    if (tool === 'none' || document.querySelector('.overlay')) return;
    tools.get(tool)?.tap?.(event.lngLat.wrap(), event);
  });
  paint();
}
