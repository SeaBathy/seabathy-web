// Writes files into the app's private storage (OPFS) off the main thread. A worker is the one
// way to write there on every iPhone back to iOS 15.2; the page itself can only do it from iOS 26.

const CHUNK = 8 * 1024 * 1024;
const cancelled = new Set();

async function chartsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('charts', { create: true });
}

self.onmessage = async (event) => {
  const m = event.data;
  if (m.cmd === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  let dir = null;
  try {
    dir = await chartsDir();
    const handle = await dir.getFileHandle(m.name, { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      // Older iPhones answer these with promises, newer ones at once: await covers both.
      await access.truncate(0);
      if (m.cmd === 'write') {
        await writeAll(access, new Uint8Array(m.bytes), 0);
      } else {
        const total = m.file.size;
        let at = 0;
        while (at < total) {
          if (cancelled.has(m.id)) throw new Error('Cancelled');
          const end = Math.min(total, at + CHUNK);
          const bytes = new Uint8Array(await m.file.slice(at, end).arrayBuffer());
          if (bytes.length !== end - at) throw new Error('The file could not be read to the end');
          await writeAll(access, bytes, at);
          at = end;
          self.postMessage({ id: m.id, written: at, total });
        }
      }
      await access.flush();
    } finally {
      await access.close();
    }
    self.postMessage({ id: m.id, done: true });
  } catch (error) {
    // Nothing half-written is left behind.
    try { if (dir) await dir.removeEntry(m.name); } catch { /* it was never made */ }
    self.postMessage({ id: m.id, error: String((error && error.message) || error), name: error && error.name });
  } finally {
    cancelled.delete(m.id);
  }
};

async function writeAll(access, bytes, at) {
  let done = 0;
  while (done < bytes.length) {
    const wrote = await access.write(bytes.subarray(done), { at: at + done });
    if (!(wrote > 0)) throw new Error('The phone is out of space');
    done += wrote;
  }
}
