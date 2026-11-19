// Routes: points put down one after another at the crosshair, with each leg's bearing, distance
// and time, and the least depth along it from the depth layers on the device. For planning: the
// app does not steer along a route or sound alarms, which would stop the moment the screen locks.

import { setting } from './db.js';
import * as charts from './charts.js';
import * as tools from './tools.js';
import * as units from './units.js';
import * as waypoints from './waypoints.js';
import { TOP } from './basemap.js';
import { buildGpx } from './gpx.js';
import { $, add, backFrom, card, closeSheet, confirmCard, el, field, heading, mini, note, openSheet, refreshSheet, row, saveFile, svg, toast, topSheet } from './ui.js';

const M_PER_NM = 1852;
/** The most places a leg's depths are read at. */
const SAMPLES = 60;
const EXPORT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>';

let map = null;
/** The route on the chart now: { lat, lng, name? }. */
let points = [];
/** The name it was saved under or loaded by; null for a route not saved yet. */
let shownName = null;
/** Routes kept by name: { id, name, points, created }. */
let saved = [];
/** Cruise speed, knots, for the times. */
let cruise = 20;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const current = () => points;
export const list = () => saved;

export function legsOf(route) {
  const legs = [];
  for (let i = 1; i < route.length; i++) {
    legs.push({ from: route[i - 1], to: route[i], metres: tools.distanceM(route[i - 1], route[i]), bearing: tools.bearing(route[i - 1], route[i]) });
  }
  return legs;
}

export const lengthOf = (route) => legsOf(route).reduce((sum, leg) => sum + leg.metres, 0);

const minutesFor = (metres) => (metres / M_PER_NM / cruise) * 60;

/** "37m", "2h 05m" at the cruise speed. */
export function timeText(metres) {
  const minutes = Math.round(minutesFor(metres));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The time of day [metres] further on, leaving now: "07:55". */
function arrival(metres) {
  return new Date(Date.now() + minutesFor(metres) * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const summaryOf = (route) => `${plural(Math.max(0, route.length - 1), 'leg')}, ${tools.distanceText(lengthOf(route))}`;
const speedLabel = () => `${Number.isInteger(cruise) ? cruise.toFixed(1) : cruise} kn`;

// ---------------------------------------------------------------- on the chart

function draw() {
  const coordinates = points.map((p) => [p.lng, p.lat]);
  map?.getSource('sb-route')?.setData({
    type: 'FeatureCollection',
    features: [
      ...(coordinates.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : []),
      ...coordinates.map((c, i) => ({ type: 'Feature', properties: { n: String(i + 1) }, geometry: { type: 'Point', coordinates: c } }))
    ]
  });
}

/** The route's line and points are part of the chart's style: put back after each change of basemap. */
export function installLayers() {
  if (!map || !map.getLayer(TOP)) return;
  for (const id of ['sb-route-casing', 'sb-route-line', 'sb-route-point']) if (map.getLayer(id)) map.removeLayer(id);
  if (!map.getSource('sb-route')) map.addSource('sb-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const line = { type: 'line', source: 'sb-route', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round' } };
  // A teal dashed line on a dark one, with a teal dot at each point: as the Android app draws a route.
  map.addLayer({ ...line, id: 'sb-route-casing', paint: { 'line-color': '#111418', 'line-width': 6 } });
  map.addLayer({ ...line, id: 'sb-route-line', paint: { 'line-color': '#19C6B3', 'line-width': 3.5, 'line-dasharray': [2.2, 1.4] } });
  map.addLayer({ id: 'sb-route-point', type: 'circle', source: 'sb-route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#19C6B3', 'circle-stroke-color': '#F4F6F8', 'circle-stroke-width': 2 } });
  draw();
}

function changed() {
  draw();
  setting.set('routeDraft', points).catch(() => {});
  showCard();
}

async function setCruise(value) {
  if (!(value >= 1 && value <= 80)) return;
  cruise = value;
  await setting.set('cruiseKnots', cruise);
  showCard();
}

function showCard() {
  if (tools.mode() !== 'route') {
    tools.hideCard('route');
    return;
  }
  const total = lengthOf(points);
  const name = shownName || 'Unsaved route';
  const lines = !points.length ? ['Tap the map to add a point at the centre crosshair']
    : points.length === 1 ? [`${name} — 1 point, add another`]
      : [`${name} — ${summaryOf(points)}`, `${timeText(total)} at ${speedLabel()} (cruise) · ETA ${arrival(total)}`, `1st leg ${tools.bearingText(legsOf(points)[0].bearing)}`];
  const speed = el('input', { type: 'number', id: 'route-speed', min: 1, max: 80, step: 1, value: cruise, inputMode: 'decimal', 'aria-label': 'Cruise speed, knots' });
  speed.addEventListener('change', () => setCruise(Number(speed.value)));
  const share = mini('', exportCurrent, { id: 'route-export', cls: 'icon', title: 'Export this route as GPX' });
  share.append(svg(EXPORT_ICON));
  tools.showCard({
    id: 'route', label: 'ROUTE', lines,
    head: [
      mini('Undo', () => { points.pop(); changed(); }, { accent: true, id: 'route-undo' }),
      mini('Clear', () => { points = []; shownName = null; changed(); }, { id: 'route-clear' }),
      share
    ],
    actions: [
      mini('Save', save, { accent: true, id: 'route-save' }),
      mini('Routes', openLibrary, { accent: true, id: 'route-library' }),
      mini('Legs', openLegs, { accent: true, id: 'route-legs' }),
      mini('Reverse', () => { points.reverse(); changed(); }, { accent: true, id: 'route-reverse' })
    ],
    extra: el('div', { class: 'toolcard-extra' }, el('span', { text: 'CRUISE SPEED' }), speed, el('span', { text: 'KN' }))
  });
  $('#route-undo').disabled = !points.length;
  $('#route-clear').disabled = !points.length;
  for (const id of ['route-legs', 'route-save', 'route-reverse', 'route-export']) $(`#${id}`).disabled = points.length < 2;
}

function addPoint(point) {
  const last = points[points.length - 1];
  // A second tap without moving the chart would add a leg of no length.
  if (last && tools.distanceM(last, point) < 1) {
    toast('Move the chart to put the crosshair on the next point');
    return;
  }
  points.push(point);
  changed();
}

// ---------------------------------------------------------------- the legs

/**
 * The least depth along a leg, from the depth layers shown. Answers { known, height } where
 * height is the highest seabed met (negative under water, positive where the leg crosses land
 * or drying ground) and known is how many of the places looked at had a depth.
 */
export async function leastDepth(from, to) {
  const steps = Math.max(8, Math.min(SAMPLES, Math.ceil(tools.distanceM(from, to) / 100)));
  let height = -Infinity;
  let known = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const value = await charts.surveyDepthAt(from.lng + (to.lng - from.lng) * t, from.lat + (to.lat - from.lat) * t);
    if (value === null) continue;
    known++;
    height = Math.max(height, value);
  }
  return { known, of: steps + 1, height: known ? height : null };
}

