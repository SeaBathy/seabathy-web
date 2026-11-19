// A backup in one file: the waypoints, the saved routes and the settings. Depth layers and saved
// map areas are left out: they are big and can be downloaded again. The file is made and read
// here on the device and goes nowhere by itself: the person saves it or shares it.
//
// This is the web app's own file. Waypoints and routes move to and from the Android and Windows
// apps as GPX.

import * as db from './db.js';
import * as waypoints from './waypoints.js';
import * as routes from './routes.js';
import { saveFile } from './ui.js';

export const FORMAT = 1;
const APP = 'SeaBathy web app';
/** The settings worth carrying to another device: choices, not this device's own state. */
const SETTINGS = ['units', 'places', 'basemap', 'customUrl', 'customCredit', 'satellite', 'waypointNames', 'updates', 'cruiseKnots', 'night', 'crosshairDepth'];

export async function build(version) {
  const settings = {};
  for (const name of SETTINGS) {
    const value = await db.setting.get(name, undefined);
    if (value !== undefined && value !== null) settings[name] = value;
  }
  return {
    app: APP, format: FORMAT, version, created: new Date().toISOString(),
    waypoints: waypoints.list().map(({ id, name, lat, lng, color, desc, icon, created }) => ({ id, name, lat, lng, color, desc, icon, created })),
    routes: routes.list().map(({ id, name, points, created }) => ({ id, name, points, created })),
    settings
  };
}

/** Makes the backup and hands it to the share sheet, or saves it as a download. */
export async function save(version) {
  const backup = await build(version);
  const stamp = backup.created.slice(0, 10);
  const file = new File([JSON.stringify(backup, null, 1)], `seabathy-backup-${stamp}.json`, { type: 'application/json' });
  await saveFile(file, {
    title: 'SeaBathy backup',
    done: `Saved ${backup.waypoints.length} waypoint${backup.waypoints.length === 1 ? '' : 's'} and ${backup.routes.length} route${backup.routes.length === 1 ? '' : 's'} as ${file.name}`
  });
  return backup;
}

/** What a backup file holds, or a thrown error with a plain message when it isn't one. */
export function read(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("This file isn't a SeaBathy backup");
  }
  if (!backup || backup.app !== APP || !Array.isArray(backup.waypoints)) throw new Error("This file isn't a SeaBathy web app backup");
  if (backup.format > FORMAT) throw new Error('This backup was made by a newer version of SeaBathy. Update the app, then try again.');
  return backup;
}

/**
 * Adds what a backup holds to what is here: waypoints and routes that are not already here,
 * and, when [withSettings], its settings in place of this device's. Answers what was done.
 */
export async function restore(backup, { withSettings = false } = {}) {
  const marks = await waypoints.addAll(backup.waypoints);
  const kept = await routes.addAll(Array.isArray(backup.routes) ? backup.routes : []);
  let settings = 0;
  if (withSettings && backup.settings && typeof backup.settings === 'object') {
    for (const name of SETTINGS) {
      if (!(name in backup.settings)) continue;
      await db.setting.set(name, backup.settings[name]);
      settings++;
    }
  }
  return { waypoints: marks.added, already: marks.skipped, routes: kept, settings };
}
