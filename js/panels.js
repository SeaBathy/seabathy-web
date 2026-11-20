// The Layers panel and the panels that open from it: Settings and its groups, a layer's depth
// colours, maps, saving an area for offline use, and storage. Laid out as the Android app's are.

import * as charts from './charts.js';
import * as basemap from './basemap.js';
import * as offline from './offline.js';
import * as files from './files.js';
import * as waypoints from './waypoints.js';
import { setting } from './db.js';
import { PALETTES, drawLegend, normalised, MAX_HILLSHADE_EXAGGERATION, SLOPE_MAXES, DEFAULT_SLOPE_MAX, setShallowMark, getShallowMark } from './depth.js';
import * as contours from './contours.js';
import { add, el, toast, openSheet, refreshSheet, topSheet, backFrom, closeSheet, row, button, field, heading, note, toggle, slider, confirmCard, progressCard, holdScreenOn, card, openDrawer, closeDrawer, refreshDrawer, mini, chooser } from './ui.js';
import { openAbout, openInstall, canInstall } from './install.js';
import * as seabed from './seabed.js';
import * as terrain from './terrain.js';
import * as places from './places.js';
import * as units from './units.js';
import * as routes from './routes.js';
import * as backup from './backup.js';
import { VERSION } from './install.js';

let map = null;

