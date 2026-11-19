// Small pieces every screen uses: building elements, the Layers panel, the panels (cards over
// the chart), cards with buttons, the progress card and the short message at the foot of the
// screen. Text from files and from the user is always put in as text, never as HTML.

export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  return add(node, ...children);
}

/**
 * Adds children to a node. Lists are spread and empty entries left out, which the browser's own
 * append() doesn't do: it would write "null" on the screen.
 */
export function add(parent, ...children) {
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** A fixed picture from the app's own code (never from a file or the user). */
export function svg(markup, cls = '') {
  const holder = document.createElement('span');
  holder.className = `svg ${cls}`.trim();
  holder.innerHTML = markup;
  return holder;
}

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"/></svg>';

// ---------------------------------------------------------------- the message at the foot

let toastTimer = 0;

export function toast(text, ms = 3800) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

/** Puts the message away now (something that needs its place has opened). */
export function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

// ---------------------------------------------------------------- the panels: cards over the chart

const stack = [];

function showTop({ keepPlace = false } = {}) {
  const layer = $('#sheet-layer');
  const top = stack[stack.length - 1];
  if (!top) {
    layer.hidden = true;
    document.body.classList.remove('sheet-open');
    return;
  }
  $('#sheet-title').textContent = top.title;
  layer.classList.toggle('dock', Boolean(top.dock));
  layer.classList.toggle('own', Boolean(top.own));
  const body = $('#sheet-body');
  const place = keepPlace ? body.scrollTop : top.place || 0;
  body.replaceChildren();
  top.build(body);
  layer.hidden = false;
  body.scrollTop = place;
  document.body.classList.add('sheet-open');
}

/**
 * Opens a panel: a card over the chart, on top of any panel already open. [build] fills its
 * body; it runs again whenever the panel is shown. [dock] puts the card at the foot of the
 * screen without a Close of its own (the card for a new waypoint, which has Cancel and Save);
 * [own] leaves out the Close under a card that ends in buttons of its own.
 */
export function openSheet(title, build, { root = false, dock = false, own = false } = {}) {
  if (root) stack.length = 0;
  const under = stack[stack.length - 1];
  if (under) under.place = $('#sheet-body').scrollTop;
  stack.push({ title, build, dock, own });
  showTop();
}

/** Draws the open panel again (its data changed), where it was scrolled to. */
export function refreshSheet() {
  if (stack.length) showTop({ keepPlace: true });
}

/** Closes the panel on top: the one under it shows again, or the Layers panel, or the chart. */
export function backSheet() {
  stack.pop();
  showTop();
}

/** The panel now on top, to check later that it still is. */
export const topSheet = () => stack[stack.length - 1] || null;

/**
 * Goes back one panel, but only if [sheet] is still the one on top: work that takes a moment
 * (saving, deleting) may finish after the person has moved on to another panel.
 */
export function backFrom(sheet) {
  if (sheet && topSheet() === sheet) backSheet();
}

/** Closes every panel and the Layers panel: back to the chart. */
export function closeSheet() {
  stack.length = 0;
  showTop();
  closeDrawer();
}

export const sheetIsOpen = () => stack.length > 0;

export function wireSheet() {
  $('#sheet-close').addEventListener('click', backSheet);
  $('#sheet-back').addEventListener('click', backSheet);
  // A tap beside the card closes it, as Close does.
  $('#sheet-layer').addEventListener('click', (event) => { if (event.target === event.currentTarget) backSheet(); });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  // While a finger is on a slider in the Layers panel the panel is not drawn again: that would take the slider away.
  $('#drawer-body').addEventListener('pointerdown', (event) => { if (event.target.matches?.('input[type="range"]')) drawerHeld = true; });
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { drawerHeld = false; });
}

// ---------------------------------------------------------------- the Layers panel

let drawerBuild = null;
let drawerHeld = false;

export const drawerIsOpen = () => !$('#drawer').hidden;

function fillDrawer() {
  const body = $('#drawer-body');
  const foot = $('#drawer-foot');
  const at = body.scrollTop;
  body.replaceChildren();
  foot.replaceChildren();
  drawerBuild?.(body, foot);
  body.scrollTop = at;
}

/** Opens the Layers panel at the left. [build] fills its body and its foot, and runs again whenever it is drawn. */
export function openDrawer(build) {
  drawerBuild = build;
  fillDrawer();
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  document.body.classList.add('drawer-open');
}

/** Draws the Layers panel again if it is open (a layer or a waypoint changed). */
export function refreshDrawer() {
  if (drawerIsOpen() && !drawerHeld) fillDrawer();
}

export function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  document.body.classList.remove('drawer-open');
}

// ---------------------------------------------------------------- rows and fields for panels

/**
 * A tappable row: a title, a line under it, and an optional value at the right. [chevron]
 * marks a row that opens something; [chosen] marks the one picked among a few.
 */
export function row(title, detail, onClick, { value = null, danger = false, id = null, chevron = false, chosen = false } = {}) {
  return el('button', { class: `row${danger ? ' danger' : ''}${chosen ? ' chosen' : ''}`, type: 'button', onclick: onClick, id },
    el('span', { class: 'row-text' },
      el('span', { class: 'row-title', text: title }),
      detail ? el('span', { class: 'row-detail', text: detail }) : null),
    value ? el('span', { class: 'row-value', text: value }) : null,
    chevron ? svg(CHEVRON, 'row-chevron') : null);
}

/** A small button with capital letters: on a tool's card, on a layer, beside a waypoint. */
export function mini(label, onClick, { id = null, accent = false, danger = false, primary = false, cls = '', title = null } = {}) {
  return el('button', {
    class: `mini${accent ? ' accent' : ''}${danger ? ' danger' : ''}${primary ? ' primary' : ''}${cls ? ` ${cls}` : ''}`,
    type: 'button', onclick: onClick, id, text: label, 'aria-label': title
  });
}

