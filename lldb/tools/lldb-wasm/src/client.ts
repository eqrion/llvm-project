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
  Logger,
  SessionVariable,
  StopReason,
  Variable,
} from './types.js';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

type LogLevel = keyof Logger;

// These are byte-pump calls and can occur for every transport packet. Their
// channel lifecycle is logged separately; per-call logs would bury the useful
// debugger operations in noise.
const untrackedMethods = new Set([
  'channelServerRead',
  'channelServerWrite',
  'consoleStdinWrite',
  'dapStdinWrite',
]);

function log(logger: Logger, level: LogLevel, event: string, fields: object = {}): void {
  try {
    logger[level](`[lldb-wasm] ${event} ${JSON.stringify(fields)}`);
  } catch {
    // Diagnostics must never affect debugger control flow.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): number {
  return performance.now();
}

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
  onError(cb: (error: Error) => void): void;
  onExit(cb: (code?: number) => void): void;
}

interface BrowserWorkerLike {
  addEventListener(type: 'message', cb: (e: MessageEvent<WorkerMessage>) => void): void;
  addEventListener(type: 'error', cb: (e: ErrorEvent) => void): void;
  removeEventListener(type: 'message', cb: (e: MessageEvent<WorkerMessage>) => void): void;
  postMessage(data: unknown): void;
  terminate(): void;
}

// Construct a module worker. Uses the DOM Worker when available, otherwise
// adapts Node's worker_threads to the browser Worker event interface so the
// package works unchanged under Node (e.g. when embedded in a CLI).
async function makeWorker(url: URL): Promise<WorkerLike> {
  const G = globalThis as {
    Worker?: new (u: URL, o?: { type: string }) => BrowserWorkerLike;
  };
  if (typeof G.Worker !== 'undefined') {
    const worker = new G.Worker(url, { type: 'module' });
    return {
      addEventListener: (type, cb) => worker.addEventListener(type, cb),
      removeEventListener: (type, cb) => worker.removeEventListener(type, cb),
      postMessage: (data) => worker.postMessage(data),
      terminate: () => worker.terminate(),
      onError: (cb) =>
        worker.addEventListener('error', (event) => cb(new Error(event.message || 'worker error'))),
      // DedicatedWorker has no exit event. destroy() records termination after
      // terminate() returns; runtime failures arrive through the error event.
      onExit() {},
    };
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
    onError: (cb) => w.on('error', cb),
    onExit: (cb) => w.on('exit', cb),
  };
}

interface Operation {
  method: string;
  command?: string;
  queuedAt: number;
  startedAt?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  operationId?: number;
}

interface PendingSessionOperation {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class LLDBClient {
  readonly #worker: WorkerLike;
  readonly #logger: Logger;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #operations = new Map<number, Operation>();
  readonly #stopListeners: Array<(r: StopReason) => void> = [];
  readonly #outputListeners: Array<(data: Uint8Array) => void> = [];
  readonly #exitListeners: Array<() => void> = [];
  readonly #channelListeners = new Map<number, (data: Uint8Array) => void>();
  readonly #sessionPending = new Map<number, PendingSessionOperation>();
  #nextId = 0;
  #nextOperationId = 1;
  #destroyed = false;
  #rpcClosed = false;
  #workerErrorReported = false;
  #workerExited = false;
  #destroyPromise: Promise<void> | null = null;
  #fileProvider: FileProvider | null = null;
  #dapSession: DAPSessionImpl | null = null;