function depthLine(found) {
  if (!found.known) return 'No depths on the device for this leg';
  const part = found.known < found.of ? ' (where there are depths)' : '';
  return found.height > 0 ? `Crosses land or drying ground${part}` : `Least depth ${units.depthText(found.height)}${part}`;
}

function openLegs() {
  openSheet('Route legs', (body) => {
    const legs = legsOf(points);
    let run = 0;
    add(body,
      note(`Departing now at ${speedLabel()}. Depths are from the depth layers shown, with no tide.`),
      legs.map((leg, i) => {
        run += leg.metres;
        const depth = el('span', { class: 'row-detail leg-depth', text: 'Reading the depths…' });
        leastDepth(leg.from, leg.to).then((found) => { depth.textContent = depthLine(found); }, () => { depth.textContent = ''; });
        return el('div', { class: 'row leg', id: `leg-${i + 1}` },
          el('span', { class: 'row-text' },
            el('span', { class: 'row-title', text: `Leg ${i + 1} → ${leg.to.name || `Point ${i + 2}`}` }),
            el('span', { class: 'row-detail', text: `${tools.bearingText(leg.bearing)}   ${tools.distanceText(leg.metres)}   ${timeText(leg.metres)}   arrive ${arrival(run)}` }),
            el('span', { class: 'row-detail', text: `Total ${tools.distanceText(run)}` }),
            depth));
      }),
      heading('TOTAL'),
      el('div', { class: 'row leg', id: 'legs-total' },
        el('span', { class: 'row-text' },
          el('span', { class: 'row-title', text: `${summaryOf(points)}, ${timeText(run)}` }),
          el('span', { class: 'row-detail', text: `Arrive ${arrival(run)}` }))),
      note('A straight line between the points, read against the depth layers shown on the chart. Not a safe-passage check: not for navigation.'));
  });
}

// ---------------------------------------------------------------- kept routes

const persist = () => setting.set('routes', saved);