export const heading = (text) => el('div', { class: 'heading', text });
export const note = (text) => el('p', { class: 'note', text });

export function button(label, onClick, { primary = false, danger = false, go = false, id = null } = {}) {
  return el('button', {
    class: `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}${go ? ' go' : ''}`, type: 'button', onclick: onClick, id, text: label
  });
}

export function field(label, input) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
}

/** A switch with a title and a line under it. */
export function toggle(title, detail, checked, onChange, id = null) {
  const input = el('input', { type: 'checkbox', checked, id, onchange: () => onChange(input.checked) });
  return el('label', { class: 'row toggle' },
    el('span', { class: 'row-text' },
      el('span', { class: 'row-title', text: title }),
      detail ? el('span', { class: 'row-detail', text: detail }) : null),
    input);
}

/** A slider with its value shown beside the title. [format] turns the number into text. */
export function slider(title, { min, max, step, value, format, onInput, onChange, id = null }) {
  const shown = el('span', { class: 'row-value', text: format(value) });
  const input = el('input', {
    type: 'range', min, max, step, value, id,
    oninput: () => { shown.textContent = format(Number(input.value)); onInput?.(Number(input.value)); },
    onchange: () => onChange?.(Number(input.value))
  });
  return el('div', { class: 'slider' }, el('div', { class: 'slider-head' }, el('span', { class: 'row-title', text: title }), shown), input);
}

/**
 * A panel of a few choices, the one in use marked. [entries] are [id, name, detail]; picking
 * one runs [pick] and goes back to the panel it was opened from.
 */
export function chooser(title, entries, current, pick, idOf = () => null) {
  openSheet(title, (body) => {
    const here = topSheet();
    add(body, entries.map(([id, name, detail]) => row(name, detail || null, async () => {
      await pick(id);
      backFrom(here);
    }, { chosen: id === current, id: idOf(id) })));
  });
}

// ---------------------------------------------------------------- cards over everything

/**
 * A card with a title, paragraphs and buttons. Resolves with the id of the button tapped. It
 * can't be put aside without choosing unless [dismissable].
 */
export function card({ badge = null, title, subtitle = null, paragraphs = [], fine = null, actions, body = null, dismissable = false }) {
  return new Promise((resolve) => {
    const done = (id) => {
      layer.remove();
      resolve(id);
    };
    const layer = el('div', { class: 'overlay', onclick: (e) => { if (dismissable && e.target === layer) done(null); } },
      el('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
        badge ? el('div', { class: 'card-badge', text: badge }) : null,
        el('h2', { class: 'card-title', text: title }),
        subtitle ? el('p', { class: 'card-subtitle', text: subtitle }) : null,
        paragraphs.map((p) => el('p', { class: 'card-text', text: p })),
        body,
        fine ? el('p', { class: 'card-fine', text: fine }) : null,
        el('div', { class: `card-actions${actions.length > 2 ? ' three' : ''}` },
          actions.map((a) => button(a.label, () => done(a.id), { primary: a.primary, danger: a.danger, id: a.domId })))));
    document.body.append(layer);
  });
}

export const confirmCard = async (title, text, okLabel, { danger = false } = {}) =>
  (await card({
    title, paragraphs: [text], dismissable: true,
    actions: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: okLabel, primary: !danger, danger, domId: 'confirm-yes' }]
  })) === 'yes';

/**
 * Keeps the screen on during long work, where the phone allows it: a phone that locks stops
 * the app. Answers with a function that lets it sleep again.
 */
export async function holdScreenOn() {
  let lock = null;
  try {
    lock = await navigator.wakeLock?.request('screen');
  } catch { /* not allowed (low power mode, an older phone): the work still runs */ }
  return () => { lock?.release().catch(() => {}); };
}

/** A card for long work: a bar, a line of text and Cancel. [signal] aborts when Cancel is tapped. */
export function progressCard(title, hint = null) {
  const controller = new AbortController();
  const bar = el('div', { class: 'bar-fill' });
  const line = el('p', { class: 'card-text', text: 'Starting…' });
  const cancel = button('Cancel', () => {
    cancel.disabled = true;
    line.textContent = 'Stopping…';
    controller.abort();
  });
  const layer = el('div', { class: 'overlay' },
    el('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
      el('h2', { class: 'card-title', text: title }),
      el('div', { class: 'bar' }, bar),
      line,
      hint ? el('p', { class: 'card-fine', text: hint }) : null,
      el('div', { class: 'card-actions' }, cancel)));
  document.body.append(layer);
  return {
    signal: controller.signal,
    set(fraction, text) {
      if (fraction !== null) bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      if (text) line.textContent = text;
    },
    close: () => layer.remove()
  };
}

/**
 * Hands a file the app made to the phone's share sheet, or saves it as a download where there
 * is none. [done] is said after a download.
 */
export async function saveFile(file, { title = 'SeaBathy', done = `Saved ${file.name}` } = {}) {
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
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
  toast(done);
}

/** Loads one of the app's own script files once (the bigger libraries wait until they're needed). */
const loaded = new Map();

export function loadScript(path) {
  if (!loaded.has(path)) {
    loaded.set(path, new Promise((resolve, reject) => {
      const script = el('script', { src: new URL(path, document.baseURI).href });
      script.onload = resolve;
      script.onerror = () => {
        loaded.delete(path);
        reject(new Error(`Couldn't load ${path}`));
      };
      document.head.append(script);
    }));
  }
  return loaded.get(path);
}
