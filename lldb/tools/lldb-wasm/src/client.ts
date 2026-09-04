import type { Response, WorkerMessage } from './protocol.js';
import { watchForFileRequests, SAB_SIZE } from './fileprovider.js';
import type {
  CommandResult,
  DAPOptions,
  DAPSession,
  ExpressionResult,
  FileProvider,
  FrameInfo,
  LLDBClientOptions,
  SessionVariable,
  StopReason,
  Variable,
} from './types.js';

class DAPSessionImpl implements DAPSession {
  readonly #listeners: Array<(data: Uint8Array) => void> = [];
  readonly #write: (data: Uint8Array) => Promise<void>;
  readonly #close: () => Promise<void>;
  readonly done: Promise<void>;
  #resolveDone!: () => void;
  #rejectDone!: (error: Error) => void;
  #finished = false;
  #closed = false;

  constructor(write: (data: Uint8Array) => Promise<void>, close: () => Promise<void>) {
    this.#write = write;
    this.#close = close;
    this.done = new Promise<void>((resolve, reject) => {
      this.#resolveDone = resolve;
      this.#rejectDone = reject;
    });
  }

  write(data: Uint8Array): Promise<void> {
    if (this.#finished) return Promise.reject(new Error('DAP session has exited'));
    return this.#write(data);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return this.#close();
  }

  onData(callback: (data: Uint8Array) => void): void {
    this.#listeners.push(callback);
  }

  emit(data: Uint8Array): void {
    for (const callback of this.#listeners) callback(data);
  }

  finish(error?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    if (error) this.#rejectDone(new Error(error));
    else this.#resolveDone();
  }
}

// Minimal Worker surface LLDBClient relies on. In the browser this is the DOM
// Worker; in Node it is an adapter over worker_threads (see makeWorker).
interface WorkerLike {
  addEventListener(type: 'message', cb: (e: MessageEvent<WorkerMessage>) => void): void;
  removeEventListener(type: 'message', cb: (e: MessageEvent<WorkerMessage>) => void): void;
  postMessage(data: unknown): void;
  terminate(): void | Promise<void>;
}

// Construct a module worker. Uses the DOM Worker when available, otherwise
// adapts Node's worker_threads to the browser Worker event interface so the
// package works unchanged under Node (e.g. when embedded in a CLI).
async function makeWorker(url: URL): Promise<WorkerLike> {
  const G = globalThis as {
    Worker?: new (u: URL, o?: { type: string }) => WorkerLike;
  };
  if (typeof G.Worker !== 'undefined') {
    return new G.Worker(url, { type: 'module' });
  }
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const w = new NodeWorker(url);
  const handlers = new Map<
    (e: MessageEvent<WorkerMessage>) => void,
    (data: WorkerMessage) => void
  >();
  return {
    addEventListener(_type, cb) {
      const h = (data: WorkerMessage) => cb({ data } as MessageEvent<WorkerMessage>);
      handlers.set(cb, h);
      w.on('message', h);
    },
    removeEventListener(_type, cb) {
      const h = handlers.get(cb);
      if (h) {
        w.off('message', h);
        handlers.delete(cb);
      }
    },
    postMessage: (data) => w.postMessage(data),
    terminate: () => w.terminate().then(() => {}),
  };
}

export class LLDBClient {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly #stopListeners: Array<(r: StopReason) => void> = [];
  readonly #outputListeners: Array<(data: Uint8Array) => void> = [];
  readonly #exitListeners: Array<() => void> = [];
  readonly #channelListeners = new Map<number, (data: Uint8Array) => void>();
  readonly #sessionPending = new Map<number, (v: unknown) => void>();
  #sessionNextId = 1;
  #nextId = 0;
  #destroyed = false;
  #fileProvider: FileProvider | null = null;
  #dapSession: DAPSessionImpl | null = null;

  private constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if ('type' in msg) {
        if (msg.type === 'event') {
          for (const cb of this.#stopListeners) cb(msg.event);
        } else if (msg.type === 'output') {
          const bytes = new Uint8Array(msg.data);
          for (const cb of this.#outputListeners) cb(bytes);
        } else if (msg.type === 'interpreterExit') {
          for (const cb of this.#exitListeners) cb();
        } else if (msg.type === 'dapOutput') {
          this.#dapSession?.emit(new Uint8Array(msg.data));
        } else if (msg.type === 'dapExit') {
          this.#dapSession?.finish(msg.error);
        } else if (msg.type === 'channelData') {
          this.#channelListeners.get(msg.channelId)?.(new Uint8Array(msg.data));
        } else if (msg.type === 'sessionResult') {
          const cb = this.#sessionPending.get(msg.id);
          if (cb) {
            this.#sessionPending.delete(msg.id);
            cb(JSON.parse(msg.json));
          }
        }
        // 'ready' and 'error' are handled during init; ignore here.
        return;
      }
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error !== undefined) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#destroyed) {
      return Promise.reject(new Error('LLDBClient has been destroyed'));
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.#worker.postMessage({ id, method, args });
    });
  }

  /**
   * Create an LLDBClient backed by a dedicated Web Worker.
   *
   * The worker loads the LLDB wasm module and handles all C API calls,
   * keeping the main thread free from any blocking operations.
   *
   * @param options.wasmJsUrl  Override the URL of lldb-wasm.js. Defaults to
   *   the copy bundled with this package.
   */
  static async create(options: LLDBClientOptions = {}): Promise<LLDBClient> {
    const workerUrl = options.workerUrl
      ? new URL(options.workerUrl)
      : new URL('./worker.js', import.meta.url);
    const worker = await makeWorker(workerUrl);

    const client = new LLDBClient(worker);

    // Wait for either 'ready' or 'error' before resolving.
    await new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (!('type' in msg)) return;
        if (msg.type === 'ready') {
          worker.removeEventListener('message', onMessage);
          resolve();
        } else if (msg.type === 'error') {
          worker.removeEventListener('message', onMessage);
          reject(new Error(msg.message));
        }
      };
      worker.addEventListener('message', onMessage);

      const wasmJsUrl = options.wasmJsUrl ?? new URL('../wasm/lldb-wasm.js', import.meta.url).href;

      const fileSAB = new SharedArrayBuffer(SAB_SIZE);

      const id = client.#nextId++;
      client.#pending.set(id, { resolve: () => {}, reject });
      worker.postMessage({ id, method: 'init', wasmJsUrl, fileSAB });

      // Start the file-provider watch loop on the main thread.
      // Runs for the lifetime of this client; exits when #destroyed is true.
      void watchForFileRequests(
        fileSAB,
        () => client.#fileProvider,
        () => client.#destroyed,
      );
    });

    return client;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  connect(url: string): Promise<void> {
    return this.call('connect', url);
  }

  disconnect(): Promise<void> {
    return this.call('disconnect');
  }

  // -------------------------------------------------------------------------
  // Module loading
  // -------------------------------------------------------------------------

  attachWasmModule(name: string, bytes: Uint8Array): Promise<void> {
    return this.call('attachWasmModule', name, Array.from(bytes));
  }

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  setBreakpoint(file: string, line: number): Promise<number> {
    return this.call('setBreakpoint', file, line);
  }

  setBreakpointByAddress(address: bigint): Promise<number> {
    const lo = Number(address & 0xffffffffn);
    const hi = Number((address >> 32n) & 0xffffffffn);
    return this.call('setBreakpointByAddress', lo, hi);
  }

  removeBreakpoint(id: number): Promise<void> {
    return this.call('removeBreakpoint', id);
  }

  enableBreakpoint(id: number, enable: boolean): Promise<void> {
    return this.call('enableBreakpoint', id, enable);
  }

  // -------------------------------------------------------------------------
  // Execution control
  // -------------------------------------------------------------------------

  resume(): Promise<void> {
    return this.call('resume');
  }
  pause(): Promise<void> {
    return this.call('pause');
  }
  stepOver(): Promise<void> {
    return this.call('stepOver');
  }
  stepInto(): Promise<void> {
    return this.call('stepInto');
  }
  stepOut(): Promise<void> {
    return this.call('stepOut');
  }

  // -------------------------------------------------------------------------
  // State inspection
  // -------------------------------------------------------------------------

  getStopReason(): Promise<StopReason> {
    return this.call('getStopReason');
  }

  getNumThreads(): Promise<number> {
    return this.call('getNumThreads');
  }

  getNumFrames(): Promise<number> {
    return this.call('getNumFrames');
  }

  getStackTrace(): Promise<FrameInfo[]> {
    return this.call('getStackTrace');
  }

  getVariables(frameIndex = 0): Promise<Variable[]> {
    return this.call('getVariables', frameIndex);
  }

  async readMemory(address: bigint, size: number): Promise<Uint8Array> {
    const lo = Number(address & 0xffffffffn);
    const hi = Number((address >> 32n) & 0xffffffffn);
    const arr = await this.call<number[]>('readMemory', lo, hi, size);
    return new Uint8Array(arr);
  }

  evaluateExpression(expression: string, frameIndex = 0): Promise<ExpressionResult> {
    return this.call('evaluateExpression', expression, frameIndex);
  }

  // -------------------------------------------------------------------------
  // Command interpreter
  // -------------------------------------------------------------------------

  runCommand(command: string): Promise<CommandResult> {
    return this.call('runCommand', command);
  }

  // -------------------------------------------------------------------------
  // Interactive command interpreter
  // -------------------------------------------------------------------------

  /**
   * Start the genuine LLDB command-interpreter REPL. Output is delivered via
   * onOutput(); feed user input with writeStdin(). The REPL runs until the
   * user quits or closeStdin() is called, after which onInterpreterExit()
   * fires. This makes the embedded debugger behave like a real interactive
   * lldb when wired to a terminal's stdin/stdout.
   */
  runInterpreter(): Promise<void> {
    return this.call('runInterpreter');
  }

  /** Feed bytes (e.g. a typed line) to the interpreter's stdin. */
  writeStdin(data: Uint8Array): Promise<void> {
    return this.call('consoleStdinWrite', Array.from(data));
  }

  /** Signal end-of-input (Ctrl-D); the interpreter exits its read loop. */
  closeStdin(): Promise<void> {
    return this.call('consoleStdinClose');
  }

  /** Register a callback for interpreter stdout/stderr bytes. */
  onOutput(callback: (data: Uint8Array) => void): void {
    this.#outputListeners.push(callback);
  }

  /** Register a callback fired when the interpreter REPL exits. */
  onInterpreterExit(callback: () => void): void {
    this.#exitListeners.push(callback);
  }

  // -------------------------------------------------------------------------
  // Debug Adapter Protocol
  // -------------------------------------------------------------------------

  /** Start LLDB's built-in DAP server and return its byte-stream session. */
  async startDAP(options: DAPOptions = {}): Promise<DAPSession> {
    if (this.#dapSession) throw new Error('a DAP session has already been started');
    const session = new DAPSessionImpl(
      async (data) => {
        await this.call('dapStdinWrite', Array.from(data));
      },
      () => this.call('dapStdinClose'),
    );
    this.#dapSession = session;
    try {
      await this.call(
        'dapStart',
        JSON.stringify(options.preInitCommands ?? []),
        options.noLldbInit ?? true,
      );
    } catch (error) {
      this.#dapSession = null;
      throw error;
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // In-process channel (for GDB server in the same wasm module)
  // -------------------------------------------------------------------------

  createChannel(): Promise<number> {
    return this.call('createChannel');
  }

  connectInProcess(channelId: number): Promise<void> {
    return this.call('connectInProcess', channelId);
  }

  async channelServerWrite(channelId: number, data: Uint8Array): Promise<number> {
    return this.call('channelServerWrite', channelId, Array.from(data));
  }

  async channelServerRead(
    channelId: number,
    maxBytes: number,
    timeoutMs = 1000,
  ): Promise<Uint8Array> {
    const arr = await this.call<number[]>('channelServerRead', channelId, maxBytes, timeoutMs);
    return new Uint8Array(arr);
  }

  destroyChannel(channelId: number): Promise<void> {
    this.#channelListeners.delete(channelId);
    return this.call('destroyChannel', channelId);
  }

  /**
   * Bridge a channel to an external transport (e.g. a TCP socket). `onData`
   * receives bytes LLDB writes to the channel; forward them to your transport.
   * Feed bytes from your transport back into LLDB with channelServerWrite().
   * Used to connect the in-wasm LLDB to an out-of-process GDB/platform server.
   */
  bridgeChannel(channelId: number, onData: (data: Uint8Array) => void): Promise<void> {
    this.#channelListeners.set(channelId, onData);
    return this.call('bridgeChannelStart', channelId);
  }

  unbridgeChannel(channelId: number): Promise<void> {
    this.#channelListeners.delete(channelId);
    return this.call('bridgeChannelStop', channelId);
  }

  // -------------------------------------------------------------------------
  // Session ops — structured SB-API queries that run on the off-worker session
  // thread, so they can block on GDB-remote round-trips while the worker keeps
  // pumping a bridged transport. This is the API the Node e2e suite drives.
  // -------------------------------------------------------------------------

  async #sessionCall<T>(method: string, ...args: unknown[]): Promise<T> {
    const sessionId = this.#sessionNextId++;
    const result = new Promise<T>((resolve) => {
      this.#sessionPending.set(sessionId, resolve as (v: unknown) => void);
    });
    await this.call(method, sessionId, ...args); // submit (returns immediately)
    return result;
  }

  /** Run an lldb command line (e.g. "process attach", "continue", "breakpoint set -n f"). */
  sessionCommand(command: string): Promise<CommandResult> {
    return this.#sessionCall('sessionCommand', command);
  }

  /** Current process/thread stop reason. */
  sessionState(): Promise<StopReason> {
    return this.#sessionCall('sessionState');
  }

  /** Selected thread's call stack. */
  sessionFrames(): Promise<FrameInfo[]> {
    return this.#sessionCall('sessionFrames');
  }

  /** Look up a variable by name in a frame. */
  sessionVariable(frameIndex: number, name: string): Promise<SessionVariable> {
    return this.#sessionCall('sessionVariable', frameIndex, name);
  }

  // -------------------------------------------------------------------------
  // Virtual filesystem / file provider
  // -------------------------------------------------------------------------

  /**
   * Register a callback that LLDB calls when it needs to read a source file
   * that does not already exist in the in-memory filesystem.
   *
   * The path argument is whatever the DWARF debug info recorded at compile
   * time (e.g. /home/user/project/src/main.c). Return the raw file bytes, or
   * null if the file is unavailable. Once fetched the file is cached in MEMFS
   * and the callback is not called again for the same path.
   *
   * In Firefox DevTools this is typically wired to IOUtils.read() or to
   * a source-map resolver.
   *
   * @example
   * lldb.setFileProvider(async (path) => {
   *   try { return await IOUtils.read(path); }
   *   catch { return null; }
   * });
   */
  setFileProvider(provider: FileProvider | null): void {
    this.#fileProvider = provider;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onStop(callback: (reason: StopReason) => void): void {
    this.#stopListeners.push(callback);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Tear down the client. Returns a promise that resolves once the worker (and
   * its wasm pthreads) have fully terminated. Await it before creating another
   * client in the same process, otherwise the new worker can race the old one's
   * teardown.
   */
  destroy(): void | Promise<void> {
    this.#destroyed = true;
    this.#dapSession?.finish();
    const err = new Error('LLDBClient has been destroyed');
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    return this.#worker.terminate();
  }
}
