// The panels that open from the menu: charts and their colours, maps, saving an area for
// offline use, and storage.

import * as charts from './charts.js';
import * as basemap from './basemap.js';
import * as offline from './offline.js';
import * as files from './files.js';
import * as waypoints from './waypoints.js';
import { setting } from './db.js';
import { PALETTES, drawLegend, normalised, MAX_HILLSHADE_EXAGGERATION } from './depth.js';
import { add, el, toast, openSheet, refreshSheet, topSheet, backFrom, closeSheet, row, button, field, heading, note, toggle, slider, confirmCard, progressCard, holdScreenOn, card } from './ui.js';
import { openAbout } from './install.js';
import * as seabed from './seabed.js';
import * as terrain from './terrain.js';

let map = null;

export function begin(theMap) {
  map = theMap;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function describe(chart) {
  const size = chart.size ? ` · ${files.formatBytes(chart.size)}` : '';
  if (chart.kind === 'geotiff') return `${/^Seabed /.test(chart.name) ? 'Seabed depths' : 'Depth survey'}${size}`;
  const what = chart.view === 'vector' ? 'Depth chart' : chart.view === 'depth' ? 'Depth grid' : 'Chart picture';
  return chart.where === 'remote' ? `${what}, read from the web` : `${what} on this phone${size}`;
}

// ---------------------------------------------------------------- the menu

export function openMenu() {
  openSheet('SeaBathy', (body) => {
    add(body, 
      row('Get seabed depths', 'Draw an area and download free depths for it, anywhere in the world. They work offline and in 3D', () => seabed.show(map), { id: 'menu-seabed' }),
      row('Charts', charts.list().length ? plural(charts.list().length, 'chart') : 'Your depth layers, and files of your own', openCharts, { id: 'menu-charts' }),
      row('Maps', `${basemap.basemapById(basemap.state.basemap).label}${basemap.state.satOn ? ' with satellite' : ''}`, openMaps, { id: 'menu-maps' }),
      row('Waypoints', waypoints.list().length ? `${plural(waypoints.list().length, 'waypoint')} saved` : 'Mark spots, back them up as GPX', waypoints.openList, { id: 'menu-waypoints' }),
      row('Save for offline', 'Keep the area on screen for use with no signal', openOffline, { id: 'menu-offline' }),
      storageRow(),
      row('About and safety', 'Not for navigation, how to install, updates, credits', openAbout, { id: 'menu-about' }));
  }, { root: true });
}

/** The menu's Storage row, with the space the app is using filled in once it's known. */
function storageRow() {
  const node = row('Storage', 'What the app keeps on this phone', openStorage, { id: 'menu-storage' });
  files.storage().then((s) => {
    if (s.usage !== null) node.querySelector('.row-detail').textContent = `Using ${files.formatBytes(s.usage)} on this phone`;
  });
  return node;
}

// ---------------------------------------------------------------- charts

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
        paragraphs: ["The phone has no room for this file. Free up space, or delete a chart under Storage, and try again."],
        actions: [{ id: 'ok', label: 'OK', primary: true }]
      });
    } else toast(error.message || "Couldn't load that file.", 7000);
  } finally {
    letSleep();
  }
}

