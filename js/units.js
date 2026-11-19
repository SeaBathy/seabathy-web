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

export const state = { depth: 'm', speed: 'kn' };
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
