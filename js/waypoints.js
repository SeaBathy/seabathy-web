// Waypoints: marks on the chart with a name, a note, a colour and a symbol. They are saved in
// the app's database on the phone, and go in and out as GPX.

import { Marker } from '../vendor/maplibre-gl.js';
import * as db from './db.js';
import * as units from './units.js';
import { buildGpx, parseGpx } from './gpx.js';
import { add, el, svg, toast, openSheet, topSheet, backFrom, closeSheet, closeDrawer, button, mini, confirmCard, saveFile } from './ui.js';

export const COLOURS = ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6', '#A855F7'];

/** The symbols, as in the Android app; each is drawn white on the waypoint's coloured dot. */
export const ICONS = [
  { id: 'marker', label: 'Marker', path: '<circle cx="12" cy="12" r="4.5" fill="#fff"/>' },
  { id: 'diamond', label: 'Diamond', path: '<path d="M12 5l7 7-7 7-7-7z" fill="#fff"/>' },
  { id: 'flag', label: 'Flag', path: '<path d="M7 4v16M7 5h10l-2.5 3.5L17 12H7" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' },
  { id: 'anchor', label: 'Anchor', path: '<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="6" r="1.8"/><path d="M12 8v11M8.5 11h7M5.5 14c.6 3 3.2 5 6.5 5s5.9-2 6.5-5"/></g>' },
  { id: 'fish', label: 'Fishing spot', path: '<path d="M4 12c2.6-3.4 5.6-5 9-5 2.4 0 4.6 1.6 7 5-2.4 3.4-4.6 5-7 5-3.4 0-6.4-1.6-9-5zm-1-3.5L6 12l-3 3.5z" fill="#fff"/><circle cx="15.5" cy="11" r="1" fill="#000" opacity=".55"/>' },
  { id: 'wreck', label: 'Wreck', path: '<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M4 15l16-5M6 17.5c2 1.2 4 1.2 6 0s4-1.2 6 0M9 13.5V8M13 12V6.5M17 11V8.5"/></g>' },
  { id: 'mob', label: 'Man overboard', path: '<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="2.2"/><path d="M6 13l3 1.5h6L18 13M4.5 18c1.9 1.2 3.8 1.2 5.6 0 1.3-.8 2.5-.8 3.8 0 1.8 1.2 3.7 1.2 5.6 0"/></g>' }
];

const iconById = (id) => ICONS.find((i) => i.id === id) || ICONS[0];
const iconSvg = (id) => `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">${iconById(id).path}</svg>`;

const waypoints = [];
const markers = new Map();
let map = null;
let showNames = true;

export const list = () => waypoints;

const listeners = new Set();

/** Has [fn] called whenever a waypoint is added, changed or deleted. Answers with a function that stops it. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = () => { for (const fn of listeners) fn(); };

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** "Mark 3": the first number not already used. */
function nextName() {
  const used = new Set(waypoints.map((w) => w.name));
  for (let n = waypoints.length + 1; ; n++) if (!used.has(`Mark ${n}`)) return `Mark ${n}`;
}

function draw(waypoint) {
  markers.get(waypoint.id)?.remove();
  const node = el('button', { class: 'wpt', type: 'button', style: `--c:${waypoint.color}`, 'aria-label': `Waypoint ${waypoint.name}`, 'data-id': waypoint.id },
    svg(iconSvg(waypoint.icon), 'wpt-dot'),
    showNames ? el('span', { class: 'wpt-name', text: waypoint.name }) : null);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    // A tool that is on may take the tap (a route being planned adds the waypoint as its next point).
    if (tapHook?.(waypoint)) return;
    edit(waypoint);
  });
  markers.set(waypoint.id, new Marker({ element: node, anchor: 'top', offset: [0, -13] }).setLngLat([waypoint.lng, waypoint.lat]).addTo(map));
}

async function save(waypoint) {
  await db.put('waypoints', waypoint);
  if (!waypoints.includes(waypoint)) waypoints.push(waypoint);
  draw(waypoint);
  changed();
}

async function remove(waypoint) {
  await db.remove('waypoints', waypoint.id);
  waypoints.splice(waypoints.indexOf(waypoint), 1);
  markers.get(waypoint.id)?.remove();
  markers.delete(waypoint.id);
  changed();
}

export const showsNames = () => showNames;

/** Names beside the waypoints on the chart, or the dots alone. */
export async function setShowNames(on) {
  showNames = on;
  await db.setting.set('waypointNames', on);
  for (const w of waypoints) draw(w);
}

let tapHook = null;
/** Has [fn] asked first whenever a waypoint is tapped; when it answers true the tap is its own. */
export function setTapHook(fn) {
  tapHook = fn;
}

let routeImporter = null;
/** Who keeps the routes found in a GPX file: [fn] is given them and answers how many it added. */
export function setRouteImporter(fn) {
  routeImporter = fn;
}

