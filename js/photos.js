// Photos kept with waypoints, as in the Android app. A photo is made upright and at most 1600
// pixels across, then kept on the device in a small database of its own. Nothing is uploaded.
// The place and time a photo was taken are read from the file itself, when it carries them.

const DB_NAME = 'seabathy-photos';
const STORE = 'photos';
export const MAX_PX = 1600;
const QUALITY = 0.85;
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(request.error); };
    });
  }
  return opening;
}

async function run(mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The save was stopped'));
    const request = work(tx.objectStore(STORE));
    if (request) request.onsuccess = () => { result = request.result; };
  });
}

/** A photo's bytes (a JPEG), or undefined when it is not here. */
export const get = (id) => run('readonly', (store) => store.get(id));
/** Keeps a photo's bytes under [id]. */
export const put = (id, bytes) => run('readwrite', (store) => { store.put(bytes, id); });
/** How many photos are kept. */
export const count = () => run('readonly', (store) => store.count());

const urls = new Map();

/** An address the page can show a kept photo from, or null when the photo is not here. */
export async function url(id) {
  if (urls.has(id)) return urls.get(id);
  const bytes = await get(id);
  if (!bytes) return null;
  const made = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  urls.set(id, made);
  return made;
}

export async function remove(id) {
  const made = urls.get(id);
  if (made) URL.revokeObjectURL(made);
  urls.delete(id);
  await run('readwrite', (store) => { store.delete(id); });
}

// ---------------------------------------------------------------- what a photo says about itself

const ascii = (view, at, length) => {
  let out = '';
  for (let i = 0; i < length && at + i < view.byteLength; i++) {
    const code = view.getUint8(at + i);
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return out;
};

/** The tags of one directory of a photo's notes: tag number to { type, count, at }. */
function directory(view, base, offset, little) {
  const tags = new Map();
  const start = base + offset;
  if (start + 2 > view.byteLength) return tags;
  const entries = view.getUint16(start, little);
  for (let i = 0; i < entries; i++) {
    const entry = start + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const type = view.getUint16(entry + 2, little);
    const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8][type] || 1;
    const length = view.getUint32(entry + 4, little);
    // A value of up to four bytes sits in the entry itself; a longer one is pointed to.
    const at = size * length <= 4 ? entry + 8 : base + view.getUint32(entry + 8, little);
    tags.set(view.getUint16(entry, little), { type, count: length, at });
  }
  return tags;
}

const fraction = (view, at, little) => {
  if (at + 8 > view.byteLength) return NaN;
  const below = view.getUint32(at + 4, little);
  return below ? view.getUint32(at, little) / below : NaN;
};

/** Degrees from the three fractions a photo holds (degrees, minutes, seconds). */
function degrees(view, tag, little) {
  if (!tag || tag.count < 3) return NaN;
  return fraction(view, tag.at, little) + fraction(view, tag.at + 8, little) / 60 + fraction(view, tag.at + 16, little) / 3600;
}

/** "2026:06:01 13:04:05" with a zone such as "+10:00" (or none: the device's own) as a time. */
function clockTime(text, zone) {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(text || '');
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const z = /^([+-])(\d\d):(\d\d)/.exec(zone || '');
  if (z) return Date.UTC(year, month - 1, day, hour, minute, second) - (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60000;
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * Where and when a JPEG photo was taken, from the notes the camera wrote in it:
 * { lat, lng, taken }, each null when the photo does not say.
 */
export function readExif(buffer) {
  const none = { lat: null, lng: null, taken: null };
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return none;
    let at = 2;
    while (at + 4 <= view.byteLength) {
      if (view.getUint8(at) !== 0xff) break;
      const marker = view.getUint8(at + 1);
      const length = view.getUint16(at + 2);
      // The picture itself starts here: the notes come before it.
      if (marker === 0xda) break;
      if (marker === 0xe1 && ascii(view, at + 4, 4) === 'Exif') {
        const base = at + 10;
        const little = view.getUint16(base) === 0x4949;
        const first = directory(view, base, view.getUint32(base + 4, little), little);
        const camera = first.has(0x8769) ? directory(view, base, view.getUint32(first.get(0x8769).at, little), little) : new Map();
        const gps = first.has(0x8825) ? directory(view, base, view.getUint32(first.get(0x8825).at, little), little) : new Map();
        let lat = degrees(view, gps.get(2), little);
        let lng = degrees(view, gps.get(4), little);
        if (gps.has(1) && ascii(view, gps.get(1).at, 1) === 'S') lat = -lat;
        if (gps.has(3) && ascii(view, gps.get(3).at, 1) === 'W') lng = -lng;
        const placed = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
        // The satellites' own clock when the photo has it, else the camera's.
        let taken = null;
        if (gps.has(29) && gps.has(7) && gps.get(7).count >= 3) {
          const day = /^(\d{4}):(\d\d):(\d\d)/.exec(ascii(view, gps.get(29).at, gps.get(29).count));
          const [h, m, s] = [0, 8, 16].map((step) => fraction(view, gps.get(7).at + step, little));
          if (day && [h, m, s].every(Number.isFinite)) taken = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), h, m, Math.floor(s));
        }
        if (taken === null) {
          const when = camera.get(0x9003) || first.get(0x0132);
          const zone = camera.get(0x9011);
          if (when) taken = clockTime(ascii(view, when.at, when.count), zone ? ascii(view, zone.at, zone.count) : '');
        }
        return { lat: placed ? lat : null, lng: placed ? lng : null, taken: Number.isFinite(taken) ? taken : null };
      }
      at += 2 + length;
    }
  } catch { /* notes that don't read: the photo is still a photo */ }
  return none;
}

// ---------------------------------------------------------------- taking one in

/** The picture as the browser shows it: upright, whatever way up the camera was held. */
function picture(file) {
  return new Promise((resolve, reject) => {
    const address = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(address);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(address);
      reject(new Error("Couldn't read that photo"));
    };
    image.src = address;
  });
}

/** The photo as a JPEG at most [MAX_PX] across: { bytes, width, height }. */
export async function shrink(file) {
  const image = await picture(file);
  const scale = Math.min(1, MAX_PX / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error("Couldn't save the photo");
  return { bytes: await blob.arrayBuffer(), width: canvas.width, height: canvas.height };
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * Takes a photo in: shrinks it, keeps it, and answers with what a waypoint remembers of it,
 * { id, taken, bytes }, and with where it was taken ({ lat, lng }, null when it doesn't say).
 */
export async function add(file) {
  const said = readExif(await file.arrayBuffer());
  const small = await shrink(file);
  const id = newId();
  await put(id, small.bytes);
  return { photo: { id, taken: said.taken ?? (file.lastModified || Date.now()), bytes: small.bytes.byteLength }, lat: said.lat, lng: said.lng };
}

// ---------------------------------------------------------------- in and out of a backup

/** A kept photo as text for a backup file, or null when it is not here. */
export async function toText(id) {
  const bytes = await get(id);
  if (!bytes) return null;
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Keeps a photo from a backup file's text under a new id, and answers with the id. */
export async function fromText(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a photo');
  const id = newId();
  await put(id, bytes.buffer);
  return { id, bytes: bytes.length };
}
