// Marine park zones, reef and island names, and boat ramps round Australia: the Android app's
// own data (its assets/zones), drawn the same way. Each is off until switched on. Its file is
// fetched from the app's own address the first time it is switched on, and the service worker
// then keeps it for use with no signal. The page fetches it and hands the map a local copy:
// what the map's own worker fetches is not kept by the service worker in Safari. Zones are a
// guide only: the official zoning maps are the law.
//
// Zone properties: "n" park, "z" official zone name, "s" waters, "src" authority, and the class
// "c": "nt" no-take, "lim" limited fishing, "gen" fishing under the usual rules.

import { setting } from './db.js';
import * as gps from './gps.js';
import { TOP, labelFont } from './basemap.js';
import { isPicking } from './areapicker.js';
import { add, card, el, heading, note, openSheet, refreshSheet, row, toast, toggle } from './ui.js';

export const ZONES_CREDIT = 'Marine park zones: DCCEEW, GBRMPA, Queensland Government, NSW DPI, SA DEW, WA DPIRD, CAPAD 2024 (CC BY)';
export const NAMES_CREDIT = 'Names: Geoscience Australia gazetteer, GBRMPA (CC BY 4.0)';
export const RAMPS_CREDIT = 'Boat ramps: © OpenStreetMap contributors';
const NOT_OFFICIAL = 'A guide only, from government data that can lag behind changes. The official zoning map and rules for the park are the law: check them before you fish.';

const NO_TAKE = '#22C55E';
const LIMITED = '#EAB308';
const GENERAL = '#60A5FA';
const RANK = { nt: 3, lim: 2, gen: 1 };
const AUTHORITIES = {
  DCCEEW: 'Australian Marine Parks (DCCEEW)', GBRMPA: 'Great Barrier Reef Marine Park Authority', 'Qld Gov': 'Queensland Government',
  'NSW DPI': 'NSW DPI Fisheries', 'SA DEW': 'SA Department for Environment and Water', 'WA DPIRD': 'WA DPIRD fishing orders', CAPAD: 'CAPAD 2024 (park outline)'
};
const file = (name) => new URL(`../data/${name}.geojson`, import.meta.url).href;
/** Every layer here starts "sb-over-": the satellite picture goes under the first of them. */
const LAYERS = ['sb-over-zones-fill', 'sb-over-zones-line', 'sb-over-zones-label', 'sb-over-names', 'sb-over-ramps'];
const SOURCES = ['sb-zones', 'sb-names', 'sb-ramps'];
/** A finger is less exact than a mouse: a tap this near a name or a ramp counts. */
const TAP_PX = 22;
const MODES = [['off', 'Off'], ['notake', 'No-take zones only'], ['all', 'All zones']];

/** What is switched on. [ack]: the "a guide only" notice has been accepted once. */
export const state = { mode: 'off', names: false, ramps: false, warn: true, ack: false };
let map = null;
let changed = () => {};

const save = () => setting.set('places', { ...state }).catch(() => {});

/** The credits owed for what is shown. */
export const credits = () => [state.mode !== 'off' ? ZONES_CREDIT : null, state.names ? NAMES_CREDIT : null, state.ramps ? RAMPS_CREDIT : null].filter(Boolean);

/** A boat ramp: a rounded blue square with a ramp and a hull on it. */
function rampIcon() {
  const s = 2;
  const canvas = el('canvas', { width: 22 * s, height: 22 * s });
  const c = canvas.getContext('2d');
  // Drawn corner by corner: older iPhones have no ready-made rounded rectangle.
  const box = () => {
    const [x, y, w, r] = [1 * s, 1 * s, 20 * s, 5 * s];
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + w, r);
    c.arcTo(x + w, y + w, x, y + w, r);
    c.arcTo(x, y + w, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  };
  c.fillStyle = '#0284C7';
  box();
  c.fill();
  c.strokeStyle = '#fff';
  c.lineWidth = 1.5 * s;
  box();
  c.stroke();
  c.fillStyle = '#fff';
  const shape = (points) => {
    c.beginPath();
    points.forEach(([x, y], i) => (i ? c.lineTo(x * s, y * s) : c.moveTo(x * s, y * s)));
    c.closePath();
    c.fill();
  };
  // The ramp: a slope into the water. Then the hull on it.
  shape([[4, 17], [18, 17], [18, 13]]);
  shape([[7, 9], [16, 9], [14, 12], [9, 12]]);
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

/** Each file switched on, as a local copy the map can read: fetched once, let go when switched off. */
const copies = new Map();

function copyOf(name) {
  if (!copies.has(name)) {
    copies.set(name, fetch(file(name))
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`${name}: ${response.status}`))))
      .then((blob) => URL.createObjectURL(blob))
      .catch((error) => {
        copies.delete(name);
        throw error;
      }));
  }
  return copies.get(name);
}

