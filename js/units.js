// The units depths and speeds are shown in. Everything is kept in metres and knots; only what
// is shown changes.

import { setting } from './db.js';

export const DEPTHS = {
  m: { label: 'm', name: 'Metres', perMetre: 1 },
  ft: { label: 'ft', name: 'Feet', perMetre: 3.28084 },
  fm: { label: 'fm', name: 'Fathoms', perMetre: 0.546807 }
};
export const SPEEDS = {
  kn: { label: 'kn', name: 'Knots', perKnot: 1 },
  kmh: { label: 'km/h', name: 'Kilometres an hour', perKnot: 1.852 },
  mph: { label: 'mph', name: 'Miles an hour', perKnot: 1.15078 }
};

/** How a position is written. */
export const POSITIONS = {
  ddm: { name: 'Degrees and minutes', example: '20°17.123′S' },
  dms: { name: 'Degrees, minutes and seconds', example: '20°17′07.4″S' },
  dd: { name: 'Decimal degrees', example: '20.28538°S' }
};

export const state = { depth: 'm', speed: 'kn', position: 'ddm' };
const listeners = new Set();

export const depthUnit = () => DEPTHS[state.depth] || DEPTHS.m;
export const speedUnit = () => SPEEDS[state.speed] || SPEEDS.kn;

/** A depth or a height above the water, from metres (negative under water). */
export function depthText(metres) {
  const unit = depthUnit();
  const value = Math.abs(metres) * unit.perMetre;
  const text = `${value.toFixed(value < 100 ? 1 : 0)} ${unit.label}`;
  return metres > 0 ? `${text} above the water` : text;
}

function angle(value, positive, negative, width) {
  const hemisphere = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  if (state.position === 'dd') return `${abs.toFixed(5)}°${hemisphere}`;
  let degrees = Math.floor(abs);
  let minutes = (abs - degrees) * 60;
  if (state.position === 'dms') {
    let whole = Math.floor(minutes);
    let seconds = (minutes - whole) * 60;
    if (seconds >= 59.95) { seconds = 0; whole += 1; }
    if (whole >= 60) { whole = 0; degrees += 1; }
    return `${String(degrees).padStart(width, '0')}°${String(whole).padStart(2, '0')}′${seconds.toFixed(1).padStart(4, '0')}″${hemisphere}`;
  }
  if (minutes >= 59.9995) { degrees += 1; minutes = 0; }
  return `${String(degrees).padStart(width, '0')}°${minutes.toFixed(3).padStart(6, '0')}′${hemisphere}`;
}

/** A position as on a plotter, "20°17.123′S 148°57.456′E", or in the form chosen in Settings. */
export const positionText = (lat, lng) => `${angle(lat, 'N', 'S', 2)} ${angle(lng, 'E', 'W', 3)}`;

/** One angle as typed: "-20.25", "20 15.5 S", "20°15'30\"S". Null when it makes no sense. */
export function parseAngle(text, limit) {
  const clean = String(text).trim().toUpperCase();
  const numbers = clean.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length > 3) return null;
  const [d, m = 0, s = 0] = numbers.map(Number);
  if (m >= 60 || s >= 60) return null;
  const value = d + m / 60 + s / 3600;
  if (value > limit) return null;
  const negative = /^-/.test(clean) || /[SW]/.test(clean);
  return negative ? -value : value;
}

/**
 * A position as typed, latitude first, in any of the forms the app writes or as plain numbers:
 * "20°15.300′S 149°06.000′E", "S 20 15.3 E 149 6", "-20.255, 149.1". Null when it doesn't read as one.
 */
export function parsePosition(text) {
  const clean = String(text).trim().toUpperCase().replace(/[,;]/g, ' ');
  let parts;
  if (/^[NS]/.test(clean)) {
    // The letters come first: the longitude starts at its E or W.
    const second = clean.search(/[EW]/);
    if (second < 0) return null;
    parts = [clean.slice(0, second), clean.slice(second)];
  } else if (/[NS]/.test(clean)) {
    const cut = clean.search(/[NS]/) + 1;
    parts = [clean.slice(0, cut), clean.slice(cut)];
  } else {
    // No letters: two, four or six numbers, half for each.
    const numbers = clean.match(/-?\d+(?:\.\d+)?/g) || [];
    if (![2, 4, 6].includes(numbers.length)) return null;
    parts = [numbers.slice(0, numbers.length / 2).join(' '), numbers.slice(numbers.length / 2).join(' ')];
  }
  if (!/\d/.test(parts[0]) || !/\d/.test(parts[1])) return null;
  const lat = parseAngle(parts[0], 90);
  const lng = parseAngle(parts[1], 180);
  return lat === null || lng === null ? null : { lat, lng };
}

/** A speed, from knots. */
export const speedText = (knots) => `${(knots * speedUnit().perKnot).toFixed(1)} ${speedUnit().label}`;

/** Has [fn] called whenever the units change. */
export function onChange(fn) {
  listeners.add(fn);
}

export async function set(change) {
  Object.assign(state, change);
  await setting.set('units', { ...state }).catch(() => {});
  for (const fn of listeners) fn();
}

export async function start() {
  Object.assign(state, await setting.get('units', {}));
}
