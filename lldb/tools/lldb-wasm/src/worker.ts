// Worker script: loads the LLDB wasm module and handles all C API calls.
// Runs inside a dedicated Web Worker (browser) or worker_threads Worker (Node).

import type {
  Request,
  Response,
  StopEvent,
  OutputEvent,
  InterpreterExitEvent,
  DAPOutputEvent,
  DAPExitEvent,
  ChannelDataEvent,
  SessionResultEvent,
  ReadyMessage,
  ErrorMessage,
} from './protocol.js';
import type { StopReason } from './types.js';
import {
  SAB_STATUS_IDX,
  SAB_OP_IDX,
  SAB_PATH_LEN_IDX,
  SAB_OFFSET_IDX,
  SAB_RESULT_IDX,
  SAB_PATH_OFFSET,
  SAB_MAX_PATH,
  SAB_DATA_OFFSET,
  STATUS_IDLE,
  STATUS_PENDING,
  STATUS_READY,
  OP_SIZE,
  OP_READ,
} from './fileprovider.js';

// ---------------------------------------------------------------------------
// Environment abstraction: browser Web Worker vs Node worker_threads
// ---------------------------------------------------------------------------

interface WorkerPort {
  onMessage(handler: (data: unknown) => void): void;
  postMessage(data: unknown): void;
}

async function getPort(): Promise<WorkerPort> {
  // Browser DedicatedWorkerGlobalScope has self.postMessage.
  if (
    typeof self !== 'undefined' &&
    typeof (self as { postMessage?: unknown }).postMessage === 'function'
  ) {
    const w = self as DedicatedWorkerGlobalScope;
    return {
      onMessage: (h) => {
        w.onmessage = (e: MessageEvent) => h(e.data);
      },
      postMessage: (d) => w.postMessage(d),
    };
  }
  // Node.js worker_threads uses parentPort.
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('not running inside a worker');
  return {
    onMessage: (h) => parentPort.on('message', h),
    postMessage: (d) => parentPort.postMessage(d),
  };
}

// Minimal interface for what we use from the Emscripten module.
interface LLDBMod {
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  UTF8ToString(ptr: number): string;
}

let mod: LLDBMod;
let handle: number = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastStopReason: string = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ccall(name: string, ret: string | null, types: string[], args: unknown[]): unknown {
  return mod.ccall(name, ret, types, args);
}

function freeString(ptr: number): void {
  ccall('lldb_wasm_free_string', null, ['number'], [ptr]);
}

function getAndFreeString(ptr: number): string {
  const s = mod.UTF8ToString(ptr);
  freeString(ptr);
  return s;
}

// ---------------------------------------------------------------------------
// Dispatch table: maps method names to implementations
// ---------------------------------------------------------------------------

type Handler = (args: unknown[]) => unknown;

