// The app's private file storage (OPFS): where imported charts live so they are still there the
// next time the app opens. Also the storage readout and the request to keep the data.

const CHUNK = 8 * 1024 * 1024;
let worker = null;
let nextId = 1;
const waiting = new Map();

async function chartsDir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('charts', { create });
}

/** True when this browser has private file storage at all. */
export async function available() {
  try {
    await chartsDir();
    return true;
  } catch {
    return false;
  }
}

function theWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./opfs-worker.js', import.meta.url));
  worker.onmessage = (event) => {
    const m = event.data;
    const job = waiting.get(m.id);
    if (!job) return;
    if (m.written !== undefined) job.onProgress?.(m.written, m.total);
    if (m.done) {
      waiting.delete(m.id);
      job.resolve();
    }
    if (m.error) {
      waiting.delete(m.id);
      const error = new Error(m.error);
      error.name = m.name || 'Error';
      job.reject(error);
    }
  };
  worker.onerror = (event) => {
    // The worker itself failed to start: every waiting job hears of it.
    for (const job of waiting.values()) job.reject(new Error(event.message || 'The file worker failed'));
    waiting.clear();
    worker = null;
  };
  return worker;
}

function inWorker(message, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject, onProgress });
    signal?.addEventListener('abort', () => worker?.postMessage({ cmd: 'cancel', id }), { once: true });
    theWorker().postMessage({ ...message, id });
  });
}

/** Writing from the page itself (iOS 26 and later, and other browsers): the fallback. */
async function writeFromPage(name, file, onProgress, signal) {
  const dir = await chartsDir();
  const handle = await dir.getFileHandle(name, { create: true });
  if (!handle.createWritable) throw new Error('This browser cannot save files for offline use');
  const out = await handle.createWritable();
  try {
    for (let at = 0; at < file.size; at += CHUNK) {
      if (signal?.aborted) throw new Error('Cancelled');
      await out.write(await file.slice(at, Math.min(file.size, at + CHUNK)).arrayBuffer());
      onProgress?.(Math.min(file.size, at + CHUNK), file.size);
    }
    await out.close();
  } catch (error) {
    try { await out.abort(); } catch { /* already closed */ }
    try { await dir.removeEntry(name); } catch { /* never made */ }
    throw error;
  }
}

export const isFull = (error) => error?.name === 'QuotaExceededError' || /quota|out of space/i.test(error?.message || '');
export const isCancel = (error) => /Cancelled/.test(error?.message || '');

/** Files held only while the app is open, in a browser that has no private storage. */
const session = new Map();

/**
 * Copies [file] into the app's storage as [name], a piece at a time: it never has to fit in
 * memory. True when it's saved for good; false when this browser could only hold it until the
 * app closes.
 */
export async function save(name, file, onProgress, signal) {
  if (!(await available())) {
    session.set(name, file);
    return false;
  }
  try {
    await inWorker({ cmd: 'copy', name, file }, onProgress, signal);
  } catch (error) {
    if (signal?.aborted || isCancel(error) || isFull(error)) throw error;
    try {
      await writeFromPage(name, file, onProgress, signal);
    } catch (second) {
      if (signal?.aborted || isCancel(second) || isFull(second)) throw second;
      session.set(name, file);
      return false;
    }
  }
  return true;
}

/**
 * Saves a small block of bytes (a depth layer's overview) as [name]. [sessionOnly] when the
 * file it belongs to could only be held until the app closes.
 */
export async function saveBytes(name, bytes, sessionOnly = false) {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (sessionOnly || !(await available())) {
    session.set(name, new Blob([copy]));
    return;
  }
  try {
    await inWorker({ cmd: 'write', name, bytes: copy });
  } catch (error) {
    if (isFull(error)) throw error;
    try {
      await writeFromPage(name, new Blob([copy]));
    } catch (second) {
      if (isFull(second)) throw second;
      session.set(name, new Blob([copy]));
    }
  }
}

/** The saved file, read from disk only as pieces of it are asked for. */
export async function open(name) {
  if (session.has(name)) return session.get(name);
  const dir = await chartsDir(false);
  return (await dir.getFileHandle(name)).getFile();
}

export async function remove(name) {
  session.delete(name);
  try {
    await (await chartsDir(false)).removeEntry(name);
  } catch { /* already gone */ }
}

/**
 * Every saved file's name and size. Null when the storage couldn't be read at all, which is
 * not the same as empty: nothing should be forgotten on the strength of it.
 */
export async function list() {
  let dir;
  try {
    dir = await chartsDir(false);
  } catch (error) {
    // No folder yet means nothing has been saved; anything else means the storage didn't answer.
    return error?.name === 'NotFoundError' ? [] : null;
  }
  const out = [...session].map(([name, blob]) => ({ name, size: blob.size, modified: Date.now() }));
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      out.push({ name, size: file.size, modified: file.lastModified });
    }
  } catch {
    return null;
  }
  return out;
}

/** How much space the app uses and may use, and whether the phone has agreed to keep it. */
export async function storage() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    const estimate = await navigator.storage.estimate();
    out.usage = estimate.usage ?? null;
    out.quota = estimate.quota ?? null;
  } catch { /* not told */ }
  try {
    out.persisted = await navigator.storage.persisted();
  } catch { /* not told */ }
  return out;
}

/** Asks the phone not to clear the app's data when it runs short of space. True when it agrees. */
export async function keep() {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1)} GB`;
}
