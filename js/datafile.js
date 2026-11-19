// The app's own data files (marine park zones, names, ramps, buoys and beacons), each fetched
// only when its layer is switched on. The page fetches the file and hands the map a local copy:
// what the map's own worker fetches is not kept by the service worker in Safari, and a file
// the page fetches is, so the layer then works with no signal.

const address = (name) => new URL(`../data/${name}.geojson`, import.meta.url).href;
const copies = new Map();

/** A local address for [name]'s data, fetched once and kept until it is let go. */
export function copyOf(name) {
  if (!copies.has(name)) {
    copies.set(name, fetch(address(name))
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`${name}: ${response.status}`))))
      .then((blob) => URL.createObjectURL(blob))
      .catch((error) => {
        copies.delete(name);
        throw error;
      }));
  }
  return copies.get(name);
}

/** Frees the memory held for [name] (its layer was switched off). */
export function letGo(name) {
  copies.get(name)?.then((url) => URL.revokeObjectURL(url), () => {});
  copies.delete(name);
}

/** The data itself, as an object. */
export const read = (name) => copyOf(name).then((url) => fetch(url)).then((response) => response.json());