export function begin(theMap) {
  map = theMap;
  // The Layers panel lists the waypoints: it is drawn again when one changes.
  waypoints.onChange(refreshDrawer);
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** What a layer is, in a few words. */
function kindOf(chart) {
  if (chart.kind === 'geotiff') return /^Seabed /.test(chart.name) ? 'Seabed depths' : 'Depth survey';
  return chart.view === 'vector' ? 'Depth chart' : chart.view === 'depth' ? 'Depth grid' : 'Chart picture';
}

function describe(chart) {
  const size = chart.size ? ` · ${files.formatBytes(chart.size)}` : '';
  if (chart.kind === 'geotiff') return `${kindOf(chart)}${size}`;
  return chart.where === 'remote' ? `${kindOf(chart)}, read from the web` : `${kindOf(chart)} on this phone${size}`;
}

const isColoured = (chart) => chart.view === 'depth' || (chart.view === 'vector' && Boolean(chart.depthField));
const percent = (fraction) => `${Math.round(fraction * 100)}%`;

/** The line under a layer's name: what it is, its depth range when it has colours, and how see-through it is. */
function layerLine(chart) {
  const parts = [chart.where === 'remote' ? `${kindOf(chart)}, web` : kindOf(chart)];
  if (isColoured(chart)) {
    const ramp = normalised(chart.ramp);
    parts.push(`${Math.round(-ramp.shallowMetres)} to ${Math.round(-ramp.deepMetres)} m`);
  }
  parts.push(percent(chart.opacity ?? 1));
  return parts.join(' • ');
}

// ---------------------------------------------------------------- the Layers panel

/** Gives a layer a name of the person's own. Only the name shown in the app changes. */
async function renameLayer(chart) {
  const name = el('input', { type: 'text', id: 'chart-name', class: 'plain-input', value: chart.name, maxLength: 80, autocomplete: 'off', placeholder: 'Layer name' });
  const answer = await card({
    title: 'Rename layer', body: [name], dismissable: true,
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Save', primary: true, domId: 'chart-name-save' }]
  });
  const wanted = name.value.trim();
  if (answer !== 'yes' || !wanted || wanted === chart.name) return;
  chart.name = wanted;
  await charts.restyle(chart);
}

async function removeLayer(chart) {
  const what = chart.where === 'remote' ? 'It is removed from the app, with any areas of it saved for offline.' : "The copy kept in the app is removed. The file you loaded it from isn't touched.";
  if (!(await confirmCard(`Remove ${chart.name}?`, what, 'Remove', { danger: true }))) return;
  await charts.remove(chart);
}

/** One layer: its name (a tap goes to it) and switch, how see-through it is, and what can be done with it. */
function layerCard(chart) {
  let timer = 0;
  const line = el('span', { class: 'layer-sub', text: layerLine(chart) });
  const opacity = el('input', {
    type: 'range', min: 0.1, max: 1, step: 0.05, value: chart.opacity ?? 1, 'aria-label': `Opacity for ${chart.name}`,
    oninput: () => {
      chart.opacity = Number(opacity.value);
      line.textContent = layerLine(chart);
      // The chart changes a moment after the last touch, not on every step.
      clearTimeout(timer);
      timer = setTimeout(() => charts.restyle(chart), 160);
    }
  });
  const shown = el('input', {
    type: 'checkbox', checked: chart.visible !== false, 'aria-label': `Show ${chart.name}`,
    onchange: async () => {
      chart.visible = shown.checked;
      await charts.restyle(chart);
      basemap.refreshCredits();
    }
  });
  return el('div', { class: 'layer', id: `layer-${chart.id}` },
    el('div', { class: 'layer-top' },
      el('button', {
        class: 'layer-name', type: 'button', 'aria-label': `Go to ${chart.name} on the map`,
        onclick: () => {
          closeDrawer();
          charts.flyTo(chart);
        }
      }, el('span', { class: 'layer-title', text: chart.name }), line),
      shown),
    opacity,
    el('div', { class: 'layer-chips' },
      el('span', { class: 'gap' }),
      mini('Rename', () => renameLayer(chart), { cls: 'layer-rename', title: `Rename ${chart.name}` }),
      mini('Remove', () => removeLayer(chart), { danger: true, cls: 'layer-remove', title: `Remove ${chart.name}` })),
    el('div', { class: 'layer-chips wide' },
      mini(isColoured(chart) ? 'Colours' : 'Options', () => openChart(chart), { cls: 'layer-more', title: `Depth colours and options for ${chart.name}` }),
      chart.kind === 'geotiff' ? mini('3D view', () => terrain.open(chart), { cls: 'layer-3d', title: `Show ${chart.name} in 3D` }) : null));
}

/** The satellite picture, listed with the layers: it is drawn over them, so it comes first. */
function satelliteCard() {
  const s = basemap.state;
  const text = () => (s.satOn ? `${basemap.satelliteById(s.satId).label} • ${percent(s.satOpacity)}` : 'Online picture • off');
  const line = el('span', { class: 'layer-sub', text: text() });
  const opacity = el('input', {
    type: 'range', min: 0.1, max: 1, step: 0.05, value: s.satOpacity, 'aria-label': 'Opacity for the satellite picture', disabled: !s.satOn,
    oninput: () => {
      basemap.setSatellite({ satOpacity: Number(opacity.value) });
      line.textContent = text();
    }
  });
  const shown = el('input', {
    type: 'checkbox', checked: s.satOn, 'aria-label': 'Show the satellite picture',
    onchange: async () => {
      await basemap.setSatellite({ satOn: shown.checked });
      refreshDrawer();
    }
  });
  return el('div', { class: 'layer', id: 'layer-sat' },
    el('div', { class: 'layer-top' },
      el('button', { class: 'layer-name', type: 'button', onclick: openMaps }, el('span', { class: 'layer-title', text: 'Satellite picture' }), line),
      shown),
    s.satOn ? opacity : null);
}

/** The Layers panel: Settings, the map layers, the waypoints, and the basemap at its foot. */
export function openMenu() {
  openDrawer((body, foot) => {
    const layers = [...charts.list()].reverse();
    const pick = el('select', {
      class: 'spinner', id: 'drawer-basemap', 'aria-label': 'Basemap',
      onchange: async () => {
        await basemap.setBasemap(pick.value);
        refreshDrawer();
      }
    }, basemap.BASEMAPS.filter((b) => b.id !== 'custom' || basemap.state.customUrl).map((b) => el('option', { value: b.id, text: b.label, selected: basemap.state.basemap === b.id })));
    add(body,
      row('Settings', null, openSettings, { id: 'menu-settings', chevron: true }),
      el('div', { class: 'drawer-label', text: 'Map layers' }),
      satelliteCard(),
      layers.length ? layers.map(layerCard) : el('div', { class: 'drawer-empty', id: 'layers-empty', text: 'No depth layers loaded yet' }),
      el('button', { class: 'drawer-link', type: 'button', id: 'menu-seabed', text: '＋  Get seabed depths', onclick: () => seabed.show(map) }),
      el('div', { class: 'drawer-label', text: 'Waypoints' }),
      waypoints.drawerSection());
    add(foot, el('div', { class: 'drawer-label', text: 'Basemap' }), pick);
  });
}

/** Draws the Layers panel again when what it lists has changed. */
export const refreshMenu = refreshDrawer;

// ---------------------------------------------------------------- Settings

/** Settings: its groups, each a card of its own, as in the Android app. */
function openSettings() {
  openSheet('Settings', (body) => {
    add(body,
      canInstall() ? row('Install SeaBathy', 'Its own icon and window, without the address bar', openInstall, { id: 'menu-install' }) : null,
      row('Map display', 'Coordinates, crosshair depth, waypoint names, night filter', openDisplay, { id: 'settings-display' }),
      row('Depths', 'Seabed downloads, your own files, depth colours', openDepths, { id: 'menu-charts' }),
      row('Online and offline maps', 'Satellite and other map layers, save maps offline', openOnline, { id: 'settings-maps' }),
      row('Boat and navigation', 'Units, saved routes', openBoat, { id: 'settings-boat' }),
      row('Australia', 'Marine park zones, reef names, boat ramps, buoys', places.openPanel, { id: 'menu-places' }),
      row('Waypoints and backup', 'Backup, GPX in and out', openBackup, { id: 'settings-backup' }),
      row('About', 'Safety and terms, privacy, licences, updates', openAbout, { id: 'menu-about' }));
  }, { root: true });
}

const positionChoices = () => Object.entries(units.POSITIONS).map(([id, form]) => [id, form.name, form.example]);

function openDisplay() {
  openSheet('Map display', (body) => {
    add(body,
      row('Coordinates', units.POSITIONS[units.state.position]?.name, () => chooser('Coordinates', positionChoices(), units.state.position,
        (id) => units.set({ position: id }), (id) => `unit-position-${id}`), { id: 'display-position' }),
      toggle('Crosshair depth', 'The depth under the crosshair, from your depth layers', !document.body.classList.contains('no-crosshair-depth'), async (on) => {
        document.body.classList.toggle('no-crosshair-depth', !on);
        await setting.set('crosshairDepth', on);
      }, 'setting-crosshair-depth'),
      toggle('Show waypoint names on map', null, waypoints.showsNames(), (on) => waypoints.setShowNames(on), 'setting-names'),
      toggle('Night red filter', 'A dim red screen, to keep your night vision', document.body.classList.contains('night'), async (on) => {
        document.body.classList.toggle('night', on);
        await setting.set('night', on);
      }, 'setting-night'));
  });
}

/** The depths offered for marking shallow water, in each depth unit. */
const SHALLOWS = { m: [1, 2, 3, 5, 10, 20], ft: [3, 6, 10, 15, 30, 60], fm: [0.5, 1, 2, 3, 5, 10] };

/** Picks the depth that water must be shallower than to be marked in red, or none. */
function pickShallow() {
  const unit = units.depthUnit();
  const offered = SHALLOWS[units.state.depth] || SHALLOWS.m;
  const now = getShallowMark();
  const current = now > 0 ? String(offered.find((v) => Math.abs(v / unit.perMetre - now) < 0.02) ?? '') : 'off';
  chooser('Mark shallow water in red', [['off', 'Off'], ...offered.map((v) => [String(v), `Shallower than ${v} ${unit.label}`])], current, async (id) => {
    const metres = id === 'off' ? 0 : Number(id) / unit.perMetre;
    setShallowMark(metres);
    await setting.set('shallowMetres', metres);
    charts.redrawDepths();
  }, (id) => `shallow-${id}`);
}

function openBoat() {
  openSheet('Boat and navigation', (body) => {
    const shallow = getShallowMark();
    const pick = (title, all, key) => () => chooser(title, Object.entries(all).map(([id, unit]) => [id, `${unit.name} (${unit.label})`]), units.state[key],
      (id) => units.set({ [key]: id }), (id) => `unit-${key}-${id}`);
    add(body,
      heading('UNITS'),
      row('Depth', units.depthUnit().label, pick('Depth', units.DEPTHS, 'depth'), { id: 'boat-depth' }),
      row('Speed', units.speedUnit().label, pick('Speed', units.SPEEDS, 'speed'), { id: 'boat-speed' }),
      note("Depths are shown this way at the crosshair and in 3D. A layer's colour range is always set in metres. Distances are in nautical miles and bearings are true."),
      heading('SHALLOW WATER'),
      row('Mark shallow water in red', shallow > 0 ? `Shallower than ${Number((shallow * units.depthUnit().perMetre).toFixed(1))} ${units.depthUnit().label}` : 'Off', pickShallow, { id: 'boat-shallow' }),
      note('Red stripes are drawn over water shallower than this, on your depth layers and in 3D. A guide only: the depths come from surveys and take no account of the tide.'),
      heading('ROUTES'),
      row('Saved routes', routes.list().length ? `${plural(routes.list().length, 'route')}: load, rename, export` : 'Load, rename, export', routes.openLibrary, { id: 'menu-routes' }),
      note('Plan a route with the route tool on the top bar. The cruise speed for its times is set on the route card.'));
  });
}

function openOnline() {
  openSheet('Online and offline maps', (body) => {
    add(body,
      row('Online map layers', `${basemap.basemapById(basemap.state.basemap).label}${basemap.state.satOn ? ', with the satellite picture' : ''}`, openMaps, { id: 'menu-maps' }),
      row('Offline maps', 'Download the area on screen', openOffline, { id: 'menu-offline' }),
      storageRow());
  });
}

function openBackup() {
  openSheet('Waypoints and backup', (body) => {
    const restore = el('input', {
      type: 'file', id: 'backup-file', accept: '.json,application/json', hidden: true,
      onchange: () => {
        const file = restore.files[0];
        restore.value = '';
        if (file) restoreFrom(file);
      }
    });
    const gpx = waypoints.gpxPicker();
    add(body,
      note('A backup holds your waypoints, routes and settings in one file. Depth layers and saved map areas are not in it: they can be downloaded again.'),
      row('Back up now', 'Save a backup file where you choose', () => backup.save(VERSION), { id: 'backup-save' }),
      row('Restore a backup', 'From a SeaBathy web app backup file', () => restore.click(), { id: 'backup-restore' }),
      restore,
      row('Import GPX', 'From a plotter, the Android app or another app', () => gpx.click(), { id: 'gpx-import' }),
      gpx,
      row('Export waypoints and routes', 'Share as a GPX file', () => waypoints.exportGpx(routes.list()), { id: 'gpx-export' }));
  });
}

/** Reads a backup file and adds what it holds, asking first whether its settings should replace this device's. */
async function restoreFrom(file) {
  let found;
  try {
    found = backup.read(await file.text());
  } catch (error) {
    toast(error.message || "Couldn't read that file.", 6000);
    return;
  }
  const count = `${plural(found.waypoints.length, 'waypoint')} and ${plural((found.routes || []).length, 'route')}`;
  const answer = await card({
    title: 'Restore this backup?', dismissable: true,
    paragraphs: [`It holds ${count}, made ${String(found.created || '').slice(0, 10) || 'at an unknown date'}. Those not already here are added; nothing here is removed.`,
      'Its settings (units, basemap, switches) can replace the ones on this device too.'],
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'marks', label: 'Marks only', domId: 'restore-marks' }, { id: 'all', label: 'With settings', primary: true, domId: 'restore-all' }]
  });
  if (answer !== 'marks' && answer !== 'all') return;
  const done = await backup.restore(found, { withSettings: answer === 'all' });
  toast(`Added ${plural(done.waypoints, 'waypoint')} and ${plural(done.routes, 'route')}${done.already ? `; ${done.already} already here` : ''}.`, 6000);
  // The settings are read when the app starts.
  if (done.settings) setTimeout(() => location.reload(), 1500);
  else refreshSheet();
}