  private constructor(worker: WorkerLike, logger: Logger) {
    this.#worker = worker;
    this.#logger = logger;
    log(this.#logger, 'debug', 'rpc.opened');
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
          const pending = this.#sessionPending.get(msg.id);
          if (pending) {
            this.#sessionPending.delete(msg.id);
            try {
              const result: unknown = JSON.parse(msg.json);
              this.#finishOperation(msg.id, result);
              pending.resolve(result);
            } catch (error) {
              const parsed = new Error(`invalid session result: ${errorText(error)}`);
              this.#failOperation(msg.id, parsed);
              pending.reject(parsed);
            }
          } else {
            log(this.#logger, 'warn', 'session.result.unmatched', {
              id: msg.id,
              outstandingOperationIds: this.#outstandingOperationIds(),
            });
          }
        } else if (msg.type === 'operationStarted') {
          this.#startOperation(msg.id);
        }
        // 'ready' and 'error' are handled during init; ignore here.
        return;
      }
      const pending = this.#pending.get(msg.id);
      if (!pending) {
        log(this.#logger, 'warn', 'rpc.response.unmatched', {
          id: msg.id,
          outstandingOperationIds: this.#outstandingOperationIds(),
        });
        return;
      }
      this.#pending.delete(msg.id);
      if (msg.error !== undefined) {
        const error = new Error(msg.error);
        if (pending.operationId !== undefined) this.#failOperation(pending.operationId, error);
        pending.reject(error);
      } else {
        if (pending.operationId !== undefined) {
          this.#finishOperation(pending.operationId, msg.result);
        }
        pending.resolve(msg.result);
      }
    });
    worker.onError((error) => this.#workerFailed(error));
    worker.onExit((code) => this.#workerExitedWith(code));
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (untrackedMethods.has(method)) return this.#request(method, args);
    const operationId = this.#beginOperation(method, args);
    return this.#request(method, args, operationId);
  }

  #request<T>(method: string, args: unknown[], operationId?: number): Promise<T> {
    if (this.#destroyed) {
      const error = new Error('LLDBClient has been destroyed');
      if (operationId !== undefined) this.#failOperation(operationId, error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        operationId,
      });
      try {
        this.#worker.postMessage({ id, method, args, operationId });
      } catch (error) {
        this.#pending.delete(id);
        const posted = error instanceof Error ? error : new Error(String(error));
        if (operationId !== undefined) this.#failOperation(operationId, posted);
        reject(posted);
      }
    });
  }

  #beginOperation(method: string, args: unknown[]): number {
    const id = this.#nextOperationId++;
    const command =
      (method === 'runCommand' || method === 'sessionCommand') && typeof args[0] === 'string'
        ? args[0].slice(0, 240)
        : undefined;
    this.#operations.set(id, { method, command, queuedAt: now() });
    log(this.#logger, 'debug', 'operation.queued', {
      id,
      method,
      ...(command === undefined ? {} : { command }),
    });
    return id;
  }

  #startOperation(id: number): void {
    const operation = this.#operations.get(id);
    if (!operation || operation.startedAt !== undefined) return;
    operation.startedAt = now();
    log(this.#logger, 'debug', 'operation.started', {
      id,
      method: operation.method,
      queueDurationMs: Math.round(operation.startedAt - operation.queuedAt),
    });
  }

  #finishOperation(id: number, result: unknown): void {
    const operation = this.#operations.get(id);
    if (!operation) return;
    const durationMs = Math.round(now() - operation.queuedAt);
    const commandFailed =
      (operation.method === 'runCommand' || operation.method === 'sessionCommand') &&
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      typeof result.status === 'number' &&
      result.status >= 6;
    if (commandFailed) {
      const commandResult = result as CommandResult;
      this.#failOperation(id, new Error(commandResult.error || `LLDB status ${commandResult.status}`), {
        status: commandResult.status,
        durationMs,
      });
      return;
    }
    this.#operations.delete(id);
    log(this.#logger, 'debug', 'operation.completed', {
      id,
      method: operation.method,
      durationMs,
    });
  }

  #failOperation(id: number, error: Error, extra: object = {}): void {
    const operation = this.#operations.get(id);
    if (!operation) return;
    const outstandingOperationIds = this.#outstandingOperationIds();
    this.#operations.delete(id);
    log(this.#logger, 'error', 'operation.failed', {
      id,
      method: operation.method,
      durationMs: Math.round(now() - operation.queuedAt),
      error: error.message,
      outstandingOperationIds,
      ...extra,
    });
  }

  #outstandingOperationIds(): number[] {
    return [...this.#operations.keys()].sort((a, b) => a - b);
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
    const logger = options.logger ?? noopLogger;
    const workerUrl = options.workerUrl
      ? new URL(options.workerUrl)
      : new URL('./worker.js', import.meta.url);
    let worker: WorkerLike;
    try {
      worker = await makeWorker(workerUrl);
    } catch (error) {
      log(logger, 'error', 'worker.errored', {
        phase: 'start',
        error: errorText(error),
        outstandingOperationIds: [],
      });
      throw error;
    }
    log(logger, 'debug', 'worker.started', { workerUrl: workerUrl.href });

    const client = new LLDBClient(worker, logger);

    // Wait for either 'ready' or 'error' before resolving.
    try {
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

        const wasmJsUrl =
          options.wasmJsUrl ?? new URL('../wasm/lldb-wasm.js', import.meta.url).href;

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
    } catch (error) {
      client.#reportWorkerError(
        error instanceof Error ? error : new Error(String(error)),
        'initialization',
      );
      await client.destroy();
      throw error;
    }

    log(logger, 'debug', 'worker.ready');

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

  async createChannel(): Promise<number> {
    const channelId = await this.call<number>('createChannel');
    log(this.#logger, 'debug', 'channel.opened', { channelId });
    return channelId;
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

  async destroyChannel(channelId: number): Promise<void> {
    await this.call<void>('destroyChannel', channelId);
    this.#channelListeners.delete(channelId);
    log(this.#logger, 'debug', 'channel.closed', { channelId });
  }

  /**
   * Bridge a channel to an external transport (e.g. a TCP socket). `onData`
   * receives bytes LLDB writes to the channel; forward them to your transport.
   * Feed bytes from your transport back into LLDB with channelServerWrite().
   * Used to connect the in-wasm LLDB to an out-of-process GDB/platform server.
   */
  async bridgeChannel(channelId: number, onData: (data: Uint8Array) => void): Promise<void> {
    this.#channelListeners.set(channelId, onData);
    try {
      await this.call('bridgeChannelStart', channelId);
      log(this.#logger, 'debug', 'channel.bridge.opened', { channelId });
    } catch (error) {
      this.#channelListeners.delete(channelId);
      throw error;
    }
  }

  async unbridgeChannel(channelId: number): Promise<void> {
    await this.call('bridgeChannelStop', channelId);
    this.#channelListeners.delete(channelId);
    log(this.#logger, 'debug', 'channel.bridge.closed', { channelId });
  }

  // -------------------------------------------------------------------------
  // Session ops — structured SB-API queries that run on the off-worker session
  // thread, so they can block on GDB-remote round-trips while the worker keeps
  // pumping a bridged transport. This is the API the Node e2e suite drives.
  // -------------------------------------------------------------------------

  async #sessionCall<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#destroyed) return Promise.reject(new Error('LLDBClient has been destroyed'));
    const operationId = this.#beginOperation(method, args);
    const result = new Promise<T>((resolve, reject) => {
      this.#sessionPending.set(operationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
    try {
      // Submission returns immediately. Completion and the true started event
      // arrive separately from the native session thread, using operationId.
      await this.#request(method, [operationId, ...args]);
    } catch (error) {
      this.#sessionPending.delete(operationId);
      const submitted = error instanceof Error ? error : new Error(String(error));
      this.#failOperation(operationId, submitted);
      throw submitted;
    }
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
  destroy(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#destroyed = true;
    this.#dapSession?.finish();
    const err = new Error('LLDBClient has been destroyed');
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    for (const { reject } of this.#sessionPending.values()) reject(err);
    this.#sessionPending.clear();
    for (const id of this.#outstandingOperationIds()) this.#failOperation(id, err);
    this.#closeRpc('destroy');
    this.#destroyPromise = Promise.resolve(this.#worker.terminate()).then(() => {
      this.#workerExitedWith();
    });
    return this.#destroyPromise;
  }

  #workerFailed(error: Error): void {
    if (this.#workerExited) return;
    this.#reportWorkerError(error);
    this.#destroyed = true;
    this.#dapSession?.finish(error.message);
    this.#rejectOutstanding(error);
    this.#closeRpc('worker-error');
  }

  #reportWorkerError(error: Error, phase?: string): void {
    if (this.#workerErrorReported) return;
    this.#workerErrorReported = true;
    log(this.#logger, 'error', 'worker.errored', {
      ...(phase === undefined ? {} : { phase }),
      error: error.message,
      outstandingOperationIds: this.#outstandingOperationIds(),
    });
  }

  #workerExitedWith(code?: number): void {
    if (this.#workerExited) return;
    this.#workerExited = true;
    const outstandingOperationIds = this.#outstandingOperationIds();
    const unexpected = !this.#destroyed || outstandingOperationIds.length > 0;
    log(this.#logger, unexpected ? 'error' : 'debug', 'worker.exited', {
      ...(code === undefined ? {} : { code }),
      outstandingOperationIds,
    });
    this.#destroyed = true;
    if (unexpected) {
      const error = new Error(
        code === undefined ? 'LLDB worker exited' : `LLDB worker exited with code ${code}`,
      );
      this.#dapSession?.finish(error.message);
      this.#rejectOutstanding(error);
    }
    this.#closeRpc('worker-exit');
  }

  #rejectOutstanding(error: Error): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    for (const { reject } of this.#sessionPending.values()) reject(error);
    this.#sessionPending.clear();
    for (const id of this.#outstandingOperationIds()) this.#failOperation(id, error);
  }

  #closeRpc(reason: string): void {
    if (this.#rpcClosed) return;
    this.#rpcClosed = true;
    log(this.#logger, 'debug', 'rpc.closed', { reason });
  }
}
