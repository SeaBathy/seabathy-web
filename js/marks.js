// Buoys, beacons, lights, pipelines, submarine cables and mooring areas round Australia, from
// free government data and OpenStreetMap: the Android app's beta layer, with its own data
// (assets/navmarks) and drawn the same way. Off at every start, and each time it is switched on
// the person is told it is not for navigation: positions can be old or wrong and many marks are
// missing.

import { TOP } from './basemap.js';
import { copyOf, letGo } from './datafile.js';
import { card, toast } from './ui.js';

export const CREDIT = 'Nav marks: Transport for NSW, WA DoT, Vic Gov, Qld Gov, AMSA, NOPTA, Geoscience Australia, ACMA, © OpenStreetMap';
const NOT_FOR_NAVIGATION = 'Positions may be old or wrong, and many marks are missing.';
const LAYERS = ['sb-over-marks-area-fill', 'sb-over-marks-area-line', 'sb-over-marks-pipelines', 'sb-over-marks-cables', 'sb-over-marks'];
const SOURCES = ['sb-navlines', 'sb-navmarks'];
const TAP_PX = 24;
const KINDS = { pipeline: 'Pipeline', cable: 'Submarine cable', area_anchorage: 'Anchorage', area_mooring: 'Mooring area', area_marina: 'Marina', area_channel: 'Shipping channel' };

// ---------------------------------------------------------------- the icons
//
// Drawn the way the marks look from the boat in IALA region A: beacons as a pile with their
// topmark, buoys as a floating shape (can for port, cone for starboard, pillar for the rest),
// lights as a post with a lamp. Keys are "category|structure".

const KEYS = [
  'card_e|beacon', 'card_e|buoy', 'card_n|beacon', 'card_n|buoy', 'card_s|beacon', 'card_s|buoy', 'card_w|beacon', 'card_w|buoy',
  'isolated|beacon', 'isolated|buoy', 'isolated|virtual', 'lead|beacon', 'lead|light', 'lighthouse|light', 'light|light',
  'mooring|beacon', 'mooring|buoy', 'other|beacon', 'other|buoy', 'other|other', 'other|virtual', 'port|beacon', 'port|buoy',
  'port|virtual', 'safe|beacon', 'safe|buoy', 'special|beacon', 'special|buoy', 'special|virtual', 'stbd|beacon', 'stbd|buoy',
  'stbd|virtual', 'wreck|other', 'pref_port|beacon', 'pref_port|buoy', 'pref_stbd|beacon', 'pref_stbd|buoy'
];
const S = 2;
const RED = '#E3262F', GREEN = '#17A34A', YEL = '#F5C518', BLK = '#111111', GREY = '#94A3B8', ORANGE = '#F97316', MAG = '#D6249F', WATER = '#38BDF8';
const BODY = {
  port: [RED], stbd: [GREEN], pref_port: [RED, GREEN, RED], pref_stbd: [GREEN, RED, GREEN], card_n: [BLK, YEL], card_s: [YEL, BLK],
  card_e: [BLK, YEL, BLK], card_w: [YEL, BLK, YEL], isolated: [BLK, RED, BLK], safe: [RED, '#FFFFFF', RED], special: [YEL], lead: [ORANGE], mooring: ['#F8FAFC']
};
const TOPMARKED = new Set(['port', 'stbd', 'pref_port', 'pref_stbd', 'card_n', 'card_e', 'card_s', 'card_w', 'isolated', 'safe', 'special']);

function pen(c) {
  const outline = () => {
    c.strokeStyle = BLK;
    c.lineWidth = 1;
    c.lineJoin = 'round';
    c.stroke();
  };
  const tri = (x, y, s, up, colour) => {
    c.beginPath();
    if (up) { c.moveTo(x, y - s); c.lineTo(x + s, y + s * 0.7); c.lineTo(x - s, y + s * 0.7); }
    else { c.moveTo(x, y + s); c.lineTo(x + s, y - s * 0.7); c.lineTo(x - s, y - s * 0.7); }
    c.closePath();
    c.fillStyle = colour;
    c.fill();
    outline();
  };
  const ball = (x, y, r, colour) => {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = colour;
    c.fill();
    outline();
  };
  const box = (left, top, right, bottom, colour, edged = true) => {
    c.beginPath();
    c.rect(left, top, right - left, bottom - top);
    c.fillStyle = colour;
    c.fill();
    if (edged) outline();
  };
  const bands = (left, top, right, bottom, colours) => {
    const h = (bottom - top) / colours.length;
    colours.forEach((colour, i) => {
      c.fillStyle = colour;
      c.fillRect(left, top + i * h, right - left, h + 0.5);
    });
  };
  const topmark = (cat, x, y) => {
    if (cat === 'card_n') { tri(x, y - 7, 4, true, BLK); tri(x, y + 1, 4, true, BLK); }
    else if (cat === 'card_s') { tri(x, y - 7, 4, false, BLK); tri(x, y + 1, 4, false, BLK); }
    else if (cat === 'card_e') { tri(x, y - 8, 4, true, BLK); tri(x, y + 2, 4, false, BLK); }
    else if (cat === 'card_w') { tri(x, y - 6, 4, false, BLK); tri(x, y + 1, 4, true, BLK); }
    else if (cat === 'isolated') { ball(x, y - 7, 3.2, BLK); ball(x, y, 3.2, BLK); }
    else if (cat === 'safe') ball(x, y - 3, 4, RED);
    else if (cat === 'special') {
      c.strokeStyle = YEL;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(x - 4, y - 7); c.lineTo(x + 4, y + 1);
      c.moveTo(x + 4, y - 7); c.lineTo(x - 4, y + 1);
      c.stroke();
    } else if (cat === 'port' || cat === 'pref_port') box(x - 4.5, y - 8, x + 4.5, y + 1, RED);
    else if (cat === 'stbd' || cat === 'pref_stbd') tri(x, y - 3, 5.5, true, GREEN);
  };
  return { outline, tri, ball, box, bands, topmark };
}

