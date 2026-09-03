// File provider bridge: SharedArrayBuffer layout and main-thread watch loop.
//
// When LLDB opens a file that doesn't exist in MEMFS, the Worker's FS.open
// patch blocks synchronously via Atomics.wait while the main thread fulfills
// the request asynchronously through whatever I/O API is available (IOUtils,
// fetch, etc.).
//
// Files are transferred in chunks, so the data window bounds one round trip
// rather than the file: the worker asks for the size (OP_SIZE), then reads
// CHUNK_BYTES at a time (OP_READ) until it has the whole file. Providers stay
// whole-file — the watch loop holds the bytes of the file being transferred and
// slices them per request.
//
// SAB layout (Int32Array indices unless noted):
//   [0]  status: 0 idle, 1 request pending, 2 ready, -1 not found
//   [1]  op: 0 size, 1 read
//   [2]  path byte length
//   [3]  read offset
//   [4]  result: file size (OP_SIZE) or data window byte length (OP_READ)
//   byte SAB_PATH_OFFSET.. path (UTF-8)
//   byte SAB_DATA_OFFSET.. data window

import type { FileProvider } from './types.js';

export const SAB_STATUS_IDX   = 0;
export const SAB_OP_IDX       = 1;
export const SAB_PATH_LEN_IDX = 2;
export const SAB_OFFSET_IDX   = 3;
export const SAB_RESULT_IDX   = 4;

export const STATUS_IDLE      = 0;
export const STATUS_PENDING   = 1;
export const STATUS_READY     = 2;
export const STATUS_NOT_FOUND = -1;

export const OP_SIZE = 0;
export const OP_READ = 1;

export const SAB_PATH_OFFSET = 32;                               // after the control words
export const SAB_MAX_PATH    = 4096;                             // bytes
export const SAB_DATA_OFFSET = SAB_PATH_OFFSET + SAB_MAX_PATH;
export const SAB_CHUNK_BYTES = 4 * 1024 * 1024;                  // one round trip
export const SAB_SIZE        = SAB_DATA_OFFSET + SAB_CHUNK_BYTES;

// Sizes and offsets cross the wire as Int32, so this is the largest file the
// bridge can carry.
export const SAB_MAX_FILE_BYTES = 0x7fffffff;

// Run on the main thread for the lifetime of an LLDBClient.
// Watches the SAB for file requests from the Worker and fulfills them by
// calling the registered provider.
export async function watchForFileRequests(
  sab: SharedArrayBuffer,
  getProvider: () => FileProvider | null,
  destroyed: () => boolean,
): Promise<void> {
  const i32 = new Int32Array(sab);
  const u8  = new Uint8Array(sab);
  const dec = new TextDecoder();

  // Bytes of the file currently being transferred. The worker asks for a size
  // and then reads that file through to its end before requesting another, so
  // holding one file is enough to serve every chunk from a single provider
  // call.
  let held: { path: string; bytes: Uint8Array } | null = null;

  const load = async (path: string): Promise<Uint8Array | null> => {
    if (held?.path === path) return held.bytes;
    const provider = getProvider();
    if (!provider) return null;
    let bytes: Uint8Array | null = null;
    try { bytes = await provider(path); } catch { return null; }
    if (!bytes || bytes.byteLength > SAB_MAX_FILE_BYTES) return null;
    held = { path, bytes };
    return bytes;
  };

  while (!destroyed()) {
    // Wait until status is no longer idle.
    const r = Atomics.waitAsync(i32, SAB_STATUS_IDX, STATUS_IDLE);
    if (r.async) await r.value;

    if (Atomics.load(i32, SAB_STATUS_IDX) !== STATUS_PENDING) {
      // Transitional state while the worker consumes a response; spin briefly.
      continue;
    }

    const pathLen = Atomics.load(i32, SAB_PATH_LEN_IDX);
    const path = dec.decode(u8.slice(SAB_PATH_OFFSET, SAB_PATH_OFFSET + pathLen));
    const op = Atomics.load(i32, SAB_OP_IDX);
    const bytes = await load(path);

    let responseStatus: number;
    if (!bytes) {
      responseStatus = STATUS_NOT_FOUND;
      Atomics.store(i32, SAB_STATUS_IDX, responseStatus);
    } else {
      let result = bytes.byteLength;
      if (op === OP_READ) {
        const offset = Atomics.load(i32, SAB_OFFSET_IDX);
        const end = Math.min(offset + SAB_CHUNK_BYTES, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        u8.set(chunk, SAB_DATA_OFFSET);
        result = chunk.byteLength;
      }
      Atomics.store(i32, SAB_RESULT_IDX, result);
      responseStatus = STATUS_READY;
      Atomics.store(i32, SAB_STATUS_IDX, responseStatus);
    }
    Atomics.notify(i32, SAB_STATUS_IDX);

    // Wait for the worker to consume the response and reset status to idle.
    // Wait on the response value we published, rather than reloading status:
    // the worker may have already advanced through idle and published its next
    // request. In that case waitAsync returns "not-equal" immediately and the
    // outer loop services the pending request instead of waiting on it.
    const consumed = Atomics.waitAsync(i32, SAB_STATUS_IDX, responseStatus);
    if (consumed.async) await consumed.value;
  }
}