function storageRow() {
  const node = row('Storage', 'What the app keeps on this phone', openStorage, { id: 'menu-storage' });
  files.storage().then((s) => {
    if (s.usage !== null) node.querySelector('.row-detail').textContent = `Using ${files.formatBytes(s.usage)} on this phone`;
  });
  return node;
}

// ---------------------------------------------------------------- depths

/** Runs a long import behind a progress card and reports how it went. */
async function importing(title, work) {
  const progress = progressCard(title, 'Keep SeaBathy open and on screen until this finishes.');
  const letSleep = await holdScreenOn();
  try {
    const chart = await work(progress);
    progress.close();
    if (chart.session) toast("This browser can't keep files, so the chart stays only until the app closes.", 7000);
    else if ((await files.keep()) || (await setting.get('keepNoteShown', false))) toast(`${chart.name} is loaded and saved on this phone.`);
    else {
      // Said once: after that it is under Storage for anyone who wants it.
      await setting.set('keepNoteShown', true);
      toast(`${chart.name} is loaded and saved. The phone hasn't promised to keep the app's data if it runs short of space: see Storage.`, 8000);
    }
    closeSheet();
    charts.flyTo(chart);
  } catch (error) {
    progress.close();
    if (files.isCancel(error) || progress.signal.aborted) toast('Stopped. Nothing was kept.');
    else if (files.isFull(error)) {
      await card({
        title: 'Not enough space', dismissable: true,
        paragraphs: ['The phone has no room for this file. Free up space, or remove a layer, and try again.'],
        actions: [{ id: 'ok', label: 'OK', primary: true }]
      });
    } else toast(error.message || "Couldn't load that file.", 7000);
  } finally {
    letSleep();
  }
}

