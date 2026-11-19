// Small pieces every screen uses: building elements, the bottom sheet, cards with buttons, the
// progress card and the short message at the foot of the screen. Text from files and from the
// user is always put in as text, never as HTML.

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

// ---------------------------------------------------------------- the message at the foot

let toastTimer = 0;

export function toast(text, ms = 3800) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

// ---------------------------------------------------------------- the bottom sheet

const stack = [];

function showTop() {
  const sheet = $('#sheet');
  const top = stack[stack.length - 1];
  if (!top) {
    sheet.hidden = true;
    document.body.classList.remove('sheet-open');
    return;
  }
  $('#sheet-title').textContent = top.title;
  $('#sheet-back').hidden = stack.length < 2;
  const body = $('#sheet-body');
  body.replaceChildren();
  body.scrollTop = 0;
  top.build(body);
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
}

/** Opens a panel over the map. [build] fills its body; it runs again whenever the panel is shown. */
export function openSheet(title, build, { root = false } = {}) {
  if (root) stack.length = 0;
  stack.push({ title, build });
  showTop();
}

/** Draws the open panel again (its data changed). */
export function refreshSheet() {
  if (stack.length) showTop();
}

export function backSheet() {
  stack.pop();
  showTop();
}

export function closeSheet() {
  stack.length = 0;
  showTop();
}

export const sheetIsOpen = () => stack.length > 0;

export function wireSheet() {
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-back').addEventListener('click', backSheet);
}

// ---------------------------------------------------------------- rows and fields for panels

/** A tappable row: a title, a line under it, and an optional value at the right. */
export function row(title, detail, onClick, { value = null, danger = false, id = null } = {}) {
  return el('button', { class: `row${danger ? ' danger' : ''}`, type: 'button', onclick: onClick, id },
    el('span', { class: 'row-text' },
      el('span', { class: 'row-title', text: title }),
      detail ? el('span', { class: 'row-detail', text: detail }) : null),
    value ? el('span', { class: 'row-value', text: value }) : null);
}

export const heading = (text) => el('div', { class: 'heading', text });
export const note = (text) => el('p', { class: 'note', text });

export function button(label, onClick, { primary = false, danger = false, id = null } = {}) {
  return el('button', {
    class: `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, type: 'button', onclick: onClick, id, text: label
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
        el('div', { class: 'card-actions' },
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