/** A new waypoint saved with a name, symbol and colour of its own (the man overboard mark). */
export async function addMarked(lng, lat, { name, icon = 'marker', color = COLOURS[0], desc = '' }) {
  const waypoint = { id: newId(), name, lat, lng, color, desc, icon, created: Date.now() };
  await save(waypoint);
  return waypoint;
}

/** A new waypoint at a place, saved as it is: the 3D view drops them with a tap on the seabed. */
export async function addQuiet(lng, lat, desc = '') {
  const waypoint = { id: newId(), name: nextName(), lat, lng, color: COLOURS[0], desc, icon: 'marker', created: Date.now() };
  await save(waypoint);
  return waypoint;
}

// ---------------------------------------------------------------- the cards

/** The row of colours and the row of symbols, changing [draft] as they are tapped. */
function looks(draft) {
  const colours = el('div', { class: 'colour-choices' }, COLOURS.map((colour) => el('button', {
    type: 'button', class: `colour-choice${colour === draft.color ? ' on' : ''}`, style: `background:${colour}`, 'aria-label': `Colour ${colour}`,
    onclick: (event) => {
      draft.color = colour;
      for (const s of colours.children) s.classList.toggle('on', s === event.currentTarget);
    }
  })));
  const icons = el('div', { class: 'icon-choices' }, ICONS.map((icon) => {
    const choice = el('button', {
      type: 'button', class: `icon-choice${icon.id === draft.icon ? ' on' : ''}`, 'aria-label': icon.label, title: icon.label,
      onclick: () => {
        draft.icon = icon.id;
        for (const c of icons.children) c.classList.toggle('on', c === choice);
      }
    }, svg(iconSvg(icon.id)));
    return choice;
  }));
  return [colours, icons];
}

/**
 * The card for a new waypoint at a place, at the foot of the screen as in the Android app: a
 * name, a note, a colour and a symbol. Nothing is saved until Save waypoint is tapped.
 */
export function addAt(lng, lat) {
  const draft = { id: newId(), name: '', lat, lng, color: COLOURS[0], desc: '', icon: 'marker', created: Date.now() };
  openSheet('New waypoint', (body) => {
    const here = topSheet();
    const name = el('input', { type: 'text', id: 'wpt-name', class: 'plain-input', placeholder: 'Waypoint name', value: draft.name, maxLength: 60, autocomplete: 'off', oninput: () => { draft.name = name.value; } });
    const desc = el('input', { type: 'text', id: 'wpt-desc', class: 'plain-input', placeholder: 'Description / notes', value: draft.desc, maxLength: 500, autocomplete: 'off', oninput: () => { draft.desc = desc.value; } });
    add(body,
      name, desc,
      looks(draft),
      el('div', { class: 'readout', id: 'wpt-position', text: units.positionText(lat, lng) }),
      el('div', { class: 'actions' },
        button('Cancel', () => backFrom(here), { id: 'wpt-cancel' }),
        button('Save waypoint', async () => {
          await save({ ...draft, name: draft.name.trim() || nextName() });
          backFrom(here);
        }, { go: true, id: 'wpt-save' })));
  }, { dock: true });
}

