// Tests for the chunked file transfer in the provider bridge.
//
// The worker side of the protocol blocks on Atomics.wait, which is illegal on
// the main thread, so these drive the real `watchForFileRequests` loop from a
// worker_threads Worker that speaks the protocol exactly as src/worker.ts does.
// No LLDB involved: this is the transport on its own.

import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  watchForFileRequests,
  SAB_SIZE, SAB_CHUNK_BYTES, SAB_STATUS_IDX, SAB_OP_IDX, SAB_PATH_LEN_IDX,
  SAB_OFFSET_IDX, SAB_RESULT_IDX, SAB_PATH_OFFSET, SAB_DATA_OFFSET,
  STATUS_IDLE, STATUS_PENDING, STATUS_READY, OP_SIZE, OP_READ,
} from '../dist/fileprovider.js';
import type { FileProvider } from '../dist/index.js';

// Mirror of src/worker.ts's fetchFileSync, minus the MEMFS write. Runs in a
// worker so it can block on Atomics.wait; posts back the bytes it assembled.
const READER = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, path, k } = workerData;
const i32 = new Int32Array(sab);
const u8 = new Uint8Array(sab);

function request(op, offset) {
  const pathBytes = new TextEncoder().encode(path);
  u8.set(pathBytes, k.SAB_PATH_OFFSET);
  Atomics.store(i32, k.SAB_PATH_LEN_IDX, pathBytes.byteLength);
  Atomics.store(i32, k.SAB_OP_IDX, op);
  Atomics.store(i32, k.SAB_OFFSET_IDX, offset);
  Atomics.store(i32, k.SAB_STATUS_IDX, k.STATUS_PENDING);
  Atomics.notify(i32, k.SAB_STATUS_IDX);
  Atomics.wait(i32, k.SAB_STATUS_IDX, k.STATUS_PENDING);
  let result = null, data = null;
  if (Atomics.load(i32, k.SAB_STATUS_IDX) === k.STATUS_READY) {
    result = Atomics.load(i32, k.SAB_RESULT_IDX);
    if (op === k.OP_READ) data = u8.slice(k.SAB_DATA_OFFSET, k.SAB_DATA_OFFSET + result);
  }
  Atomics.store(i32, k.SAB_STATUS_IDX, k.STATUS_IDLE);
  Atomics.notify(i32, k.SAB_STATUS_IDX);
  return { result, data };
}

const size = request(k.OP_SIZE, 0).result;
if (size === null) {
  parentPort.postMessage({ notFound: true });
} else {
  const file = new Uint8Array(size);
  let offset = 0, chunks = 0;
  while (offset < size) {
    const { result, data } = request(k.OP_READ, offset);
    if (result === null || result === 0) break;
    file.set(data, offset);
    offset += result;
    chunks++;
  }
  parentPort.postMessage({ size, chunks, file }, [file.buffer]);
}
`;

const CONSTANTS = {
  SAB_STATUS_IDX, SAB_OP_IDX, SAB_PATH_LEN_IDX, SAB_OFFSET_IDX, SAB_RESULT_IDX,
  SAB_PATH_OFFSET, SAB_DATA_OFFSET,
  STATUS_IDLE, STATUS_PENDING, STATUS_READY, OP_SIZE, OP_READ,
};

// Serve `provider` to one worker-side read of `path` and return what it got.
async function transfer(
  path: string,
  provider: FileProvider,
): Promise<{ size?: number; chunks?: number; file?: Uint8Array; notFound?: boolean }> {
  const sab = new SharedArrayBuffer(SAB_SIZE);
  let done = false;
  void watchForFileRequests(sab, () => provider, () => done);

  const worker = new Worker(READER, {
    eval: true,
    workerData: { sab, path, k: CONSTANTS },
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  } finally {
    done = true;
    await worker.terminate();
  }
}

// Compare without vitest's element-by-element deep equality, which is far
// slower than the transfer being measured.
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// Byte i is a function of i, so a chunk landing at the wrong offset (or a
// dropped tail) fails rather than happening to match.
function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 13)) & 0xff;
  return bytes;
}

describe('chunked file transfer', () => {
  it('transfers a file smaller than one chunk in a single read', async () => {
    const bytes = pattern(1024);
    const got = await transfer('/small.bin', async () => bytes);
    expect(got.size).toBe(bytes.length);
    expect(got.chunks).toBe(1);
    expect(sameBytes(got.file, bytes)).toBe(true);
  });

  it('transfers a file spanning several chunks', async () => {
    const bytes = pattern(SAB_CHUNK_BYTES * 2 + 12345);
    let providerCalls = 0;
    const got = await transfer('/big.bin', async () => {
      providerCalls++;
      return bytes;
    });
    expect(got.size).toBe(bytes.length);
    expect(got.chunks).toBe(3);
    expect(sameBytes(got.file, bytes)).toBe(true);
    // Every chunk is served from one provider call, not one call per chunk.
    expect(providerCalls).toBe(1);
  });

  it('transfers a file exactly one chunk long', async () => {
    const bytes = pattern(SAB_CHUNK_BYTES);
    const got = await transfer('/exact.bin', async () => bytes);
    expect(got.chunks).toBe(1);
    expect(sameBytes(got.file, bytes)).toBe(true);
  });

  it('reports a file the provider does not have', async () => {
    const got = await transfer('/missing.bin', async () => null);
    expect(got.notFound).toBe(true);
  });

  it('reports a file the provider throws on', async () => {
    const got = await transfer('/broken.bin', async () => {
      throw new Error('provider exploded');
    });
    expect(got.notFound).toBe(true);
  });

  it('passes the requested path through to the provider', async () => {
    const seen: string[] = [];
    await transfer('//math.debug.wasm', async (path) => {
      seen.push(path);
      return new Uint8Array([1, 2, 3]);
    });
    expect(seen).toContain('//math.debug.wasm');
  });
});
