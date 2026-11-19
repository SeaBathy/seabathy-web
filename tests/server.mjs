// A small HTTPS file server for trying the app on this computer and for the tests. It serves
// part-file (range) requests and can allow other sites to read from it, the two things a web
// chart's server must do. Run it by itself to open the app at https://localhost:8443.

import https from 'node:https';
import { existsSync, mkdirSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, '..');
/** Where the tests keep their scratch files. Another place can be named, for a run inside a container. */
export const workDir = process.env.SEABATHY_TEST_DIR || path.join(here, '.work');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream', '.tif': 'image/tiff', '.gpx': 'application/gpx+xml',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.geojson': 'application/geo+json'
};

/** A certificate for localhost that this computer signs for itself, made once with openssl. */
export function certificate() {
  const dir = path.join(workDir, 'cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert,
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * Serves the files under [root] on [port]. [cors] lets pages from other sites read them. A
 * path put in [swap] ('/sw.js', say) is answered with the text given there instead of the file:
 * that is how the tests put a newer version of the app on the server.
 */
export async function serve({ root, port, cors = false, swap = new Map() }) {
  const answer = (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    if (cors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Headers'] = 'Range, If-Match';
      headers['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, ETag';
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    let file;
    try {
      const wanted = decodeURIComponent(new URL(request.url, 'https://localhost').pathname);
      file = path.resolve(root, `.${wanted}`);
    } catch {
      file = null;
    }
    // Nothing outside the folder being served.
    if (!file || (file !== root && !file.startsWith(root + path.sep))) {
      response.writeHead(403, headers);
      response.end();
      return;
    }
    const swapped = swap.get(new URL(request.url, 'https://localhost').pathname);
    if (swapped !== undefined) {
      const body = Buffer.from(swapped);
      response.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, headers);
      response.end('Not found');
      return;
    }
    const size = statSync(file).size;
    headers['Content-Type'] = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    headers.ETag = `"${size}-${Math.round(statSync(file).mtimeMs)}"`;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(size - 1, range[2] === '' ? size - 1 : Number(range[2]));
      if (start >= size || end < start) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  };
  // "localhost" is two addresses, and a browser may try either first: answer on both, and only
  // on this computer.
  const options = certificate();
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = https.createServer(options, answer);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      servers.push(server);
    } catch (error) {
      // A computer with no IPv6 has only the first.
      if (host === '127.0.0.1') throw error;
    }
  }
  return { close: () => servers.forEach((s) => { s.close(); s.closeAllConnections?.(); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8443;
  await serve({ root: appRoot, port });
  console.log(`SeaBathy is at https://localhost:${port}/ (the browser will warn about the certificate: it is this computer's own)`);
}