/** A PMTiles chart read over the internet from an address the person types. */
function openWebChart() {
  openSheet('Chart from a web address', (body) => {
    const url = el('input', { type: 'url', id: 'chart-url', placeholder: 'https://…/chart.pmtiles', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    add(body,
      field('Address of a PMTiles chart', url),
      el('div', { class: 'actions' }, button('Add', async () => {
        try {
          const chart = await charts.addRemote(url.value);
          toast(`${chart.name} is added. It needs the internet unless you save an area for offline.`, 6000);
          closeSheet();
          charts.flyTo(chart);
        } catch (error) {
          toast(error.message || "Couldn't add that chart.", 7000);
        }
      }, { primary: true, id: 'chart-add-url' })),
      note("The chart stays on its own server and is read a piece at a time. Add only a chart whose owner allows it."));
  });
}

function openDepths() {
  openSheet('Depths', (body) => {
    const picker = el('input', {
      // No "accept": an iPhone greys out file types it doesn't know, .pmtiles among them.
      type: 'file', id: 'chart-file', hidden: true,
      onchange: () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        if (/\.pmtiles$/i.test(file.name)) importing('Loading the chart', (p) => charts.importPmtiles(file, p));
        else if (/\.(tiff?|geotiff)$/i.test(file.name)) importing('Loading the survey', (p) => charts.importTiff(file, p));
        else if (/\.mbtiles$/i.test(file.name)) toast("MBTiles files can't be read here. Convert it to PMTiles first: About says how.", 8000);
        else toast('Pick a .tif depth survey or a .pmtiles chart.', 6000);
      }
    });
    add(body,
      row('Get seabed depths', 'Draw the area on the chart. Free depth data, anywhere in the world', () => seabed.show(map), { id: 'chart-seabed' }),
      row('Load GeoTIFF or PMTiles file', 'Depth surveys (.tif) and charts (.pmtiles) from this device', () => picker.click(), { id: 'chart-load' }),
      picker,
      row('Chart from a web address', 'A PMTiles chart read over the internet', openWebChart, { id: 'chart-web' }),
      heading('DEPTH COLOURS'),
      note('Colours and depth range are set for each layer. Depths outside the range are hidden.'),
      charts.list().some(isColoured)
        ? [...charts.list()].reverse().filter(isColoured).map((c) => row(c.name, 'Palette, depth range, shading', () => openChart(c)))
        : note('No depth layers yet.'),
      note('A loaded file is copied into the app, so it needs free space of about twice its size while it loads. Keep the original as your backup.'));
  });
}

const RANGES = [
  ['Reef and shallows: 1 to 15 m', 1, 15],
  ['Inshore detail: 10 to 30 m', 10, 30],
  ['Coastal: 6 to 100 m', 6, 100],
  ['Offshore: 20 to 500 m', 20, 500]
];

/** A layer's own panel: what its values mean, and its depth colours. */
function openChart(chart) {
  let timer = 0;
  // Sliders and typing change the chart a moment after the last touch, not on every step.
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => charts.restyle(chart), 160);
  };
  openSheet(chart.name, (body) => {
    const coloured = isColoured(chart);
    add(body, note(describe(chart)));

    if (chart.view === 'vector') {
      const fields = charts.numberFields(chart);
      const pick = el('select', { id: 'chart-field', onchange: () => { chart.depthField = pick.value || null; chart.positiveDown = null; charts.restyle(chart); refreshSheet(); } },
        el('option', { value: '', text: 'None: one plain colour' }),
        fields.map((name) => el('option', { value: name, text: name, selected: name === chart.depthField })));
      add(body, field('Which value is the depth', pick));
      if (chart.depthField) {
        add(body, toggle('Depths are written as positive numbers', 'Off when deeper water has lower (negative) values', chart.positiveDown === true, (on) => { chart.positiveDown = on; charts.restyle(chart); }));
      }
    } else if (chart.kind === 'pmtiles') {
      const pick = el('select', {
        id: 'chart-view',
        onchange: () => {
          chart.view = pick.value === 'picture' ? 'picture' : 'depth';
          if (chart.view === 'depth') chart.encoding = pick.value;
          charts.restyle(chart);
          refreshSheet();
        }
      },
      [['picture', 'A chart picture: show it as it is'], ['terrarium', 'Depths (Terrarium tiles)'], ['mapbox', 'Depths (Mapbox Terrain-RGB tiles)']].map(([value, text]) =>
        el('option', { value, text, selected: (chart.view === 'picture' ? 'picture' : chart.encoding) === value })));
      add(body, field('These tiles are', pick));
    }

    if (coloured) {
      const ramp = normalised(chart.ramp);
      const legend = el('canvas', { class: 'legend', width: 320, height: 14 });
      const paint = () => drawLegend(legend, chart.ramp);
      const from = el('input', { type: 'text', inputMode: 'decimal', id: 'ramp-from', value: String(-ramp.shallowMetres) });
      const to = el('input', { type: 'text', inputMode: 'decimal', id: 'ramp-to', value: String(-ramp.deepMetres) });
      const setRange = (a, b) => {
        if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < 0.1) return;
        chart.ramp = { ...chart.ramp, shallowMetres: -Math.min(a, b), deepMetres: -Math.max(a, b) };
        from.value = String(Math.min(a, b));
        to.value = String(Math.max(a, b));
        soon();
      };
      from.addEventListener('change', () => setRange(Number(from.value), Number(to.value)));
      to.addEventListener('change', () => setRange(Number(from.value), Number(to.value)));
      const palette = el('select', { id: 'ramp-palette', onchange: () => { chart.ramp = { ...chart.ramp, paletteId: palette.value }; paint(); soon(); } },
        PALETTES.map((p) => el('option', { value: p.id, text: p.label, selected: p.id === ramp.paletteId })));
      // A depth grid can be coloured by how steep the seabed is instead, as in the 3D view.
      const bySlope = chart.view === 'depth' && ramp.colourBy === 'slope';
      const colourBy = el('select', {
        id: 'ramp-colour-by',
        onchange: async () => {
          chart.ramp = { ...chart.ramp, colourBy: colourBy.value };
          await charts.restyle(chart);
          refreshSheet();
        }
      }, [['depth', 'Depth'], ['slope', 'Slope (ledges and drop-offs)']].map(([value, text]) => el('option', { value, text, selected: (bySlope ? 'slope' : 'depth') === value })));
      const steepText = (degrees) => `Blue is flat seabed; red is ${degrees}° or steeper.`;
      const steepNote = note(steepText(ramp.slopeMax || DEFAULT_SLOPE_MAX));
      const steep = el('select', {
        id: 'ramp-slope-max',
        onchange: () => {
          chart.ramp = { ...chart.ramp, slopeMax: Number(steep.value) };
          steepNote.textContent = steepText(steep.value);
          soon();
        }
      }, SLOPE_MAXES.map(([value, text]) => el('option', { value: String(value), text, selected: value === (ramp.slopeMax || DEFAULT_SLOPE_MAX) })));
      paint();
      add(body,
        heading('DEPTH COLOURS'),
        chart.view === 'depth' ? field('Colour by', colourBy) : null,
        bySlope ? field('Red from', steep) : field('Palette', palette),
        legend,
        bySlope ? steepNote : null,
        el('div', { class: 'pair' }, field('From depth (m)', from), field('To depth (m)', to)),
        row("Fit to this layer's depths", chart.view === 'vector' ? 'From the part now on screen' : null, () => {
          const fit = charts.fittedRange(chart);
          if (!fit) toast('Zoom to the layer first, so its depths are on screen.');
          else setRange(-fit[0], -fit[1]);
        }, { id: 'ramp-fit' }),
        RANGES.map(([label, a, b]) => row(label, null, () => setRange(a, b))),
        bySlope ? null : toggle('Reverse the colours', null, ramp.invert, (on) => { chart.ramp = { ...chart.ramp, invert: on }; paint(); soon(); }),
        toggle('Colour depths outside the range', 'Off: only the depths you picked are shown', ramp.showOutside, (on) => { chart.ramp = { ...chart.ramp, showOutside: on }; soon(); }));
      if (chart.view === 'depth') {
        add(body, slider('Relief shading', {
          min: 0, max: MAX_HILLSHADE_EXAGGERATION, step: 0.1, value: ramp.hillshadeExaggeration, format: (v) => (v === 0 ? 'Off' : v.toFixed(1)),
          onInput: (v) => { chart.ramp = { ...chart.ramp, hillshadeExaggeration: v }; soon(); }
        }));
      }
    }

    if (chart.kind === 'geotiff') {
      const lines = contours.settingsOf(chart);
      const setLines = async (change) => {
        chart.contours = { ...contours.settingsOf(chart), ...change };
        await charts.restyle(chart);
        refreshSheet();
      };
      const every = el('select', { id: 'contour-every', onchange: () => setLines({ metres: every.value ? Number(every.value) : null }) },
        el('option', { value: '', text: 'Auto: to suit the depths on screen', selected: lines.metres === null }),
        contours.CHOICES.map((metres) => el('option', { value: String(metres), text: `${metres} m`, selected: lines.metres === metres })));
      add(body,
        heading('CONTOUR LINES'),
        toggle('Contour lines', 'Lines of equal depth, with the depth written on them', lines.on, (on) => setLines({ on }), 'contour-on'),
        lines.on ? field('A line every', every) : null);
    }

    if (chart.where === 'remote') add(body, heading('OFFLINE'), row('Save an area of it offline', 'For use with no signal', openOffline));
  });
}