function letGo(name) {
  copies.get(name)?.then((url) => URL.revokeObjectURL(url), () => {});
  copies.delete(name);
}

let drawing = 0;

/** Draws what is switched on: at start, after each change of basemap, and when a switch changes. */
export async function install() {
  if (!map || !map.getLayer(TOP)) return;
  const mine = ++drawing;
  const wanted = { zones: state.mode !== 'off', places: state.names, ramps: state.ramps };
  const data = {};
  let missed = false;
  await Promise.all(Object.entries(wanted).map(async ([name, on]) => {
    if (!on) {
      // The no-take warning reads the zones from the same copy while they are shown.
      letGo(name);
      return;
    }
    try {
      data[name] = await copyOf(name);
    } catch {
      missed = true;
    }
  }));
  // Something newer was asked for while the files were coming.
  if (mine !== drawing || !map.getLayer(TOP)) return;
  if (missed) toast("That couldn't be fetched. It needs the internet the first time it is switched on.", 6000);
  for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id);
  const font = labelFont();
  const c = ['get', 'c'];
  const halo = { 'text-halo-color': '#0B1622' };
  if (data.zones) {
    const only = state.mode === 'notake' ? { filter: ['==', c, 'nt'] } : {};
    const colour = ['match', c, 'nt', NO_TAKE, 'lim', LIMITED, GENERAL];
    map.addSource('sb-zones', { type: 'geojson', data: data.zones });
    map.addLayer({ id: 'sb-over-zones-fill', type: 'fill', source: 'sb-zones', ...only, paint: { 'fill-color': colour, 'fill-opacity': ['match', c, 'nt', 0.3, 'lim', 0.14, 0.07] } }, TOP);
    map.addLayer({
      id: 'sb-over-zones-line', type: 'line', source: 'sb-zones', ...only,
      paint: { 'line-color': colour, 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['match', c, 'nt', 1.2, 0.6], 12, ['match', c, 'nt', 2.6, 1.2]] }
    }, TOP);
    map.addLayer({
      id: 'sb-over-zones-label', type: 'symbol', source: 'sb-zones', minzoom: 8, ...only,
      layout: {
        'text-field': ['case', ['==', c, 'nt'], ['concat', 'NO TAKE\n', ['get', 'n']], ['==', c, 'lim'], ['concat', 'Limited fishing\n', ['get', 'n']], ['get', 'n']],
        'text-font': font, 'text-size': ['match', c, 'nt', 11, 10], 'symbol-placement': 'point'
      },
      paint: { 'text-color': ['match', c, 'nt', '#BBF7D0', 'lim', '#FEF08A', '#BFDBFE'], ...halo, 'text-halo-width': 1.4 }
    }, TOP);
  }
  if (data.places) {
    const k = ['get', 'k'];
    map.addSource('sb-names', { type: 'geojson', data: data.places });
    map.addLayer({
      id: 'sb-over-names', type: 'symbol', source: 'sb-names', minzoom: 7,
      // Numbered reefs ("Reef 19-131") only close in, so the names stay readable further out.
      filter: ['any', ['!', ['has', 'id']], ['>=', ['zoom'], 10]],
      layout: {
        'text-field': ['get', 'n'], 'text-font': font, 'text-padding': 4,
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9.5, 13, 12.5],
        'symbol-sort-key': ['match', k, 'island', 0, 'reef', 1, 2]
      },
      paint: { 'text-color': ['case', ['in', k, ['literal', ['reef', 'shoal', 'bank', 'seamount']]], '#7DD3FC', '#F1F5F9'], ...halo, 'text-halo-width': 1.3 }
    }, TOP);
  }
  if (data.ramps) {
    if (!map.hasImage('sb-ramp')) map.addImage('sb-ramp', rampIcon(), { pixelRatio: 2 });
    map.addSource('sb-ramps', { type: 'geojson', data: data.ramps });
    map.addLayer({
      id: 'sb-over-ramps', type: 'symbol', source: 'sb-ramps', minzoom: 8,
      layout: {
        'icon-image': 'sb-ramp', 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 14, 1], 'icon-allow-overlap': true,
        'text-field': ['get', 'n'], 'text-font': font, 'text-size': 10.5, 'text-anchor': 'top', 'text-offset': [0, 1.1], 'text-optional': true
      },
      paint: { 'text-color': '#BAE6FD', ...halo, 'text-halo-width': 1.2 }
    }, TOP);
  }
}

