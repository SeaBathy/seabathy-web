// Waypoints to and from GPX 1.1: the backup, and the way to move marks between this app, the
// Android and Desktop apps, a chartplotter or any other program. Pure functions.

const COLOUR_NS = 'https://seabathy.com/gpx/1';

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Control characters XML doesn't allow.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** A plain decimal, never 1e-7: GPX readers reject the scientific form. */
export function decimal(value) {
  const text = Number(value).toFixed(7).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** A GPX document of [waypoints] ({name, lat, lng, desc, icon, color}) and [routes] ({name, points}). */
export function buildGpx(waypoints, routes = []) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SeaBathy" xmlns="http://www.topografix.com/GPX/1/1" ' +
      `xmlns:sb="${COLOUR_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">'
  ];
  for (const w of waypoints) {
    let line = `  <wpt lat="${decimal(w.lat)}" lon="${decimal(w.lng)}"><name>${escapeXml(w.name || '')}</name>`;
    if (w.desc && w.desc.trim()) line += `<desc>${escapeXml(w.desc)}</desc>`;
    if (w.icon) line += `<sym>${escapeXml(w.icon)}</sym>`;
    if (w.color) line += `<extensions><sb:color>${escapeXml(w.color)}</sb:color></extensions>`;
    out.push(`${line}</wpt>`);
  }
  for (const route of routes) {
    out.push(`  <rte><name>${escapeXml(route.name || '')}</name>`);
    for (const p of route.points) {
      out.push(`    <rtept lat="${decimal(p.lat)}" lon="${decimal(p.lng)}">${p.name ? `<name>${escapeXml(p.name)}</name>` : ''}</rtept>`);
    }
    out.push('  </rte>');
  }
  out.push('</gpx>', '');
  return out.join('\n');
}

const childrenNamed = (node, name) => [...node.children].filter((c) => c.localName === name);

function childText(node, name) {
  const text = childrenNamed(node, name)[0]?.textContent?.trim();
  return text || null;
}

/**
 * The waypoints and routes in a GPX 1.0 or 1.1 file, and how many tracks it also holds (those
 * aren't brought in). Throws with a plain message when the file isn't GPX.
 */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || root.localName !== 'gpx') {
    throw new Error("This file isn't GPX");
  }
  const waypoints = [];
  for (const wpt of childrenNamed(root, 'wpt')) {
    const lat = Number(wpt.getAttribute('lat'));
    const lng = Number(wpt.getAttribute('lon'));
    if (!wpt.hasAttribute('lat') || !wpt.hasAttribute('lon')) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const colour = wpt.getElementsByTagNameNS(COLOUR_NS, 'color')[0]?.textContent?.trim();
    waypoints.push({
      name: childText(wpt, 'name') || '',
      desc: childText(wpt, 'desc') || childText(wpt, 'cmt'),
      lat,
      lng,
      icon: childText(wpt, 'sym'),
      color: colour && /^#[0-9a-f]{6}$/i.test(colour) ? colour.toUpperCase() : null
    });
  }
  const routes = [];
  for (const rte of childrenNamed(root, 'rte')) {
    const points = [];
    for (const pt of childrenNamed(rte, 'rtept')) {
      const lat = Number(pt.getAttribute('lat'));
      const lng = Number(pt.getAttribute('lon'));
      if (!pt.hasAttribute('lat') || !pt.hasAttribute('lon') || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const name = childText(pt, 'name');
      points.push(name ? { lat, lng, name } : { lat, lng });
    }
    if (points.length > 1) routes.push({ name: childText(rte, 'name') || '', points });
  }
  return { waypoints, routes, tracks: childrenNamed(root, 'trk').length };
}