function icon(key) {
  const [cat, struct = 'other'] = key.split('|');
  const canvas = document.createElement('canvas');
  canvas.width = 34 * S;
  canvas.height = 40 * S;
  const c = canvas.getContext('2d');
  c.scale(S, S);
  const { outline, tri, ball, box, bands, topmark } = pen(c);
  const x = 17;
  const base = 34;
  if (cat === 'wreck') {
    c.strokeStyle = BLK;
    c.lineWidth = 2;
    c.beginPath();
    for (const [x0, y0, x1, y1] of [[6, 22, 28, 22], [12, 15, 12, 29], [17, 13, 17, 31], [22, 15, 22, 29]]) { c.moveTo(x0, y0); c.lineTo(x1, y1); }
    c.stroke();
  } else if (struct === 'light') {
    if (cat === 'lighthouse') {
      c.beginPath();
      c.moveTo(x - 4, base); c.lineTo(x - 2.5, 18); c.lineTo(x + 2.5, 18); c.lineTo(x + 4, base);
      c.closePath();
      c.fillStyle = '#FFFFFF';
      c.fill();
      outline();
      box(x - 3.5, 15, x + 3.5, 19, RED);
    } else {
      box(x - 1.5, 20, x + 1.5, base, '#334155');
      ball(x, 19, 3.2, cat === 'lead' ? ORANGE : '#FDE047');
      box(x - 5, base - 1, x + 5, base + 1, BLK, false);
    }
  } else if (struct === 'virtual') {
    c.strokeStyle = MAG;
    c.lineWidth = 2;
    c.setLineDash([3, 2]);
    c.beginPath();
    c.arc(x, 22, 9, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    topmark(cat, x, 25);
  } else if (struct === 'beacon') {
    bands(x - 2, 15, x + 2, base, BODY[cat] || [GREY]);
    c.beginPath();
    c.rect(x - 2, 15, 4, base - 15);
    outline();
    if (TOPMARKED.has(cat)) topmark(cat, x, 12);
    else if (cat === 'lead') tri(x, 9, 5, true, ORANGE);
    else ball(x, 11, 3, GREY);
    box(x - 6, base - 1, x + 6, base + 1, BLK, false);
  } else if (struct === 'buoy') {
    const shape = () => {
      c.beginPath();
      if (cat === 'port') c.rect(x - 7, base - 15, 14, 13);
      else if (cat === 'stbd') { c.moveTo(x - 8, base - 2); c.lineTo(x, base - 18); c.lineTo(x + 8, base - 2); c.closePath(); }
      else if (cat === 'mooring' || cat === 'other') c.arc(x, base - 8, 7, 0, Math.PI * 2);
      else { c.moveTo(x - 8, base - 2); c.lineTo(x - 3, base - 20); c.lineTo(x + 3, base - 20); c.lineTo(x + 8, base - 2); c.closePath(); }
    };
    c.save();
    shape();
    c.clip();
    bands(x - 9, base - 21, x + 9, base - 1, BODY[cat] || [GREY]);
    c.restore();
    shape();
    outline();
    if (!['port', 'stbd', 'mooring', 'other'].includes(cat)) topmark(cat, x, base - 24);
    c.strokeStyle = WATER;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x - 11, base);
    c.quadraticCurveTo(x - 5, base - 2, x, base);
    c.quadraticCurveTo(x + 5, base + 2, x + 11, base);
    c.stroke();
  } else {
    ball(x, 22, 5, GREY);
  }
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

/** A short red wave, repeated along submarine cables. */
function cableWave() {
  const w = 16;
  const h = 7;
  const canvas = document.createElement('canvas');
  canvas.width = w * S;
  canvas.height = h * S;
  const c = canvas.getContext('2d');
  c.scale(S, S);
  c.strokeStyle = '#DC2626';
  c.lineWidth = 1.4;
  c.beginPath();
  for (let i = 0; i <= w; i++) {
    const y = h / 2 + Math.sin((i / w) * Math.PI * 2) * 2.2;
    if (i === 0) c.moveTo(0, y);
    else c.lineTo(i, y);
  }
  c.stroke();
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------- the layer

let map = null;
let changed = () => {};
let on = false;
let drawing = 0;

export const visible = () => on;
export const credits = () => (on ? [CREDIT] : []);

/** Draws the layer when it is on: at start, after each change of basemap, and when it is switched. */
export async function install() {
  if (!map || !map.getLayer(TOP)) return;
  const mine = ++drawing;
  let data = null;
  if (on) {
    try {
      data = { lines: await copyOf('navlines'), marks: await copyOf('navmarks') };
    } catch {
      if (mine === drawing) toast("The buoys and beacons couldn't be fetched. They need the internet the first time they are switched on.", 6000);
    }
  } else {
    letGo('navlines');
    letGo('navmarks');
  }
  if (mine !== drawing || !map.getLayer(TOP)) return;
  for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id);
  if (!data) return;
  for (const key of KEYS) if (!map.hasImage(`sb-mark-${key}`)) map.addImage(`sb-mark-${key}`, icon(key), { pixelRatio: 2 });
  if (!map.hasImage('sb-cable')) map.addImage('sb-cable', cableWave(), { pixelRatio: 2 });
  map.addSource('sb-navlines', { type: 'geojson', data: data.lines });
  map.addSource('sb-navmarks', { type: 'geojson', data: data.marks });
  const kind = ['get', 'kind'];
  const areas = ['in', kind, ['literal', ['area_anchorage', 'area_mooring', 'area_marina', 'area_channel']]];
  const areaColour = ['match', kind, 'area_channel', '#64748B', 'area_mooring', '#0EA5E9', 'area_marina', '#0EA5E9', '#7C3AED'];
  map.addLayer({ id: 'sb-over-marks-area-fill', type: 'fill', source: 'sb-navlines', filter: areas, paint: { 'fill-color': areaColour, 'fill-opacity': 0.12 } }, TOP);
  map.addLayer({ id: 'sb-over-marks-area-line', type: 'line', source: 'sb-navlines', filter: areas, paint: { 'line-color': areaColour, 'line-width': 1.5, 'line-dasharray': [3, 2] } }, TOP);
  map.addLayer({
    id: 'sb-over-marks-pipelines', type: 'line', source: 'sb-navlines', filter: ['==', kind, 'pipeline'], layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 3], 'line-dasharray': [0.1, 2] }
  }, TOP);
  map.addLayer({ id: 'sb-over-marks-cables', type: 'line', source: 'sb-navlines', filter: ['==', kind, 'cable'], paint: { 'line-pattern': 'sb-cable', 'line-width': 7 } }, TOP);
  map.addLayer({
    id: 'sb-over-marks', type: 'symbol', source: 'sb-navmarks',
    layout: {
      'icon-image': ['concat', 'sb-mark-', ['get', 'icon']], 'icon-anchor': 'bottom', 'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 0.8, 14, 1.15, 17, 1.5]
    }
  }, TOP);
}

