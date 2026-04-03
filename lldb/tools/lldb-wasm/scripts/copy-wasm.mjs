// Copies the Emscripten build output into the package's wasm/ directory.
// Run via `npm run copy-wasm` or as part of `npm run build`.
//
// Assumes the wasm build has been completed with `just build-wasm` and the
// output is at <repo-root>/build-wasm/bin/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgDir, '../../..');
const srcDir = path.join(repoRoot, 'build-wasm', 'bin');
const destDir = path.join(pkgDir, 'wasm');

const files = ['lldb-wasm.js', 'lldb-wasm.wasm'];

if (!fs.existsSync(srcDir)) {
  console.error(`Build output not found at: ${srcDir}`);
  console.error('Run `just build-wasm` first.');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (!fs.existsSync(src)) {
    console.error(`Missing: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  const size = fs.statSync(dest).size;
  console.log(`Copied ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

console.log(`Done. wasm files at: ${destDir}`);
