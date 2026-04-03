// Minimal dev server that serves the lldb-wasm demo with the COOP/COEP
// headers required for SharedArrayBuffer (pthreads).
//
// Usage:
//   node server.mjs [port]
//
// Then open http://localhost:8000 in a browser.
// The wasm and JS files are served from the parent directory (build output).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.argv[2] ?? '8000', 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Directories to serve from, in priority order.
const roots = [
  __dirname,                                             // demo/ (index.html)
  path.resolve(__dirname, '..'),                         // package root (wasm/, dist/)
  path.resolve(__dirname, '../../../../build-wasm/bin'), // fallback for .wasm
];

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  // Security: prevent directory traversal.
  pathname = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');

  let filePath = null;
  for (const root of roots) {
    const candidate = path.join(root, pathname);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + pathname);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mime[ext] ?? 'application/octet-stream';

  // These headers enable SharedArrayBuffer in all major browsers.
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-cache',
  });

  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`LLDB demo server: http://localhost:${PORT}`);
  console.log('(SharedArrayBuffer headers enabled)');
});