/** What was tapped: a mark, a pipeline or cable, or an area; null if none. */
export function describeAt(point) {
  if (!on || !map.getLayer('sb-over-marks')) return null;
  const box = [[point.x - TAP_PX, point.y - TAP_PX], [point.x + TAP_PX, point.y + TAP_PX]];
  const feature = map.queryRenderedFeatures(box, { layers: ['sb-over-marks'] })[0]
    || map.queryRenderedFeatures(box, { layers: ['sb-over-marks-pipelines', 'sb-over-marks-cables'] })[0]
    || map.queryRenderedFeatures([point.x, point.y], { layers: ['sb-over-marks-area-fill'] })[0];
  if (!feature) return null;
  const text = (key) => {
    const value = feature.properties[key];
    return value && value !== 'null' ? String(value) : null;
  };
  return {
    badge: 'Beta layer', title: text('label') || KINDS[text('kind')] || 'Mark',
    paragraphs: [text('name'), text('src') ? `Source: ${text('src')}` : null].filter(Boolean),
    fine: `${NOT_FOR_NAVIGATION} Not for navigation. ${CREDIT}`
  };
}

/** Switches the layer on (after the warning, every time) or off. Answers whether it is now on. */
export async function setVisible(value) {
  if (value && !on) {
    const answer = await card({
      badge: 'Beta layer', title: 'Buoys and beacons are not for navigation',
      paragraphs: [NOT_FOR_NAVIGATION, 'They come from free government data and OpenStreetMap, for Australian waters. Use official charts and what you can see from the boat.'], dismissable: true,
      actions: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'I understand', primary: true, domId: 'marks-ack' }]
    });
    if (answer !== 'yes') return on;
  }
  on = Boolean(value);
  await install();
  changed();
  return on;
}

export function start(theMap, { onChange = () => {} } = {}) {
  map = theMap;
  changed = onChange;
}
