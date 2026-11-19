// The boat on the chart, from the phone's own location. It works while the app is open and on
// screen: a web app gets no position once the phone is locked or another app is in front.
// Tap the button to turn it on and follow the boat; pan the chart to look elsewhere; tap again
// to come back to the boat; tap once more to turn it off.

import { Marker } from '../vendor/maplibre-gl.js';
import { el, toast } from './ui.js';

const MS_TO_KNOTS = 1.943844;
const EMPTY = { type: 'FeatureCollection', features: [] };

let map = null;
let watchId = null;
let following = false;
let marker = null;
let arrow = null;
let last = null;
let wakeLock = null;

export const isOn = () => watchId !== null;
export const lastFix = () => last;

/** The accuracy circle as a shape on the chart: [radius] metres round the position. */
function circle(lng, lat, radius) {
  const ring = [];
  const dLat = radius / 110574;
  const dLng = radius / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Adds the accuracy circle's layers: at start, and again after each change of basemap. */
export function installLayers() {
  if (!map.getSource('sb-gps')) map.addSource('sb-gps', { type: 'geojson', data: EMPTY });
  // Over everything else on the chart: added last, with nothing named to go under.
  if (!map.getLayer('sb-gps-fill')) {
    map.addLayer({ id: 'sb-gps-fill', type: 'fill', source: 'sb-gps', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'sb-gps-line', type: 'line', source: 'sb-gps', paint: { 'line-color': '#38bdf8', 'line-opacity': 0.5, 'line-width': 1 } });
  }
  if (last) show(last);
}

function show(position) {
  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  map.getSource('sb-gps')?.setData(accuracy > 8 ? { type: 'FeatureCollection', features: [circle(longitude, latitude, accuracy)] } : EMPTY);
  if (!marker) {
    arrow = el('div', { class: 'boat-arrow' });
    marker = new Marker({ element: el('div', { class: 'boat', id: 'boat' }, arrow, el('div', { class: 'boat-dot' })) }).setLngLat([longitude, latitude]).addTo(map);
  } else {
    marker.setLngLat([longitude, latitude]);
  }
  // A course only means something while the boat is moving.
  const under = Number.isFinite(speed) && speed > 0.5 && Number.isFinite(heading);
  arrow.hidden = !under;
  if (under) arrow.style.transform = `rotate(${heading}deg)`;
  const knots = Number.isFinite(speed) ? `${(speed * MS_TO_KNOTS).toFixed(1)} kn` : '– kn';
  const course = under ? ` · ${String(Math.round(heading) % 360).padStart(3, '0')}°` : '';
  const hud = document.getElementById('gps-hud');
  hud.textContent = `${knots}${course} · ±${Math.round(accuracy)} m`;
  hud.hidden = false;
}

function onFix(position) {
  const first = !last;
  last = position;
  show(position);
  if (following) {
    const center = [position.coords.longitude, position.coords.latitude];
    if (first) map.jumpTo({ center, zoom: Math.max(map.getZoom(), position.coords.accuracy > 500 ? 11 : 14) });
    else map.easeTo({ center, duration: 600 });
  }
}

function onError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    stop();
    toast("Location is blocked for this app. Allow it when the phone asks, or turn it on in the phone's Settings under Privacy & Security, Location Services.", 7000);
  } else if (!last) {
    toast('Waiting for a position: GPS needs a view of the sky.');
  }
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* the phone said no (low power mode): the screen dims as usual */ }
}

function paintButton() {
  const button = document.getElementById('btn-gps');
  button.classList.toggle('on', isOn());
  button.classList.toggle('follow', isOn() && following);
  button.setAttribute('aria-label', !isOn() ? 'Turn GPS on' : following ? 'Turn GPS off' : 'Back to the boat');
}

function start() {
  if (!('geolocation' in navigator)) {
    toast("This browser doesn't give the app a location.");
    return;
  }
  following = true;
  watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  keepAwake(true);
  paintButton();
}

function stop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  following = false;
  last = null;
  marker?.remove();
  marker = null;
  map.getSource('sb-gps')?.setData(EMPTY);
  document.getElementById('gps-hud').hidden = true;
  keepAwake(false);
  paintButton();
}

/** The GPS button: on and following, back to the boat, or off. */
export function tap() {
  if (!isOn()) start();
  else if (!following) {
    following = true;
    if (last) {
      map.easeTo({ center: [last.coords.longitude, last.coords.latitude], duration: 500 });
    }
    paintButton();
  } else stop();
}

export function begin(theMap) {
  map = theMap;
  // A finger moving the chart lets go of the boat; the app's own moves don't.
  map.on('movestart', (event) => {
    if (!following || !event.originalEvent) return;
    following = false;
    paintButton();
  });
  // The phone drops the screen lock when the app goes to the background: taken again on return.
  document.addEventListener('visibilitychange', () => { if (isOn() && document.visibilityState === 'visible') keepAwake(true); });
  document.getElementById('btn-gps').addEventListener('click', tap);
  paintButton();
}
