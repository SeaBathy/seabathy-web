// Waypoints: marks on the chart with a name, a note, a colour and a symbol. They are saved in
// the app's database on the phone, and go in and out as GPX.

import { Marker } from '../vendor/maplibre-gl.js';
import * as db from './db.js';
import { buildGpx, parseGpx } from './gpx.js';
import { add, el, svg, toast, openSheet, refreshSheet, backSheet, closeSheet, row, button, field, heading, note, toggle, confirmCard } from './ui.js';

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
    edit(waypoint);
  });
  markers.set(waypoint.id, new Marker({ element: node, anchor: 'top', offset: [0, -13] }).setLngLat([waypoint.lng, waypoint.lat]).addTo(map));
}

async function save(waypoint) {
  await db.put('waypoints', waypoint);
  if (!waypoints.includes(waypoint)) waypoints.push(waypoint);
  draw(waypoint);
}

async function remove(waypoint) {
  await db.remove('waypoints', waypoint.id);
  waypoints.splice(waypoints.indexOf(waypoint), 1);
  markers.get(waypoint.id)?.remove();
  markers.delete(waypoint.id);
}

/** A new waypoint at a place, opened for editing straight away. */
export async function addAt(lng, lat) {
  const waypoint = { id: newId(), name: nextName(), lat, lng, color: COLOURS[0], desc: '', icon: 'marker', created: Date.now() };
  await save(waypoint);
  edit(waypoint, { fresh: true });
  return waypoint;
}

const formatPosition = (lat, lng) => `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(5)}° ${lng < 0 ? 'W' : 'E'}`;

/** The edit panel for one waypoint. */
export function edit(waypoint, { fresh = false } = {}) {
  const draft = { ...waypoint };
  openSheet(fresh ? 'New waypoint' : 'Waypoint', (body) => {
    const name = el('input', { type: 'text', id: 'wpt-name', value: draft.name, maxLength: 60, autocomplete: 'off', oninput: () => { draft.name = name.value; } });
    const desc = el('textarea', { id: 'wpt-desc', rows: 2, maxLength: 500, value: draft.desc || '', oninput: () => { draft.desc = desc.value; } });
    const lat = el('input', { type: 'text', id: 'wpt-lat', inputMode: 'decimal', value: draft.lat.toFixed(6), oninput: () => { draft.lat = Number(lat.value); } });
    const lng = el('input', { type: 'text', id: 'wpt-lng', inputMode: 'decimal', value: draft.lng.toFixed(6), oninput: () => { draft.lng = Number(lng.value); } });
    const swatches = el('div', { class: 'swatches' }, COLOURS.map((colour) => el('button', {
      type: 'button', class: `swatch${colour === draft.color ? ' on' : ''}`, style: `background:${colour}`, 'aria-label': `Colour ${colour}`,
      onclick: (event) => {
        draft.color = colour;
        for (const s of swatches.children) s.classList.toggle('on', s === event.currentTarget);
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
    add(body, 
      field('Name', name),
      field('Note', desc),
      el('div', { class: 'pair' }, field('Latitude', lat), field('Longitude', lng)),
      note('Decimal degrees: south and west are negative.'),
      heading('COLOUR'), swatches,
      heading('SYMBOL'), icons,
      el('div', { class: 'actions' },
        button('Delete', async () => {
          if (!fresh && !(await confirmCard('Delete this waypoint?', `"${waypoint.name}" will be removed from this phone.`, 'Delete', { danger: true }))) return;
          await remove(waypoint);
          backSheet();
        }, { danger: true, id: 'wpt-delete' }),
        button('Go to', () => {
          closeSheet();
          map.easeTo({ center: [waypoint.lng, waypoint.lat], zoom: Math.max(map.getZoom(), 13) });
        }),
        button('Save', async () => {
          if (!Number.isFinite(draft.lat) || !Number.isFinite(draft.lng) || Math.abs(draft.lat) > 90 || Math.abs(draft.lng) > 180) {
            toast('That position isn\'t valid: latitude is -90 to 90, longitude -180 to 180.');
            return;
          }
          Object.assign(waypoint, draft, { name: draft.name.trim() || nextName() });
          await save(waypoint);
          backSheet();
        }, { primary: true, id: 'wpt-save' })));
  });
}

/** The saved waypoints as a GPX file, handed to the phone's share sheet or saved as a download. */
async function exportGpx() {
  if (!waypoints.length) {
    toast('There are no waypoints to export yet.');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const file = new File([buildGpx(waypoints)], `seabathy-waypoints-${stamp}.gpx`, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'SeaBathy waypoints' });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  const link = el('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  toast(`Saved ${waypoints.length} waypoint${waypoints.length === 1 ? '' : 's'} as ${file.name}`);
}

/** Adds the waypoints in a GPX file, leaving out any already here (same name, same spot). */
export async function importGpxText(text) {
  const found = parseGpx(text);
  let added = 0;
  for (const w of found.waypoints) {
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
  return { added, skipped: found.waypoints.length - added, routes: found.routes, tracks: found.tracks };
}

/** The waypoint list: search, tap one to open it, and the GPX backup. */
export function openList() {
  let query = '';
  openSheet('Waypoints', (body) => {
    const results = el('div', { id: 'wpt-list' });
    const fill = () => {
      const q = query.trim().toLowerCase();
      const shown = waypoints
        .filter((w) => !q || w.name.toLowerCase().includes(q) || (w.desc || '').toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      results.replaceChildren(...(shown.length
        ? shown.map((w) => row(w.name, formatPosition(w.lat, w.lng), () => edit(w)))
        : [note(waypoints.length ? 'No waypoint matches that.' : 'No waypoints yet. Tap + on the chart to mark the spot under the crosshair, or hold a finger on the chart.')]));
    };
    const search = el('input', { type: 'search', placeholder: 'Search', value: query, oninput: () => { query = search.value; fill(); } });
    const picker = el('input', {
      type: 'file', id: 'gpx-file', accept: '.gpx,application/gpx+xml,application/xml,text/xml', hidden: true,
      onchange: async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        try {
          const done = await importGpxText(await file.text());
          const extra = done.routes + done.tracks ? ` Routes and tracks in the file were left out.` : '';
          toast(`Added ${done.added} waypoint${done.added === 1 ? '' : 's'}${done.skipped ? `, ${done.skipped} already here` : ''}.${extra}`);
          refreshSheet();
        } catch (error) {
          toast(error.message || "Couldn't read that file.");
        }
      }
    });
    fill();
    add(body, 
      waypoints.length > 6 ? search : null,
      results,
      heading('BACKUP'),
      row('Export waypoints', 'Save or share them as a GPX file', exportGpx, { id: 'gpx-export' }),
      row('Import GPX', 'From a backup, a plotter or another app', () => picker.click(), { id: 'gpx-import' }),
      picker,
      toggle('Show names on the chart', null, showNames, async (on) => {
        showNames = on;
        await db.setting.set('waypointNames', on);
        for (const w of waypoints) draw(w);
      }));
  });
}

export async function start(theMap) {
  map = theMap;
  showNames = await db.setting.get('waypointNames', true);
  waypoints.push(...await db.all('waypoints'));
  for (const waypoint of waypoints) draw(waypoint);
}
