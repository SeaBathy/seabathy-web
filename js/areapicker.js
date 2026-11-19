// Picking an area on the chart, the way the Android app does it. It starts empty: one finger
// (or the mouse) dragged across the chart draws a box. After that a drag inside the box moves
// it, a drag from a corner resizes it, and a drag outside it draws a new one. Two fingers still
// move and zoom the chart, and the box stays on its place as the chart moves. A bar at the foot
// shows the box's size and what it means (the download, say), with Cancel and the confirm
// button. A box that is too big is drawn in red and can't be confirmed.

import { el, button, hideToast } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
const HANDLE_RADIUS = 9;
/** A touch this near a corner takes hold of it. */
const GRAB_RADIUS = 36;
/** A box smaller than this each way is taken as a slip of the finger. */
const MIN_SIDE = 24;
const DRAW_SLOP = 10;
const RESIZE_SLOP = 4;
/** A mouse press this soon after a touch is the browser's echo of that touch. */
const TOUCH_ECHO_MS = 800;

export const widthKm = (box) => (box.east - box.west) * 111.32 * Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
export const heightKm = (box) => (box.north - box.south) * 110.57;
const km = (value) => (value < 10 ? `${value.toFixed(1)} km` : `${Math.round(value)} km`);

/** Closes the picker now open, if there is one. */
let closeOpen = null;
export const isPicking = () => closeOpen !== null;

function shape(tag, cls) {
  const node = document.createElementNS(SVG, tag);
  node.setAttribute('class', cls);
  return node;
}

/**
 * Lets the person draw an area on [map]. Resolves with { south, west, north, east } in
 * degrees, or null when they cancel.
 *
 * [maxKm] and [maxDegrees] are the most the area may span either way. [describe] is given the
 * box and answers with a line about it, or { text, ok } where ok false keeps the confirm
 * button off; it may answer later (a promise).
 */