/** The card for a waypoint already on the chart: change it, jump to it, or delete it. */
export function edit(waypoint) {
  const draft = { ...waypoint };
  let typing = false;
  openSheet('Waypoint', (body) => {
    const here = topSheet();
    const name = el('input', { type: 'text', id: 'wpt-name', class: 'plain-input', placeholder: 'Waypoint name', value: draft.name, maxLength: 60, autocomplete: 'off', oninput: () => { draft.name = name.value; } });
    const desc = el('input', { type: 'text', id: 'wpt-desc', class: 'plain-input', placeholder: 'Description / notes', value: draft.desc || '', maxLength: 500, autocomplete: 'off', oninput: () => { draft.desc = desc.value; } });
    const typed = el('input', { type: 'text', id: 'wpt-position-typed', class: 'plain-input', value: units.positionText(draft.lat, draft.lng), autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
    const position = typing
      ? typed
      : el('button', {
        class: 'readout', type: 'button', id: 'wpt-position', 'aria-label': 'Edit the coordinates',
        onclick: () => {
          typing = true;
          position.replaceWith(typed);
          typed.focus();
        }
      }, el('span', { class: 'readout-text', text: units.positionText(draft.lat, draft.lng) }), el('span', { class: 'readout-edit', text: 'EDIT COORDINATES' }));
    add(body,
      name,
      position,
      desc,
      looks(draft),
      el('div', { class: 'actions' },
        button('Delete', async () => {
          if (!(await confirmCard('Delete this waypoint?', `"${waypoint.name}" will be removed from this phone.`, 'Delete', { danger: true }))) return;
          await remove(waypoint);
          backFrom(here);
        }, { danger: true, id: 'wpt-delete' }),
        button('Jump', () => {
          closeSheet();
          map.easeTo({ center: [waypoint.lng, waypoint.lat], zoom: Math.max(map.getZoom(), 13) });
        }, { id: 'wpt-jump' }),
        button('Save', async () => {
          if (typing) {
            const at = units.parsePosition(typed.value);
            if (!at) {
              toast("That position doesn't read as a latitude and a longitude.");
              return;
            }
            Object.assign(draft, at);
          }
          Object.assign(waypoint, draft, { name: draft.name.trim() || nextName() });
          await save(waypoint);
          backFrom(here);
        }, { primary: true, id: 'wpt-save' })));
  }, { own: true });
}

// ---------------------------------------------------------------- in the Layers panel

let query = '';

/** The waypoints as the Layers panel lists them: a search box, then each with GO and EDIT. */
export function drawerSection() {
  const results = el('div', { id: 'wpt-list' });
  const fill = () => {
    const q = query.trim().toLowerCase();
    const shown = waypoints
      .filter((w) => !q || w.name.toLowerCase().includes(q) || (w.desc || '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    results.replaceChildren(...(shown.length
      ? shown.map((w) => el('div', { class: 'wrow', 'data-id': w.id },
        el('span', { class: 'wrow-dot', style: `--c:${w.color}` }),
        el('span', { class: 'wrow-text' },
          el('span', { class: 'wrow-name', text: w.name }),
          el('span', { class: 'wrow-pos', text: units.positionText(w.lat, w.lng) })),
        mini('Go', () => {
          closeDrawer();
          map.jumpTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 12) });
        }, { accent: true, cls: 'wrow-go', title: `Go to ${w.name}` }),
        mini('Edit', () => edit(w), { cls: 'wrow-edit', title: `Edit ${w.name}` })))
      : [el('div', { class: 'drawer-empty', text: waypoints.length ? 'No waypoint matches that' : 'No waypoints yet' })]));
  };
  const search = el('input', { type: 'search', id: 'wpt-search', placeholder: 'Search waypoints', value: query, autocomplete: 'off', oninput: () => { query = search.value; fill(); } });
  fill();
  return [search, results];
}

// ---------------------------------------------------------------- GPX in and out

/** The saved waypoints, and the routes given, as a GPX file: to the phone's share sheet, or saved as a download. */
export async function exportGpx(routes = []) {
  if (!waypoints.length && !routes.length) {
    toast('There are no waypoints to export yet.');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const file = new File([buildGpx(waypoints, routes)], `seabathy-waypoints-${stamp}.gpx`, { type: 'application/gpx+xml' });
  const also = routes.length ? ` and ${routes.length} route${routes.length === 1 ? '' : 's'}` : '';
  await saveFile(file, { title: 'SeaBathy waypoints', done: `Saved ${waypoints.length} waypoint${waypoints.length === 1 ? '' : 's'}${also} as ${file.name}` });
}

/** Adds waypoints read from a file, leaving out any already here (same name, same spot). */
export async function addAll(found) {
  let added = 0;
  for (const w of found) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) continue;
    const same = waypoints.some((o) => o.name === (w.name || o.name) && Math.abs(o.lat - w.lat) < 1e-6 && Math.abs(o.lng - w.lng) < 1e-6);
    if (same) continue;
    await save({
      id: newId(), name: w.name || nextName(), lat: w.lat, lng: w.lng, desc: w.desc || '',
      color: COLOURS.includes(w.color) ? w.color : COLOURS[0],
      icon: ICONS.some((i) => i.id === w.icon) ? w.icon : 'marker',
      created: Date.now()
    });
    added++;
  }
  return { added, skipped: found.length - added };
}

/** Adds the waypoints and routes in a GPX file, leaving out any already here. */
export async function importGpxText(text) {
  const found = parseGpx(text);
  const done = await addAll(found.waypoints);
  const routes = routeImporter ? await routeImporter(found.routes) : 0;
  return { ...done, routes, tracks: found.tracks };
}

/** The hidden file box that reads a GPX file; [after] runs once its marks are in. */
export function gpxPicker(after = () => {}) {
  const picker = el('input', {
    type: 'file', id: 'gpx-file', accept: '.gpx,application/gpx+xml,application/xml,text/xml', hidden: true,
    onchange: async () => {
      const file = picker.files[0];
      picker.value = '';
      if (!file) return;
      try {
        const done = await importGpxText(await file.text());
        const routes = done.routes ? ` and ${done.routes} route${done.routes === 1 ? '' : 's'}` : '';
        const extra = done.tracks ? ' Tracks in the file were left out.' : '';
        toast(`Added ${done.added} waypoint${done.added === 1 ? '' : 's'}${routes}${done.skipped ? `, ${done.skipped} already here` : ''}.${extra}`);
        after();
      } catch (error) {
        toast(error.message || "Couldn't read that file.");
      }
    }
  });
  return picker;
}

export async function start(theMap) {
  map = theMap;
  showNames = await db.setting.get('waypointNames', true);
  waypoints.push(...await db.all('waypoints'));
  for (const waypoint of waypoints) draw(waypoint);
}