function openCharts() {
  openSheet('Charts', (body) => {
    const picker = el('input', {
      // No "accept": an iPhone greys out file types it doesn't know, .pmtiles among them.
      type: 'file', id: 'chart-file', hidden: true,
      onchange: () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        if (/\.pmtiles$/i.test(file.name)) importing('Loading the chart', (p) => charts.importPmtiles(file, p));
        else if (/\.(tiff?|geotiff)$/i.test(file.name)) importing('Loading the survey', (p) => charts.importTiff(file, p));
        else if (/\.mbtiles$/i.test(file.name)) toast("MBTiles files can't be read here. Convert it to PMTiles first: the guide in About says how.", 8000);
        else toast('Pick a .pmtiles chart or a .tif depth survey.', 6000);
      }
    });
    const url = el('input', { type: 'url', id: 'chart-url', placeholder: 'https://…/chart.pmtiles', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    const list = charts.list();
    add(body, 
      list.length ? [...list].reverse().map((c) => row(c.name, describe(c), () => openChart(c), { value: c.visible === false ? 'Hidden' : null })) : note('Nothing here yet. Get free seabed depths for the area on screen, or load a file of your own.'),
      heading('ADD'),
      row('Get seabed depths', 'Free, for the area on screen, anywhere in the world', () => seabed.show(map), { id: 'chart-seabed' }),
      row('Load a file from this phone', 'A .pmtiles chart or a .tif depth survey', () => picker.click(), { id: 'chart-load' }),
      picker,
      field('Or read a PMTiles chart from a web address', url),
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
      note('A loaded file is copied into the app, so it needs free space of about twice its size while it loads. Keep the original as your backup.'));
  });
}

const RANGES = [
  ['Reef and shallows: 1 to 15 m', 1, 15],
  ['Inshore detail: 10 to 30 m', 10, 30],
  ['Coastal: 6 to 100 m', 6, 100],
  ['Offshore: 20 to 500 m', 20, 500]
];

function openChart(chart) {
  let timer = 0;
  // Sliders and typing change the chart a moment after the last touch, not on every step.
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => charts.restyle(chart), 160);
  };
  openSheet(chart.name, (body) => {
    const here = topSheet();
    const coloured = chart.view === 'depth' || (chart.view === 'vector' && chart.depthField);
    add(body, 
      note(describe(chart)),
      chart.kind === 'geotiff' ? row('See it in 3D', 'Fly over the seabed: height up to 100 times, depth bands, contours, satellite on top', () => terrain.open(chart), { id: 'chart-3d' }) : null,
      toggle('Show on the chart', null, chart.visible !== false, (on) => { chart.visible = on; charts.restyle(chart); basemap.refreshCredits(); }, 'chart-visible'),
      slider('Opacity', { min: 0.1, max: 1, step: 0.05, value: chart.opacity ?? 1, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { chart.opacity = v; soon(); }, id: 'chart-opacity' }),
      row('Go to this chart', null, () => { closeSheet(); charts.flyTo(chart); }));

    if (chart.view === 'vector') {
      const fields = charts.numberFields(chart);
      const pick = el('select', { id: 'chart-field', onchange: () => { chart.depthField = pick.value || null; chart.positiveDown = null; charts.restyle(chart); refreshSheet(); } },
        el('option', { value: '', text: 'None: one plain colour' }),
        fields.map((name) => el('option', { value: name, text: name, selected: name === chart.depthField })));
      add(body, heading('DEPTHS'), field('Which value is the depth', pick));
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
      add(body, heading('WHAT IT HOLDS'), field('These tiles are', pick));
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
      paint();
      add(body, 
        heading('DEPTH COLOURS'),
        field('Palette', palette),
        legend,
        el('div', { class: 'pair' }, field('From depth (m)', from), field('To depth (m)', to)),
        row("Fit to this chart's depths", chart.view === 'vector' ? 'From the part now on screen' : null, () => {
          const fit = charts.fittedRange(chart);
          if (!fit) toast('Zoom to the chart first, so its depths are on screen.');
          else setRange(-fit[0], -fit[1]);
        }, { id: 'ramp-fit' }),
        RANGES.map(([label, a, b]) => row(label, null, () => setRange(a, b))),
        toggle('Reverse the colours', null, ramp.invert, (on) => { chart.ramp = { ...chart.ramp, invert: on }; paint(); soon(); }),
        toggle('Colour depths outside the range', 'Off: only the depths you picked are shown', ramp.showOutside, (on) => { chart.ramp = { ...chart.ramp, showOutside: on }; soon(); }));
      if (chart.view === 'depth') {
        add(body, slider('Relief shading', {
          min: 0, max: MAX_HILLSHADE_EXAGGERATION, step: 0.1, value: ramp.hillshadeExaggeration, format: (v) => (v === 0 ? 'Off' : v.toFixed(1)),
          onInput: (v) => { chart.ramp = { ...chart.ramp, hillshadeExaggeration: v }; soon(); }
        }));
      }
    }

    add(body, heading('MORE'));
    if (chart.where === 'remote') add(body, row('Save an area of it offline', 'For use with no signal', openOffline));
    add(body, row('Delete this chart', chart.where === 'remote' ? 'Removes it and its saved areas' : 'Removes the copy kept in the app', async () => {
      if (!(await confirmCard('Delete this chart?', `"${chart.name}" will be removed from the app. The file you loaded it from isn't touched.`, 'Delete', { danger: true }))) return;
      await charts.remove(chart);
      backFrom(here);
    }, { danger: true, id: 'chart-delete' }));
  });
}

// ---------------------------------------------------------------- maps

function openMaps() {
  openSheet('Maps', (body) => {
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
      }, { value: s.basemap === b.id ? '✓' : null, id: `basemap-${b.id}` })),
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
  openSheet('Save for offline', (body) => {
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
        note('To save more, turn on the satellite picture (Maps) or add a chart from a web address (Charts), move the chart to the area you want, then come back here.'),
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
      heading('CHARTS ON THIS PHONE'),
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
