// The app's small database (IndexedDB): settings, waypoints, the list of charts, saved offline
// areas and their map tiles. Everything stays on the device.

const DB_NAME = 'seabathy';
const DB_VERSION = 1;
const STORES = ['kv', 'waypoints', 'charts', 'packs', 'tiles'];
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          if (name === 'kv' || name === 'tiles') db.createObjectStore(name);
          else db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the database: let go of it so it isn't blocked.
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => { opening = null; reject(request.error); };
    });
  }
  return opening;
}

/** Runs [work] in one transaction and resolves once the transaction is saved. */
async function run(store, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The save was stopped'));
    work(tx.objectStore(store));
  });
}

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function get(store, key) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}

export async function all(store) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}

export const put = (store, value, key) => run(store, 'readwrite', (s) => { s.put(value, key); });
export const remove = (store, key) => run(store, 'readwrite', (s) => { s.delete(key); });

/** Settings: small values by name. */
export const setting = {
  get: async (name, fallback = null) => {
    const value = await get('kv', name);
    return value === undefined ? fallback : value;
  },
  set: (name, value) => put('kv', value, name),
  remove: (name) => remove('kv', name)
};

// ---------------------------------------------------------------- saved map tiles

export const tileKey = (source, z, x, y) => `${source}/${z}/${x}/${y}`;

export const getTile = (source, z, x, y) => get('tiles', tileKey(source, z, x, y));

/** Saves [[key, bytes], …] in one go. */
export const putTiles = (entries) => run('tiles', 'readwrite', (s) => {
  for (const [key, bytes] of entries) s.put(bytes, key);
});

export const deleteTiles = (keys) => run('tiles', 'readwrite', (s) => {
  for (const key of keys) s.delete(key);
});

/** Every saved tile of [source], removed in one range. */
export const deleteTilesOf = (source) => run('tiles', 'readwrite', (s) => {
  s.delete(IDBKeyRange.bound(`${source}/`, `${source}/￿`));
});
