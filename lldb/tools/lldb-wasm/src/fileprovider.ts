// File provider bridge: SharedArrayBuffer layout and main-thread watch loop.
//
// When LLDB opens a source file that doesn't exist in MEMFS, the Worker's
// FS.open patch blocks synchronously via Atomics.wait while the main thread
// fulfills the request asynchronously through whatever I/O API is available
// (IOUtils, fetch, etc.).
//
// SAB layout (all values little-endian):
//   [0..3]       Int32  status:  0=idle, 1=pending, 2=ready, -1=not-found
//   [4..7]       Int32  path byte length
//   [8..4103]    Uint8  path (UTF-8, max 4095 bytes + NUL)
//   [4104..4107] Int32  data byte length
//   [4108..]     Uint8  file data (max MAX_DATA bytes)

export const SAB_STATUS_IDX  = 0;         // Int32Array index
export const SAB_PATH_LEN_IDX = 1;        // Int32Array index
export const SAB_PATH_OFFSET  = 8;        // byte offset
export const SAB_MAX_PATH     = 4096;     // bytes
export const SAB_DATA_LEN_IDX = 1026;     // Int32Array index (byte offset 4104)
export const SAB_DATA_OFFSET  = 4108;     // byte offset
export const SAB_MAX_DATA     = 4 * 1024 * 1024; // 4 MB
export const SAB_SIZE         = SAB_DATA_OFFSET + SAB_MAX_DATA;

export type FileProvider = (path: string) => Promise<Uint8Array | null>;

// Run on the main thread for the lifetime of an LLDBClient.
// Watches the SAB for file read requests from the Worker and fulfills them
// by calling the registered provider.
export async function watchForFileRequests(
  sab: SharedArrayBuffer,
  getProvider: () => FileProvider | null,
  destroyed: () => boolean,
): Promise<void> {
  const i32 = new Int32Array(sab);
  const u8  = new Uint8Array(sab);
  const dec = new TextDecoder();

  while (!destroyed()) {
    // Wait until status is no longer 0 (idle).
    const r = Atomics.waitAsync(i32, SAB_STATUS_IDX, 0);
    if (r.async) await r.value;

    const status = Atomics.load(i32, SAB_STATUS_IDX);
    if (status !== 1) {
      // Transitional state (2 or -1) while worker resets; spin briefly.
      continue;
    }

    // Read the requested path.
    const pathLen  = Atomics.load(i32, SAB_PATH_LEN_IDX);
    const pathBytes = u8.slice(SAB_PATH_OFFSET, SAB_PATH_OFFSET + pathLen);
    const path     = dec.decode(pathBytes);

    // Ask the provider for the file content.
    let data: Uint8Array | null = null;
    const provider = getProvider();
    if (provider) {
      try { data = await provider(path); } catch { /* treat as not found */ }
    }

    if (data && data.byteLength <= SAB_MAX_DATA) {
      u8.set(data, SAB_DATA_OFFSET);
      Atomics.store(i32, SAB_DATA_LEN_IDX, data.byteLength);
      Atomics.store(i32, SAB_STATUS_IDX, 2);   // ready
    } else {
      Atomics.store(i32, SAB_STATUS_IDX, -1);  // not found
    }
    Atomics.notify(i32, SAB_STATUS_IDX);

    // Wait for the worker to consume the response and reset status to 0.
    // This prevents the loop from spinning on the transitional state.
    await Atomics.waitAsync(i32, SAB_STATUS_IDX, Atomics.load(i32, SAB_STATUS_IDX)).value;
  }
}