async function save() {
  const name = el('input', { type: 'text', id: 'route-name', value: shownName || `Route ${saved.length + 1}`, maxLength: 60, autocomplete: 'off' });
  const answer = await card({
    title: 'Save this route', body: [field('Name', name)], dismissable: true,
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Save', primary: true, domId: 'route-save-yes' }]
  });
  if (answer !== 'yes') return;
  shownName = name.value.trim() || `Route ${saved.length + 1}`;
  saved.push({ id: newId(), name: shownName, points: points.map((p) => ({ ...p })), created: Date.now() });
  await persist();
  showCard();
  toast('The route is saved. Find it under Routes.');
}

function show(route, { reverse = false } = {}) {
  points = route.points.map((p) => ({ ...p }));
  if (reverse) points.reverse();
  shownName = route.name;
  if (tools.mode() !== 'route') tools.toggle('route');
  changed();
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 70, maxZoom: 14, animate: false });
}

function gpxOf(route) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = route.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'route';
  return new File([buildGpx([], [route])], `seabathy-${safe}-${stamp}.gpx`, { type: 'application/gpx+xml' });
}

/** The route on the chart now, as a GPX file. */
function exportCurrent() {
  const route = { name: shownName || 'Route', points };
  return saveFile(gpxOf(route), { title: route.name, done: `Saved ${route.name} as a GPX file` });
}

function openSaved(route) {
  openSheet(route.name, (body) => {
    const here = topSheet();
    const name = el('input', { type: 'text', id: 'route-rename', value: route.name, maxLength: 60, autocomplete: 'off' });
    name.addEventListener('change', async () => {
      route.name = name.value.trim() || route.name;
      here.title = route.name;
      await persist();
      refreshSheet();
    });
    add(body,
      note(`${plural(route.points.length, 'point')}, ${summaryOf(route.points)}`),
      row('Load on the chart', 'To look at it, change it or see its legs', () => { closeSheet(); show(route); }, { id: 'route-show' }),
      row('Load it reversed', 'The same points, last to first', () => { closeSheet(); show(route, { reverse: true }); }),
      field('Name', name),
      row('Export as GPX', 'For a plotter, the Android app or another program', () => saveFile(gpxOf(route), { title: route.name, done: `Saved ${route.name} as a GPX file` }), { id: 'route-gpx' }),
      row('Delete this route', null, async () => {
        if (!(await confirmCard('Delete this route?', `"${route.name}" will be removed.`, 'Delete', { danger: true }))) return;
        saved.splice(saved.indexOf(route), 1);
        await persist();
        backFrom(here);
      }, { danger: true, id: 'route-delete' }));
  });
}

export function openLibrary() {
  openSheet('Saved routes', (body) => {
    add(body,
      saved.length
        ? [...saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((route) => row(route.name, summaryOf(route.points), () => openSaved(route)))
        : note('No saved routes yet. Plan one on the chart and save it, or import a GPX file.'),
      note('Routes also come in with a GPX file: Settings, Waypoints and backup, Import GPX.'));
  });
}

/** Adds routes read from a file (a GPX file or a backup), leaving out any already here. Answers how many were added. */
export async function addAll(routes) {
  let added = 0;
  for (const route of routes) {
    const usable = (route.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (usable.length < 2) continue;
    const same = saved.some((s) => s.name === route.name && s.points.length === usable.length
      && s.points.every((p, i) => Math.abs(p.lat - usable[i].lat) < 1e-6 && Math.abs(p.lng - usable[i].lng) < 1e-6));
    if (same) continue;
    saved.push({ id: newId(), name: (route.name || `Route ${saved.length + 1}`).slice(0, 60), points: usable.map((p) => ({ lat: p.lat, lng: p.lng, ...(p.name ? { name: p.name } : {}) })), created: Date.now() });
    added++;
  }
  if (added) await persist();
  return added;
}

export async function start(theMap) {
  map = theMap;
  saved = await setting.get('routes', []);
  points = await setting.get('routeDraft', []);
  cruise = await setting.get('cruiseKnots', 20);
  tools.register('route', {
    button: '#btn-route',
    // The card itself says what a tap does.
    hint: '',
    on: showCard,
    off: () => tools.hideCard('route'),
    tap: () => {
      const centre = map.getCenter().wrap();
      addPoint({ lat: centre.lat, lng: centre.lng });
    }
  });
  $('#btn-route').addEventListener('click', () => tools.toggle('route'));
  // A waypoint tapped while planning becomes the next point.
  waypoints.setTapHook((waypoint) => {
    if (tools.mode() !== 'route') return false;
    addPoint({ lat: waypoint.lat, lng: waypoint.lng, name: waypoint.name });
    return true;
  });
  waypoints.setRouteImporter(addAll);
}