function apply() {
  save();
  install();
  changed();
  if (state.mode === 'off') {
    inNoTake = null;
    // The shapes kept for the warning go with the zones.
    noTake = null;
    noTakeLoading = null;
  }
}

// ---------------------------------------------------------------- what was tapped

function zoneInfo(p) {
  const zone = p.z || '';
  const restricted = /restricted access|preservation/i.test(zone);
  const [badge, colour, fishing] = p.c === 'nt' ? ['No-take zone', NO_TAKE, `No fishing or collecting of any kind.${restricted ? ' Entry is also restricted.' : ''}`]
    : p.c === 'lim' ? ['Limited fishing', LIMITED, "Some fishing is allowed, with limits on gear, methods or species. Check this zone's rules."]
      : ['General use', GENERAL, 'Fishing is allowed under the usual rules for the park.'];
  const waters = p.s === 'COM' ? 'Commonwealth' : p.s;
  return {
    badge, colour, title: p.n || badge, subtitle: [zone, waters].filter(Boolean).join(' · '),
    paragraphs: [`Fishing: ${fishing}`, p.src ? `Zoning from: ${AUTHORITIES[p.src] || p.src}` : null].filter(Boolean),
    fine: `${NOT_OFFICIAL} ${ZONES_CREDIT}`
  };
}

/** What is under a tap: a ramp, the strictest zone, or a name; null if none of them. */
function describeAt(point) {
  const box = [[point.x - TAP_PX, point.y - TAP_PX], [point.x + TAP_PX, point.y + TAP_PX]];
  const found = (where, layer) => (map.getLayer(layer) ? map.queryRenderedFeatures(where, { layers: [layer] }) : []);
  const ramp = found(box, 'sb-over-ramps')[0];
  if (ramp) {
    return {
      badge: 'Boat ramp', colour: '#38BDF8', title: ramp.properties.n || 'Boat ramp', paragraphs: ramp.properties.fee ? ['There is a fee.'] : [],
      fine: `From OpenStreetMap: check it's open and suits your boat. ${RAMPS_CREDIT}`
    };
  }
  const zones = found([point.x, point.y], 'sb-over-zones-fill');
  if (zones.length) return zoneInfo(zones.reduce((a, b) => ((RANK[b.properties.c] || 0) > (RANK[a.properties.c] || 0) ? b : a)).properties);
  const name = found(box, 'sb-over-names')[0];
  if (name) {
    const kind = name.properties.k ? name.properties.k[0].toUpperCase() + name.properties.k.slice(1) : 'Place';
    return { badge: kind, colour: '#7DD3FC', title: name.properties.n || kind, paragraphs: [], fine: NAMES_CREDIT };
  }
  return null;
}

function showInfo(info) {
  return card({
    title: info.title, subtitle: info.subtitle || null, paragraphs: info.paragraphs, fine: info.fine, dismissable: true,
    body: null, badge: info.badge, actions: [{ id: 'ok', label: 'Close', primary: true, domId: 'place-close' }]
  });
}

// ---------------------------------------------------------------- the no-take warning

/** The no-take zones as plain shapes, read once when the warning first needs them. */
let noTake = null;
let noTakeLoading = null;
/** The no-take zone the boat was last in, so the warning comes once on the way in. */
let inNoTake = null;

function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outline and in none of its holes. */
const insidePolygon = (rings, x, y) => rings.length > 0 && insideRing(rings[0], x, y) && !rings.slice(1).some((hole) => insideRing(hole, x, y));

function loadNoTake() {
  if (!noTakeLoading) {
    noTakeLoading = copyOf('zones').then((url) => fetch(url)).then((r) => r.json()).then((data) => {
      const zones = [];
      for (const feature of data.features) {
        if (feature.properties.c !== 'nt' || !feature.geometry) continue;
        const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
        let west = 180, south = 90, east = -180, north = -90;
        for (const polygon of polygons) {
          for (const [x, y] of polygon[0] || []) {
            west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y);
          }
        }
        zones.push({ name: feature.properties.n || '', type: feature.properties.z || '', west, south, east, north, polygons });
      }
      noTake = zones;
      return zones;
    }).catch((error) => {
      noTakeLoading = null;
      throw error;
    });
  }
  return noTakeLoading;
}

/** The no-take zone holding a position, or null. Loads the zones if they aren't in yet. */
export async function noTakeAt(lat, lng) {
  const zones = noTake || await loadNoTake();
  return zones.find((z) => lat >= z.south && lat <= z.north && lng >= z.west && lng <= z.east && z.polygons.some((rings) => insidePolygon(rings, lng, lat))) || null;
}

