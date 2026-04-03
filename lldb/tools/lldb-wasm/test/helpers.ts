// Shared test helpers: resolve absolute file URLs for dist/ and wasm/ so
// LLDBClient.create() can locate the worker and wasm binary regardless of
// where the test runner is invoked from.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(__dirname, '..');

export const workerUrl = pathToFileURL(resolve(pkg, 'dist/worker.js')).href;
export const wasmJsUrl = pathToFileURL(resolve(pkg, 'wasm/lldb-wasm.js')).href;

export function wasmAvailable(): boolean {
  return existsSync(resolve(pkg, 'wasm/lldb-wasm.wasm'));
}