// ---------------------------------------------------------------- maps

function openMaps() {
  openSheet('Online map layers', (body) => {
    const s = basemap.state;
    const link = el('input', { type: 'url', id: 'custom-url', placeholder: 'https://…/{z}/{x}/{y}.png', value: s.customUrl, autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    const credit = el('input', { type: 'text', id: 'custom-credit', placeholder: "The map provider's credit line", value: s.customCredit, maxLength: 160 });
    const picture = el('select', { id: 'sat-picture', onchange: () => basemap.setSatellite({ satId: picture.value }).then(refreshSheet) },
      basemap.SATELLITES.map((p) => el('option', { value: p.id, text: p.label, selected: p.id === s.satId })));
    add(body, 
      heading('BASEMAP'),
      basemap.BASEMAPS.map((b) => row(b.label, b.detail, async () => {
        if (b.id === 'custom' && !s.customUrl) {
          toast('Enter your tile link below first.');
          return;
        }
        await basemap.setBasemap(b.id);
        refreshSheet();
      }, { chosen: s.basemap === b.id, id: `basemap-${b.id}` })),
      heading('YOUR OWN TILE LINK'),
      field('Tile link', link),
      field('Credit shown on the map', credit),
      el('div', { class: 'actions' },
        s.customUrl ? button('Remove', async () => { await basemap.setCustom('', ''); refreshSheet(); }) : null,
        button('Use this map', async () => {
          const problem = basemap.linkError(link.value);
          if (problem) {
            toast(problem);
            return;
          }
          await basemap.setCustom(link.value, credit.value);
          await basemap.setBasemap('custom');
          refreshSheet();
        }, { primary: true, id: 'custom-save' })),
      note("Map services belong to their owners and have their own terms, which often limit how a map may be used. Add only a map whose terms allow it, and type the credit its owner asks for."),
      heading('SATELLITE PICTURE'),
      toggle('Show the satellite picture', 'Over the charts, so reef, sand and channels show through', s.satOn, (on) => basemap.setSatellite({ satOn: on }).then(refreshSheet), 'sat-on'),
      s.satOn ? [
        field('Picture', picture),
        note(basemap.satelliteById(s.satId).detail),
        slider('Opacity', { min: 0.1, max: 1, step: 0.05, value: s.satOpacity, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => basemap.setSatellite({ satOpacity: v }), id: 'sat-opacity' })
      ] : null);
  });
}

// ---------------------------------------------------------------- save for offline

/** The maps that can be saved now: the satellite picture when it's on, and each web chart shown. */
function savable() {
  const out = [];
  const sat = basemap.satelliteById(basemap.state.satId);
  if (basemap.state.satOn && sat.canSave) {
    out.push({
      source: basemap.satelliteSource(sat.id), label: sat.label, minZoom: 0, maxZoom: sat.maxZoom,
      fetchTile: (z, x, y, signal) => basemap.fetchSatellite(sat, z, x, y, signal)
    });
  }
  for (const chart of charts.list()) {
    if (chart.where !== 'remote' || chart.visible === false) continue;
    out.push({
      source: charts.tileSource(chart), label: chart.name, minZoom: chart.minZoom, maxZoom: chart.maxZoom,
      fetchTile: (z, x, y, signal) => charts.rawTile(chart, z, x, y, signal, { savedFirst: false })
    });
  }
  return out;
}

function openOffline() {
  openSheet('Offline maps', (body) => {
    const choices = savable();
    const view = map.getBounds();
    const bounds = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
    const here = Math.floor(map.getZoom());
    const saved = offline.list();
    const savedRows = saved.length
      ? [heading('SAVED AREAS'), ...[...saved].reverse().map((p) => row(p.label, `${plural(p.tiles, 'tile')} · ${files.formatBytes(p.bytes)} · zoom ${p.minZoom} to ${p.maxZoom}`, async () => {
        if (!(await confirmCard('Delete this saved area?', `"${p.label}" will need the internet again here.`, 'Delete', { danger: true }))) return;
        await offline.removePack(p);
        refreshSheet();
      }, { value: 'Delete', danger: true }))]
      : [];
    if (!choices.length) {
      add(body, 
        note('Charts and surveys you load from the Files app already work with no signal.'),
        note('To save more, turn on the satellite picture in Layers, or add a chart from a web address (Settings, Depths), move the chart to the area you want, then come back here.'),
        savedRows);
      return;
    }
    const top = Math.max(...choices.map((c) => c.maxZoom));
    let detail = Math.min(top, Math.max(here, Math.min(here + 2, 15)));
    const picked = new Set(choices.map((c) => c.source));
    const summary = el('p', { class: 'note', id: 'offline-summary' });
    const go = button('Save this area', () => run(), { primary: true, id: 'offline-save' });
    /** The zooms to save for one map: from a little further out than the screen, in to the detail picked. */
    const range = (c) => [Math.max(c.minZoom, Math.min(c.maxZoom, here - 3), 0), Math.min(c.maxZoom, detail)];
    const total = () => choices.filter((c) => picked.has(c.source)).reduce((sum, c) => {
      const [a, b] = range(c);
      return sum + (b >= a ? offline.count(bounds, a, b) : 0);
    }, 0);
    const update = () => {
      const tiles = total();
      go.disabled = tiles === 0 || tiles > offline.MAX_TILES;
      summary.textContent = tiles > offline.MAX_TILES
        ? `${tiles.toLocaleString()} tiles is too many for one save (the most is ${offline.MAX_TILES.toLocaleString()}). Zoom in, or pick less detail.`
        : tiles === 0 ? 'Pick at least one map.' : `${plural(tiles, 'tile')}, roughly ${files.formatBytes(tiles * 22000)}. Saved at a gentle pace: ${tiles <= 1000 ? 'under a minute' : `about ${Math.ceil(tiles / 20 / 60)} min`}.`;
    };
    const run = async () => {
      const progress = progressCard('Saving the area', 'Keep SeaBathy open and on screen until this finishes.');
      const letSleep = await holdScreenOn();
      let done = 0;
      let failed = 0;
      try {
        for (const c of choices.filter((x) => picked.has(x.source))) {
          const [minZoom, maxZoom] = range(c);
          if (maxZoom < minZoom) continue;
          const pack = await offline.download({
            source: c.source, label: c.label, bounds, minZoom, maxZoom, fetchTile: c.fetchTile, signal: progress.signal,
            onProgress: (n, of, bytes) => progress.set(n / of, `${c.label}: ${n.toLocaleString()} of ${of.toLocaleString()} tiles · ${files.formatBytes(bytes)}`)
          });
          done += pack.tiles;
          failed += pack.failed;
        }
        progress.close();
        await files.keep();
        toast(failed ? `Saved ${plural(done, 'tile')}. ${plural(failed, 'tile')} couldn't be fetched: save the area again to fill them in.` : `Saved ${plural(done, 'tile')} for use with no signal.`, 6000);
        refreshSheet();
      } catch (error) {
        progress.close();
        if (progress.signal.aborted || files.isCancel(error)) toast('Stopped. Nothing from this save was kept.');
        else if (files.isFull(error)) toast('The phone ran out of space. Nothing from this save was kept.', 7000);
        else toast(error.message || "Couldn't save the area.", 7000);
      } finally {
        letSleep();
      }
    };
    update();
    add(body, 
      note('Saves the area now on screen. Move and zoom the chart first if this is not the area you want.'),
      heading('WHAT TO SAVE'),
      choices.map((c) => toggle(c.label, null, true, (on) => { if (on) picked.add(c.source); else picked.delete(c.source); update(); })),
      slider('Detail', { min: Math.min(here, top), max: top, step: 1, value: detail, format: (v) => `Zoom ${v}`, onInput: (v) => { detail = v; update(); }, id: 'offline-detail' }),
      summary,
      el('div', { class: 'actions' }, go),
      savedRows);
  });
}

// ---------------------------------------------------------------- storage

function openStorage() {
  openSheet('Storage', (body) => {
    const usage = el('p', { class: 'note', id: 'storage-usage', text: 'Working out the space used…' });
    const kept = el('p', { class: 'note', id: 'storage-kept' });
    const ask = button('Ask the phone to keep the data', async () => {
      const yes = await files.keep();
      toast(yes ? 'The phone has agreed to keep the app\'s data.' : "The phone hasn't agreed. It is most likely to once the app is on the Home Screen and has been used a few times.", 7000);
      refreshSheet();
    }, { id: 'storage-keep' });
    ask.hidden = true;
    files.storage().then((s) => {
      usage.textContent = s.usage === null ? "This browser doesn't say how much space the app uses."
        : `The app is using ${files.formatBytes(s.usage)}${s.quota ? ` of the ${files.formatBytes(s.quota)} this phone allows it` : ''}.`;
      kept.textContent = s.persisted === true ? 'The phone has agreed to keep this data: it is not cleared automatically.'
        : s.persisted === false ? 'The phone may clear this data if it runs very short of space. Keep your original chart files, and export your waypoints now and then.'
          : '';
      ask.hidden = s.persisted !== false;
    });
    const local = charts.list().filter((c) => c.where === 'local');
    add(body, 
      usage, kept, el('div', { class: 'actions' }, ask),
      heading('LAYERS ON THIS PHONE'),
      local.length ? local.map((c) => row(c.name, describe(c), async () => {
        if (!(await confirmCard('Delete this chart?', `"${c.name}" will be removed from the app, freeing ${files.formatBytes(c.size)}. The file you loaded it from isn't touched.`, 'Delete', { danger: true }))) return;
        await charts.remove(c);
        refreshSheet();
      }, { value: 'Delete', danger: true })) : note('None.'),
      heading('SAVED AREAS'),
      offline.list().length ? offline.list().map((p) => row(p.label, `${plural(p.tiles, 'tile')} · ${files.formatBytes(p.bytes)}`, async () => {
        if (!(await confirmCard('Delete this saved area?', `"${p.label}" will need the internet again here.`, 'Delete', { danger: true }))) return;
        await offline.removePack(p);
        refreshSheet();
      }, { value: 'Delete', danger: true })) : note('None.'),
      note('Everything is kept inside this app on this phone only. Removing the app from the Home Screen deletes it all, so export your waypoints first.'));
  });
}