/** The boat is at [position]: warns once on the way into a no-take zone, and says when it has left. */
export async function boatAt(position) {
  if (!state.warn || state.mode === 'off') return;
  const zone = await noTakeAt(position.coords.latitude, position.coords.longitude).catch(() => null);
  if (!state.warn || state.mode === 'off') return;
  // "Ningaloo Marine Park · Bundegi Sanctuary Area": the park, and the zone when it has its own name.
  const name = zone ? [...new Set([zone.name, zone.type].filter(Boolean))].join(' · ') : null;
  if (name === inNoTake) return;
  const was = inNoTake;
  inNoTake = name;
  if (!name) {
    toast(`You've left the no-take zone (${was})`, 7000);
    return;
  }
  try {
    navigator.vibrate?.([250, 120, 250, 120, 250]);
  } catch { /* a phone that doesn't buzz still shows the card */ }
  const answer = await card({
    badge: 'No-take zone', title: "You're in a no-take zone", subtitle: name, paragraphs: ['No fishing or collecting here.'], fine: NOT_OFFICIAL, dismissable: true,
    actions: [{ id: 'stop', label: 'Stop warnings', domId: 'notake-stop' }, { id: 'ok', label: 'OK', primary: true, domId: 'notake-ok' }]
  });
  if (answer === 'stop') {
    state.warn = false;
    save();
  }
}

// ---------------------------------------------------------------- the panel

async function setMode(mode) {
  if (mode !== 'off' && !state.ack) {
    const answer = await card({
      badge: 'Marine park zones', title: 'A guide only', paragraphs: [NOT_OFFICIAL, 'The zones are for Australian waters, drawn from each park authority\'s own zoning.'], dismissable: true,
      actions: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'I understand', primary: true, domId: 'places-ack' }]
    });
    if (answer !== 'yes') return;
    state.ack = true;
  }
  state.mode = mode;
  apply();
}

const summary = () => {
  const on = [state.mode === 'notake' ? 'no-take zones' : state.mode === 'all' ? 'zones' : null, state.names ? 'names' : null, state.ramps ? 'ramps' : null].filter(Boolean);
  return on.length ? `On: ${on.join(', ')}` : 'Zones, reef and island names, boat ramps: all off';
};

export function menuRow() {
  return row('Marine parks and places', summary(), openPanel, { id: 'menu-places' });
}

const swatch = (colour, text) => el('span', { class: 'swatch' }, el('span', { class: 'swatch-dot', style: `background:${colour}` }), text);

export function openPanel() {
  openSheet('Marine parks and places', (body) => {
    add(body,
      note('Round Australia. Tap a zone, a name or a ramp on the chart to see what it is.'),
      heading('MARINE PARK ZONES'),
      MODES.map(([mode, label]) => row(label, null, async () => {
        await setMode(mode);
        refreshSheet();
      }, { value: state.mode === mode ? '✓' : null, id: `zones-${mode}` })),
      el('div', { class: 'swatches' }, swatch(NO_TAKE, 'No-take'), swatch(LIMITED, 'Limited fishing'), swatch(GENERAL, 'General use')),
      toggle('Warn when the boat enters a no-take zone', 'While zones are shown, the GPS is on and SeaBathy is on the screen', state.warn, (on) => {
        state.warn = on;
        if (!on) inNoTake = null;
        save();
      }, 'zones-warn'),
      note(NOT_OFFICIAL),
      heading('NAMES AND RAMPS'),
      toggle('Reef and island names', 'Reefs, islands, shoals, banks and rocks, with the numbers of unnamed reefs', state.names, (on) => {
        state.names = on;
        apply();
      }, 'places-names'),
      toggle('Boat ramps', 'From OpenStreetMap', state.ramps, (on) => {
        state.ramps = on;
        apply();
      }, 'places-ramps'),
      note('Each of these is fetched the first time it is switched on (the zones are the biggest, about 1 MB) and then kept on this device, so it works with no signal.'),
      heading('CREDITS'),
      [ZONES_CREDIT, NAMES_CREDIT, RAMPS_CREDIT].map(note));
  });
}

export async function start(theMap, { onChange = () => {} } = {}) {
  map = theMap;
  changed = onChange;
  Object.assign(state, await setting.get('places', {}));
  map.on('click', (event) => {
    if (isPicking() || document.querySelector('.overlay') || LAYERS.every((id) => !map.getLayer(id))) return;
    const info = describeAt(event.point);
    if (info) showInfo(info);
  });
  gps.subscribe((position) => { boatAt(position); });
}
