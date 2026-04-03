// Worker script: loads the LLDB wasm module and handles all C API calls.
// Runs inside a dedicated Web Worker (browser) or worker_threads Worker (Node).

import type { Request, Response, StopEvent, ReadyMessage, ErrorMessage } from './protocol.js';
import type { StopReason } from './types.js';

// ---------------------------------------------------------------------------
// Environment abstraction: browser Web Worker vs Node worker_threads
// ---------------------------------------------------------------------------

interface WorkerPort {
  onMessage(handler: (data: unknown) => void): void;
  postMessage(data: unknown): void;
}

async function getPort(): Promise<WorkerPort> {
  // Browser DedicatedWorkerGlobalScope has self.postMessage.
  if (typeof self !== 'undefined' && typeof (self as { postMessage?: unknown }).postMessage === 'function') {
    const w = self as DedicatedWorkerGlobalScope;
    return {
      onMessage: (h) => { w.onmessage = (e: MessageEvent) => h(e.data); },
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
      const ret = ccall('lldb_wasm_connect', 'number',
        ['number', 'string', 'number', 'number'],
        [handle, url, errBuf, errBufLen]);
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
    const ret = ccall('lldb_wasm_attach_wasm_module', 'number',
      ['number', 'string', 'number', 'number'],
      [handle, name, buf, bytes.byteLength]);
    mod._free(buf);
    if (ret !== 0) throw new Error(`failed to attach module: ${name}`);
  });

  d.set('setBreakpoint', ([file, line]: unknown[]) => {
    const id = ccall('lldb_wasm_set_breakpoint_by_location', 'number',
      ['number', 'string', 'number'], [handle, file, line]);
    if (!id) throw new Error(`failed to set breakpoint at ${file}:${line}`);
    return id;
  });

  d.set('setBreakpointByAddress', ([lo, hi]: unknown[]) => {
    const id = ccall('lldb_wasm_set_breakpoint_by_address', 'number',
      ['number', 'number', 'number'], [handle, lo, hi]);
    if (!id) throw new Error(`failed to set breakpoint at address`);
    return id;
  });

  d.set('removeBreakpoint', ([bpId]: unknown[]) => {
    ccall('lldb_wasm_remove_breakpoint', 'number', ['number', 'number'], [handle, bpId]);
  });

  d.set('enableBreakpoint', ([bpId, enable]: unknown[]) => {
    ccall('lldb_wasm_enable_breakpoint', null,
      ['number', 'number', 'number'], [handle, bpId, enable ? 1 : 0]);
  });

  d.set('resume', () => {
    const ret = ccall('lldb_wasm_resume', 'number', ['number'], [handle]);
    if (ret !== 0) throw new Error('resume failed');
  });

  d.set('pause', () => {
    const ret = ccall('lldb_wasm_pause', 'number', ['number'], [handle]);
    if (ret !== 0) throw new Error('pause failed');
  });

  d.set('stepOver', () => { ccall('lldb_wasm_step_over', 'number', ['number'], [handle]); });
  d.set('stepInto', () => { ccall('lldb_wasm_step_into', 'number', ['number'], [handle]); });
  d.set('stepOut',  () => { ccall('lldb_wasm_step_out',  'number', ['number'], [handle]); });

  d.set('getStopReason', () => {
    const ptr = ccall('lldb_wasm_get_stop_reason', 'number', ['number'], [handle]) as number;
    return JSON.parse(getAndFreeString(ptr)) as StopReason;
  });

  d.set('getNumThreads', () =>
    ccall('lldb_wasm_get_num_threads', 'number', ['number'], [handle]));

  d.set('getNumFrames', () =>
    ccall('lldb_wasm_get_num_frames', 'number', ['number'], [handle]));

  d.set('getStackTrace', () => {
    const ptr = ccall('lldb_wasm_get_frame_info', 'number', ['number'], [handle]) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('getVariables', ([frameIndex = 0]: unknown[]) => {
    const ptr = ccall('lldb_wasm_get_variables_json', 'number',
      ['number', 'number'], [handle, frameIndex]) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('readMemory', ([lo, hi, size]: unknown[]) => {
    const buf = mod._malloc(size as number);
    const bytesReadBuf = mod._malloc(4);
    try {
      const ret = ccall('lldb_wasm_read_memory', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number'],
        [handle, lo, hi, buf, size, bytesReadBuf]);
      if (ret !== 0) throw new Error('readMemory failed');
      const n = mod.HEAPU32[bytesReadBuf >> 2] ?? 0;
      return Array.from(mod.HEAPU8.subarray(buf, buf + n));
    } finally {
      mod._free(buf);
      mod._free(bytesReadBuf);
    }
  });

  d.set('evaluateExpression', ([expr, frameIndex = 0]: unknown[]) => {
    const ptr = ccall('lldb_wasm_evaluate_expression', 'number',
      ['number', 'number', 'string'], [handle, frameIndex, expr]) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('runCommand', ([command]: unknown[]) => {
    const ptr = ccall('lldb_wasm_run_command', 'number',
      ['number', 'string'], [handle, command]) as number;
    return JSON.parse(getAndFreeString(ptr));
  });

  d.set('createChannel', () =>
    ccall('lldb_wasm_create_channel', 'number', [], []));

  d.set('connectInProcess', ([channelId]: unknown[]) => {
    const ret = ccall('lldb_wasm_connect_inprocess', 'number',
      ['number', 'number'], [handle, channelId]);
    if (ret !== 0) throw new Error('connectInProcess failed');
    startPoll();
  });

  d.set('channelServerWrite', ([channelId, data]: unknown[]) => {
    const bytes = data as number[];
    const buf = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, buf);
    const n = ccall('lldb_wasm_channel_server_write', 'number',
      ['number', 'number', 'number'], [channelId, buf, bytes.length]);
    mod._free(buf);
    return n;
  });

  d.set('channelServerRead', ([channelId, maxBytes, timeoutMs = 1000]: unknown[]) => {
    const buf = mod._malloc(maxBytes as number);
    try {
      const n = ccall('lldb_wasm_channel_server_read', 'number',
        ['number', 'number', 'number', 'number'],
        [channelId, buf, maxBytes, timeoutMs]) as number;
      return n > 0 ? Array.from(mod.HEAPU8.subarray(buf, buf + n)) : [];
    } finally {
      mod._free(buf);
    }
  });

  d.set('destroyChannel', ([channelId]: unknown[]) => {
    ccall('lldb_wasm_destroy_channel', null, ['number'], [channelId]);
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
// Message handler
// ---------------------------------------------------------------------------

const dispatch = makeDispatch();

(async () => {
  const port = await getPort();

  port.onMessage(async (data: unknown) => {
    const req = data as Request;

    // Special init message: load the wasm module.
    if (req.method === 'init') {
      const initReq = req as { id: number; method: 'init'; wasmJsUrl: string };
      try {
        const { default: createLLDB } = await import(initReq.wasmJsUrl);
        mod = await createLLDB() as LLDBMod;
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
      const res: Response = { id: req.id, error: `unknown method: ${req.method}` };
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