function makeDispatch(): Map<string, Handler> {
  const d = new Map<string, Handler>();

  d.set('connect', ([url, errBufLen = 512]: unknown[]) => {
    const errBuf = mod._malloc(errBufLen as number);
    try {
      const ret = ccall(
        'lldb_wasm_connect',
        'number',
        ['number', 'string', 'number', 'number'],
        [handle, url, errBuf, errBufLen],
      );
      if (ret !== 0) {
        throw new Error(mod.UTF8ToString(errBuf) || 'connect failed');
      }
    } finally {
      mod._free(errBuf);
    }
    startPoll();
  });

  d.set('disconnect', () => {
    stopPoll();
    ccall('lldb_wasm_disconnect', null, ['number'], [handle]);
  });

  d.set('attachWasmModule', ([name, data]: unknown[]) => {
    const bytes = data as Uint8Array;
    const buf = mod._malloc(bytes.byteLength);
    mod.HEAPU8.set(bytes, buf);
    const ret = ccall(
      'lldb_wasm_attach_wasm_module',
      'number',
      ['number', 'string', 'number', 'number'],
      [handle, name, buf, bytes.byteLength],
    );
    mod._free(buf);
    if (ret !== 0) throw new Error(`failed to attach module: ${name}`);
  });

  d.set('setBreakpoint', ([file, line]: unknown[]) => {
    const id = ccall(
      'lldb_wasm_set_breakpoint_by_location',
      'number',
      ['number', 'string', 'number'],
      [handle, file, line],
    );
    if (!id) throw new Error(`failed to set breakpoint at ${file}:${line}`);
    return id;
  });

  d.set('setBreakpointByAddress', ([lo, hi]: unknown[]) => {
    const id = ccall(
      'lldb_wasm_set_breakpoint_by_address',
      'number',
      ['number', 'number', 'number'],
      [handle, lo, hi],
    );
    if (!id) throw new Error(`failed to set breakpoint at address`);
    return id;
  });

  d.set('removeBreakpoint', ([bpId]: unknown[]) => {
    ccall('lldb_wasm_remove_breakpoint', 'number', ['number', 'number'], [handle, bpId]);
  });

  d.set('enableBreakpoint', ([bpId, enable]: unknown[]) => {
    ccall(
      'lldb_wasm_enable_breakpoint',
      null,
      ['number', 'number', 'number'],
      [handle, bpId, enable ? 1 : 0],
    );
  });

  d.set('resume', () => {
    const ret = ccall('lldb_wasm_resume', 'number', ['number'], [handle]);
    if (ret !== 0) throw new Error('resume failed');
  });

  d.set('pause', () => {
    const ret = ccall('lldb_wasm_pause', 'number', ['number'], [handle]);
    if (ret !== 0) throw new Error('pause failed');
  });

  d.set('stepOver', () => {
    ccall('lldb_wasm_step_over', 'number', ['number'], [handle]);
  });
  d.set('stepInto', () => {
    ccall('lldb_wasm_step_into', 'number', ['number'], [handle]);
  });
  d.set('stepOut', () => {
    ccall('lldb_wasm_step_out', 'number', ['number'], [handle]);
  });

  d.set('getStopReason', () => {
    const ptr = ccall('lldb_wasm_get_stop_reason', 'number', ['number'], [handle]) as number;
    return JSON.parse(getAndFreeString(ptr)) as StopReason;
  });

  d.set('getNumThreads', () => ccall('lldb_wasm_get_num_threads', 'number', ['number'], [handle]));

  d.set('getNumFrames', () => ccall('lldb_wasm_get_num_frames', 'number', ['number'], [handle]));

  d.set('getStackTrace', () => {
    const ptr = ccall('lldb_wasm_get_frame_info', 'number', ['number'], [handle]) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('getVariables', ([frameIndex = 0]: unknown[]) => {
    const ptr = ccall(
      'lldb_wasm_get_variables_json',
      'number',
      ['number', 'number'],
      [handle, frameIndex],
    ) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('readMemory', ([lo, hi, size]: unknown[]) => {
    const buf = mod._malloc(size as number);
    const bytesReadBuf = mod._malloc(4);
    try {
      const ret = ccall(
        'lldb_wasm_read_memory',
        'number',
        ['number', 'number', 'number', 'number', 'number', 'number'],
        [handle, lo, hi, buf, size, bytesReadBuf],
      );
      if (ret !== 0) throw new Error('readMemory failed');
      const n = mod.HEAPU32[bytesReadBuf >> 2] ?? 0;
      return Array.from(mod.HEAPU8.subarray(buf, buf + n));
    } finally {
      mod._free(buf);
      mod._free(bytesReadBuf);
    }
  });

  d.set('evaluateExpression', ([expr, frameIndex = 0]: unknown[]) => {
    const ptr = ccall(
      'lldb_wasm_evaluate_expression',
      'number',
      ['number', 'number', 'string'],
      [handle, frameIndex, expr],
    ) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('runCommand', ([command]: unknown[]) => {
    const ptr = ccall(
      'lldb_wasm_run_command',
      'number',
      ['number', 'string'],
      [handle, command],
    ) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('runInterpreter', () => {
    ccall('lldb_wasm_run_command_interpreter', null, ['number'], [handle]);
    startConsoleDrain();
  });

  d.set('consoleStdinWrite', ([data]: unknown[]) => {
    const bytes = data as number[];
    const buf = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, buf);
    try {
      ccall('lldb_wasm_console_stdin_write', 'number', ['number', 'number'], [buf, bytes.length]);
    } finally {
      mod._free(buf);
    }
  });

  d.set('consoleStdinClose', () => {
    ccall('lldb_wasm_console_stdin_close', null, [], []);
  });

  d.set('dapStart', ([preInitCommands, noLldbInit]: unknown[]) => {
    const ret = ccall(
      'lldb_wasm_dap_start',
      'number',
      ['string', 'number'],
      [preInitCommands, noLldbInit ? 1 : 0],
    ) as number;
    if (ret !== 0) {
      const ptr = ccall('lldb_wasm_dap_error', 'number', [], []) as number;
      throw new Error(getAndFreeString(ptr) || 'failed to start DAP');
    }
    startDAPDrain();
  });

  d.set('dapStdinWrite', ([data]: unknown[]) => {
    const bytes = data as number[];
    const buf = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, buf);
    try {
      const n = ccall(
        'lldb_wasm_dap_stdin_write',
        'number',
        ['number', 'number'],
        [buf, bytes.length],
      ) as number;
      if (n !== bytes.length) throw new Error('failed to write DAP input');
    } finally {
      mod._free(buf);
    }
  });

  d.set('dapStdinClose', () => {
    ccall('lldb_wasm_dap_stdin_close', null, [], []);
  });

  d.set('createChannel', () => ccall('lldb_wasm_create_channel', 'number', [], []));

  d.set('connectInProcess', ([channelId]: unknown[]) => {
    const ret = ccall(
      'lldb_wasm_connect_inprocess',
      'number',
      ['number', 'number'],
      [handle, channelId],
    );
    if (ret !== 0) throw new Error('connectInProcess failed');
    startPoll();
  });

  d.set('channelServerWrite', ([channelId, data]: unknown[]) => {
    const bytes = data as number[];
    const buf = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, buf);
    const n = ccall(
      'lldb_wasm_channel_server_write',
      'number',
      ['number', 'number', 'number'],
      [channelId, buf, bytes.length],
    ) as number;
    mod._free(buf);
    if (n < 0) throw new Error(`channel ${String(channelId)} not found`);
    return n;
  });

  d.set('channelServerRead', ([channelId, maxBytes, timeoutMs = 1000]: unknown[]) => {
    const buf = mod._malloc(maxBytes as number);
    try {
      const n = ccall(
        'lldb_wasm_channel_server_read',
        'number',
        ['number', 'number', 'number', 'number'],
        [channelId, buf, maxBytes, timeoutMs],
      ) as number;
      if (n < 0) throw new Error(`channel ${String(channelId)} not found`);
      return n > 0 ? Array.from(mod.HEAPU8.subarray(buf, buf + n)) : [];
    } finally {
      mod._free(buf);
    }
  });

  d.set('destroyChannel', ([channelId]: unknown[]) => {
    bridgedChannels.delete(channelId as number);
    ccall('lldb_wasm_destroy_channel', null, ['number'], [channelId]);
  });

  // Start/stop draining a channel's server side. While bridged, bytes LLDB
  // writes are drained (non-blocking) on the drain timer and pushed to the main
  // thread as 'channelData' events, which the embedder forwards to its socket.
  d.set('bridgeChannelStart', ([channelId]: unknown[]) => {
    bridgedChannels.add(channelId as number);
    ensureDrainTimer();
  });

  d.set('bridgeChannelStop', ([channelId]: unknown[]) => {
    bridgedChannels.delete(channelId as number);
  });

  // Session ops: submit to the off-worker session thread (non-blocking). The
  // result arrives later via the drain timer as a 'sessionResult' event.
  d.set('sessionCommand', ([sessionId, cmd]: unknown[]) => {
    ensureDrainTimer();
    ccall(
      'lldb_wasm_session_command',
      null,
      ['number', 'number', 'string'],
      [sessionId, handle, cmd],
    );
  });
  d.set('sessionState', ([sessionId]: unknown[]) => {
    ensureDrainTimer();
    ccall('lldb_wasm_session_state', null, ['number', 'number'], [sessionId, handle]);
  });
  d.set('sessionFrames', ([sessionId]: unknown[]) => {
    ensureDrainTimer();
    ccall('lldb_wasm_session_frames', null, ['number', 'number'], [sessionId, handle]);
  });
  d.set('sessionVariable', ([sessionId, frameIndex, name]: unknown[]) => {
    ensureDrainTimer();
    ccall(
      'lldb_wasm_session_variable',
      null,
      ['number', 'number', 'number', 'string'],
      [sessionId, handle, frameIndex, name],
    );
  });

  return d;
}

// ---------------------------------------------------------------------------
// Stop event polling
// ---------------------------------------------------------------------------

function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(checkForStop, 50);
}

function stopPoll(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------------------
// Drain timer: interpreter output + bridged channels
// ---------------------------------------------------------------------------
//
// LLDB's interpreter REPL and GDB-remote threads write to in-process channels
// from their own pthreads. We drain those channels NON-BLOCKING on a timer and
// push bytes to the main thread; the worker thread never blocks, so it stays
// free to service stdin writes and channelServerWrite (incoming RSP). One timer
// services the interactive console and every bridged channel.

let drainTimer: ReturnType<typeof setInterval> | null = null;
let drainBuf = 0;
let sessionBuf = 0;
let sessionLenPtr = 0;
let interpreterDraining = false;
let dapDraining = false;
const bridgedChannels = new Set<number>();
const DRAIN_BUF_SIZE = 16384;
const SESSION_BUF_SIZE = 1 << 16;
const sessionDecoder = new TextDecoder();

function port(): WorkerPort | undefined {
  return (globalThis as Record<string, unknown>).__lldbWorkerPort as WorkerPort | undefined;
}

function drainConsole(p: WorkerPort | undefined): void {
  for (;;) {
    const n = ccall(
      'lldb_wasm_console_stdout_read',
      'number',
      ['number', 'number'],
      [drainBuf, DRAIN_BUF_SIZE],
    ) as number;
    if (n <= 0) break;
    p?.postMessage({
      type: 'output',
      data: Array.from(mod.HEAPU8.subarray(drainBuf, drainBuf + n)),
    } as OutputEvent);
    if (n < DRAIN_BUF_SIZE) break;
  }
}

function drainDAP(p: WorkerPort | undefined): void {
  for (;;) {
    const n = ccall(
      'lldb_wasm_dap_stdout_read',
      'number',
      ['number', 'number'],
      [drainBuf, DRAIN_BUF_SIZE],
    ) as number;
    if (n <= 0) break;
    p?.postMessage({
      type: 'dapOutput',
      data: Array.from(mod.HEAPU8.subarray(drainBuf, drainBuf + n)),
    } as DAPOutputEvent);
    if (n < DRAIN_BUF_SIZE) break;
  }
}

function drainChannel(channelId: number, p: WorkerPort | undefined): void {
  for (;;) {
    const n = ccall(
      'lldb_wasm_channel_server_read',
      'number',
      ['number', 'number', 'number', 'number'],
      [channelId, drainBuf, DRAIN_BUF_SIZE, 0],
    ) as number;
    if (n <= 0) break;
    p?.postMessage({
      type: 'channelData',
      channelId,
      data: Array.from(mod.HEAPU8.subarray(drainBuf, drainBuf + n)),
    } as ChannelDataEvent);
    if (n < DRAIN_BUF_SIZE) break;
  }
}

function drainSession(p: WorkerPort | undefined): void {
  for (;;) {
    const id = ccall(
      'lldb_wasm_session_poll',
      'number',
      ['number', 'number', 'number'],
      [sessionBuf, SESSION_BUF_SIZE, sessionLenPtr],
    ) as number;
    if (id === 0) break;
    const len = mod.HEAPU32[sessionLenPtr >> 2] ?? 0;
    const json = sessionDecoder.decode(mod.HEAPU8.subarray(sessionBuf, sessionBuf + len));
    p?.postMessage({ type: 'sessionResult', id, json } as SessionResultEvent);
  }
}

function ensureDrainTimer(): void {
  if (drainTimer !== null) return;
  if (!drainBuf) drainBuf = mod._malloc(DRAIN_BUF_SIZE);
  if (!sessionBuf) sessionBuf = mod._malloc(SESSION_BUF_SIZE);
  if (!sessionLenPtr) sessionLenPtr = mod._malloc(4);
  drainTimer = setInterval(() => {
    const p = port();
    if (interpreterDraining) {
      drainConsole(p);
      if (ccall('lldb_wasm_console_interpreter_finished', 'number', [], []) as number) {
        drainConsole(p); // flush output emitted just before exit
        interpreterDraining = false;
        p?.postMessage({ type: 'interpreterExit' } as InterpreterExitEvent);
      }
    }
    if (dapDraining) {
      drainDAP(p);
      const status = ccall('lldb_wasm_dap_status', 'number', [], []) as number;
      if (status !== 0) {
        drainDAP(p);
        dapDraining = false;
        let error: string | undefined;
        if (status < 0) {
          const ptr = ccall('lldb_wasm_dap_error', 'number', [], []) as number;
          error = getAndFreeString(ptr) || 'DAP loop failed';
        }
        p?.postMessage({ type: 'dapExit', error } as DAPExitEvent);
      }
    }
    for (const id of bridgedChannels) drainChannel(id, p);
    drainSession(p);
  }, 1);
}

function startConsoleDrain(): void {
  interpreterDraining = true;
  ensureDrainTimer();
}

function startDAPDrain(): void {
  dapDraining = true;
  ensureDrainTimer();
}

function checkForStop(): void {
  const ptr = ccall('lldb_wasm_get_stop_reason', 'number', ['number'], [handle]) as number;
  const json = getAndFreeString(ptr);
  if (json === lastStopReason) return;
  lastStopReason = json;
  const reason = JSON.parse(json) as StopReason;
  if (reason.reason !== 'running') {
    const msg: StopEvent = { type: 'event', event: reason };
    const port = (globalThis as Record<string, unknown>).__lldbWorkerPort as WorkerPort | undefined;
    port?.postMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// Emscripten FS bridge: virtual file provider
// ---------------------------------------------------------------------------
//
// Patches mod.FS.open so that when LLDB opens a source file that does not
// exist in MEMFS, the worker synchronously blocks via Atomics.wait while
// the main thread fetches the file content through whatever browser I/O
// API it has registered. On success, the file is written into MEMFS and
// LLDB proceeds as if it had always been there.
//
// This is safe because:
//   - Atomics.wait is allowed in workers (not the main thread)
//   - Emscripten proxies FS calls from pthreads to the main wasm worker,
//     so blocking here does not stall LLDB's internal GDB remote threads

// Post one request and block until the main thread answers. `consume` runs
// while the response is still in the data window, before the window is released
// back to the watch loop. Returns null if the host has no such file.
function fileRequest(
  sab: SharedArrayBuffer,
  op: number,
  path: string,
  offset: number,
  consume?: (result: number, data: Uint8Array) => void,
): number | null {
  const i32 = new Int32Array(sab);
  const u8 = new Uint8Array(sab);

  const pathBytes = new TextEncoder().encode(path);
  if (pathBytes.byteLength > SAB_MAX_PATH) return null;

  u8.set(pathBytes, SAB_PATH_OFFSET);
  Atomics.store(i32, SAB_PATH_LEN_IDX, pathBytes.byteLength);
  Atomics.store(i32, SAB_OP_IDX, op);
  Atomics.store(i32, SAB_OFFSET_IDX, offset);
  Atomics.store(i32, SAB_STATUS_IDX, STATUS_PENDING);
  Atomics.notify(i32, SAB_STATUS_IDX);

  // Block until the main thread responds (status changes away from pending).
  Atomics.wait(i32, SAB_STATUS_IDX, STATUS_PENDING);

  let result: number | null = null;
  if (Atomics.load(i32, SAB_STATUS_IDX) === STATUS_READY) {
    result = Atomics.load(i32, SAB_RESULT_IDX);
    consume?.(result, u8);
  }

  // Reset to idle so the main thread's watch loop can block again.
  Atomics.store(i32, SAB_STATUS_IDX, STATUS_IDLE);
  Atomics.notify(i32, SAB_STATUS_IDX);
  return result;
}

// Read a whole file from the host, one data window at a time. Size is asked for
// first so the file lands in a single allocation; the host serves every chunk of
// it from one provider call.
function fetchFileSync(sab: SharedArrayBuffer, path: string): Uint8Array | null {
  const size = fileRequest(sab, OP_SIZE, path, 0);
  if (size === null) return null;

  const file = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const at = offset;
    const read = fileRequest(sab, OP_READ, path, at, (length, data) => {
      file.set(data.subarray(SAB_DATA_OFFSET, SAB_DATA_OFFSET + length), at);
    });
    if (read === null || read === 0) return null; // host lost the file mid-read
    offset += read;
  }
  return file;
}

function ensureDirs(FS: Record<string, (...a: unknown[]) => unknown>, path: string): void {
  const parts = path.split('/');
  let current = '';
  for (let i = 1; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!p) continue;
    current += '/' + p;
    try {
      (FS['mkdir'] as (p: string) => void)(current);
    } catch {
      /* already exists */
    }
  }
}

function installFSBridge(sab: SharedArrayBuffer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const FS = (mod as any).FS as Record<string, unknown> | undefined;
  if (!FS || typeof FS['open'] !== 'function') return;

  // Paths whose fetch returned null — skip re-requesting them.
  const notFound = new Set<string>();

  // Ensure path is in MEMFS, fetching from the provider if needed. Called
  // before stat and open so LLDB's existence check populates the file first.
  const ensure = (path: string): void => {
    if (!path || !path.startsWith('/') || notFound.has(path)) return;
    try {
      (FS['lookupPath'] as (p: string) => unknown)(path);
      return; // already in MEMFS
    } catch (e: unknown) {
      if (!e || (e as { errno?: number }).errno !== 44) return; // not ENOENT
    }
    const data = fetchFileSync(sab, path);
    if (!data) {
      notFound.add(path);
      return;
    }
    ensureDirs(FS as Record<string, (...a: unknown[]) => unknown>, path);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod as any).FS.writeFile(path, data);
  };

  // Intercept stat so LLDB's existence check populates the file before open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origStat = (FS['stat'] as ((...a: any[]) => unknown) | undefined)?.bind(FS);
  if (origStat) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FS['stat'] = (path: string, dontFollow: unknown): unknown => {
      ensure(path);
      return origStat(path, dontFollow);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origOpen = (FS['open'] as (...a: any[]) => unknown).bind(FS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FS['open'] = (path: string, flags: number, mode: number): unknown => {
    if ((flags & 3) === 0) ensure(path); // read-only opens
    return origOpen(path, flags, mode);
  };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const dispatch = makeDispatch();

(async () => {
  const port = await getPort();

  port.onMessage(async (data: unknown) => {
    const req = data as Request;

    // Special init message: load the wasm module.
    if (req.method === 'init') {
      const initReq = req as {
        id: number;
        method: 'init';
        wasmJsUrl: string;
        fileSAB: SharedArrayBuffer;
      };
      try {
        const { default: createLLDB } = await import(initReq.wasmJsUrl);
        mod = (await createLLDB()) as LLDBMod;
        installFSBridge(initReq.fileSAB);
        ccall('lldb_wasm_initialize', null, [], []);
        handle = ccall('lldb_wasm_create_debugger', 'number', [], []) as number;
        if (!handle) throw new Error('lldb_wasm_create_debugger returned 0');
        const ready: ReadyMessage = { type: 'ready' };
        port.postMessage(ready);
        const res: Response = { id: initReq.id, result: undefined };
        port.postMessage(res);
      } catch (err) {
        const msg: ErrorMessage = { type: 'error', message: String(err) };
        port.postMessage(msg);
        const res: Response = { id: initReq.id, error: String(err) };
        port.postMessage(res);
      }
      return;
    }

    const handler = dispatch.get(req.method);
    if (!handler) {
      const res: Response = {
        id: req.id,
        error: `unknown method: ${req.method}`,
      };
      port.postMessage(res);
      return;
    }

    try {
      const result = handler((req as { args: unknown[] }).args ?? []);
      const res: Response = { id: req.id, result };
      port.postMessage(res);
    } catch (err) {
      const res: Response = { id: req.id, error: String(err) };
      port.postMessage(res);
    }
  });

  // Patch port.postMessage into the stop event emitter so checkForStop can use it.
  (globalThis as Record<string, unknown>).__lldbWorkerPort = port;
})();