export function pickArea(map, { title, maxKm, maxDegrees = Infinity, confirmLabel = 'Get depths', describe = () => '' }) {
  closeOpen?.();
  return new Promise((resolve) => {
    const holder = map.getContainer();
    const finger = matchMedia('(pointer: coarse)').matches;
    /** The area chosen so far, in degrees. */
    let box = null;
    /** The rectangle under the finger while it moves, in screen pixels. */
    let drag = null;
    let mode = 'draw';
    let start = null;
    /** The corner that stays put while resizing. */
    let anchor = null;
    /** The box as it was when a move started. */
    let moveFrom = null;
    /** Two fingers are down: the gesture is the chart's until every finger is up. */
    let chartsGesture = false;
    let lastTouch = 0;
    let mouseDown = false;
    let asked = 0;

    // ---- the picture over the chart
    const picture = shape('svg', 'area-pick');
    const shade = shape('path', 'area-shade');
    const edge = shape('rect', 'area-edge');
    const handles = [0, 1, 2, 3].map(() => shape('circle', 'area-handle'));
    handles.forEach((h) => h.setAttribute('r', HANDLE_RADIUS));
    picture.append(shade, edge, ...handles);
    holder.append(picture);

    // ---- the bar at the foot
    const sizeText = el('div', { class: 'area-size', id: 'area-size' });
    const infoText = el('div', { class: 'area-info', id: 'area-info' });
    const hintText = el('div', { class: 'area-hint', text: 'Drag the box to move it, or a corner to resize it.' });
    const confirm = button(confirmLabel, () => finish(box), { primary: true, id: 'area-go' });
    const bar = el('div', { class: 'area-bar', id: 'area-bar', role: 'dialog', 'aria-label': 'Choose the area' },
      el('div', { class: 'area-title', text: title }), sizeText, infoText, hintText,
      el('div', { class: 'card-actions' }, button('Cancel', () => finish(null), { id: 'area-cancel' }), confirm));
    document.body.append(bar);
    document.body.classList.add('picking');
    // An earlier message would lie over the bar's buttons.
    hideToast();

    const tooBig = (b) => Math.max(widthKm(b), heightKm(b)) > maxKm || Math.max(b.north - b.south, b.east - b.west) > maxDegrees;

    function screenRect(b) {
      const a = map.project([b.west, b.north]);
      const c = map.project([b.east, b.south]);
      return { left: Math.min(a.x, c.x), top: Math.min(a.y, c.y), right: Math.max(a.x, c.x), bottom: Math.max(a.y, c.y) };
    }

    function toBox(r) {
      const a = map.unproject([r.left, r.top]);
      const c = map.unproject([r.right, r.bottom]);
      return { south: Math.min(a.lat, c.lat), west: Math.min(a.lng, c.lng), north: Math.max(a.lat, c.lat), east: Math.max(a.lng, c.lng) };
    }

    const rectOf = (a, p) => ({ left: Math.min(a.x, p.x), top: Math.min(a.y, p.y), right: Math.max(a.x, p.x), bottom: Math.max(a.y, p.y) });
    const corners = (r) => [{ x: r.left, y: r.top }, { x: r.right, y: r.top }, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }];

    function draw() {
      const w = holder.clientWidth;
      const h = holder.clientHeight;
      const r = drag || (box && screenRect(box));
      const whole = `M0 0H${w}V${h}H0Z`;
      if (!r) {
        shade.setAttribute('d', whole);
        edge.style.display = 'none';
        handles.forEach((handle) => { handle.style.display = 'none'; });
        return;
      }
      // Darker outside the box, so it stands out.
      shade.setAttribute('d', `${whole}M${r.left} ${r.top}V${r.bottom}H${r.right}V${r.top}Z`);
      edge.style.display = '';
      edge.setAttribute('x', r.left);
      edge.setAttribute('y', r.top);
      edge.setAttribute('width', Math.max(0, r.right - r.left));
      edge.setAttribute('height', Math.max(0, r.bottom - r.top));
      edge.classList.toggle('drawing', Boolean(drag) && mode === 'draw');
      picture.classList.toggle('too-big', tooBig(drag ? toBox(drag) : box));
      corners(r).forEach((corner, i) => {
        handles[i].style.display = '';
        handles[i].setAttribute('cx', corner.x);
        handles[i].setAttribute('cy', corner.y);
      });
    }

    const showSize = (b) => { sizeText.textContent = `${km(widthKm(b))} × ${km(heightKm(b))}`; };
    const enable = (on) => { confirm.disabled = !on; };

    function setBox(b) {
      box = b;
      draw();
      const mine = ++asked;
      if (!b) {
        sizeText.textContent = finger ? 'Drag a finger across the chart to draw the area' : 'Drag across the chart to draw the area';
        infoText.textContent = `Up to about ${maxKm} km across. ${finger ? 'Two fingers move and zoom the chart.' : 'Scroll to zoom the chart; the arrow keys move it.'}`;
        hintText.hidden = true;
        enable(false);
        return;
      }
      hintText.hidden = false;
      showSize(b);
      if (tooBig(b)) {
        infoText.textContent = `Too big: up to about ${maxKm} km across. Make the box smaller.`;
        enable(false);
        return;
      }
      infoText.textContent = 'Working out the download…';
      enable(false);
      Promise.resolve().then(() => describe(b)).then(
        (said) => {
          if (mine !== asked) return;
          const answer = typeof said === 'string' ? { text: said } : said || {};
          infoText.textContent = answer.text || '';
          enable(answer.ok !== false);
        },
        () => {
          if (mine !== asked) return;
          infoText.textContent = '';
          enable(true);
        });
    }

    // ---- one finger or the mouse: draw, move or resize

    const at = (clientX, clientY) => {
      const b = holder.getBoundingClientRect();
      return { x: clientX - b.left, y: clientY - b.top };
    };

    /** What a press at [p] does: takes hold of a corner, moves the box, or draws a new one. */
    function begin(p) {
      start = p;
      drag = null;
      mode = 'draw';
      anchor = null;
      moveFrom = null;
      const r = box && screenRect(box);
      if (!r) return;
      const near = corners(r).reduce((best, c) => (Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? c : best));
      if (Math.hypot(near.x - p.x, near.y - p.y) <= GRAB_RADIUS) {
        mode = 'resize';
        anchor = { x: near.x === r.left ? r.right : r.left, y: near.y === r.top ? r.bottom : r.top };
      } else if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
        mode = 'move';
        moveFrom = r;
      }
    }

    function move(p) {
      if (!start) return;
      if (!drag && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) <= (mode === 'resize' ? RESIZE_SLOP : DRAW_SLOP)) return;
      if (mode === 'move') {
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        drag = { left: moveFrom.left + dx, top: moveFrom.top + dy, right: moveFrom.right + dx, bottom: moveFrom.bottom + dy };
      } else {
        drag = rectOf(mode === 'resize' ? anchor : start, p);
      }
      showSize(toBox(drag));
      draw();
    }

    function leaveAsItWas() {
      drag = null;
      start = null;
      if (box) showSize(box);
      draw();
    }

    function end() {
      const r = drag;
      if (r && r.right - r.left > MIN_SIDE && r.bottom - r.top > MIN_SIDE) {
        drag = null;
        start = null;
        setBox(toBox(r));
      } else {
        leaveAsItWas();
      }
    }

    // These listen on the chart's holder on the way down, ahead of the chart's own: a gesture
    // taken here is stopped before the chart sees it, and anything else is let through.

    const touchStart = (event) => {
      lastTouch = Date.now();
      if (chartsGesture) return;
      if (event.touches.length > 1) {
        leaveAsItWas();
        chartsGesture = true;
        return;
      }
      event.stopPropagation();
      begin(at(event.touches[0].clientX, event.touches[0].clientY));
    };
    const touchMove = (event) => {
      if (chartsGesture) return;
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      if (event.touches[0]) move(at(event.touches[0].clientX, event.touches[0].clientY));
    };
    const touchEnd = (event) => {
      lastTouch = Date.now();
      if (chartsGesture) {
        if (event.touches.length === 0) chartsGesture = false;
        return;
      }
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      if (event.type === 'touchcancel') leaveAsItWas();
      else end();
    };
    const mousePress = (event) => {
      if (event.button !== 0 || Date.now() - lastTouch < TOUCH_ECHO_MS) return;
      event.stopPropagation();
      event.preventDefault();
      mouseDown = true;
      begin(at(event.clientX, event.clientY));
    };
    const mouseMove = (event) => { if (mouseDown) move(at(event.clientX, event.clientY)); };
    const mouseUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      end();
    };
    // A right-click adds a waypoint on the chart: not while an area is being drawn.
    const noMenu = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    const keys = (event) => { if (event.key === 'Escape') finish(null); };

    const taken = { capture: true, passive: false };
    holder.addEventListener('touchstart', touchStart, taken);
    holder.addEventListener('touchmove', touchMove, taken);
    holder.addEventListener('touchend', touchEnd, taken);
    holder.addEventListener('touchcancel', touchEnd, taken);
    holder.addEventListener('mousedown', mousePress, taken);
    holder.addEventListener('contextmenu', noMenu, taken);
    document.addEventListener('mousemove', mouseMove, true);
    document.addEventListener('mouseup', mouseUp, true);
    document.addEventListener('keydown', keys);
    map.on('move', draw);
    map.on('resize', draw);

    function finish(result) {
      holder.removeEventListener('touchstart', touchStart, taken);
      holder.removeEventListener('touchmove', touchMove, taken);
      holder.removeEventListener('touchend', touchEnd, taken);
      holder.removeEventListener('touchcancel', touchEnd, taken);
      holder.removeEventListener('mousedown', mousePress, taken);
      holder.removeEventListener('contextmenu', noMenu, taken);
      document.removeEventListener('mousemove', mouseMove, true);
      document.removeEventListener('mouseup', mouseUp, true);
      document.removeEventListener('keydown', keys);
      map.off('move', draw);
      map.off('resize', draw);
      picture.remove();
      bar.remove();
      document.body.classList.remove('picking');
      closeOpen = null;
      resolve(result);
    }

    closeOpen = () => finish(null);
    setBox(null);
  });
}
