import type { Response, WorkerMessage } from './protocol.js';
import type {
  CommandResult,
  ExpressionResult,
  FrameInfo,
  LLDBClientOptions,
  StopReason,
  Variable,
} from './types.js';

export class LLDBClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #stopListeners: Array<(r: StopReason) => void> = [];
  #nextId = 0;
  #destroyed = false;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if ('type' in msg) {
        if (msg.type === 'event') {
          for (const cb of this.#stopListeners) cb(msg.event);
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
    const worker = new Worker(workerUrl, { type: 'module' });

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

      const wasmJsUrl =
        options.wasmJsUrl ??
        new URL('../wasm/lldb-wasm.js', import.meta.url).href;

      const id = client.#nextId++;
      client.#pending.set(id, { resolve: () => {}, reject });
      worker.postMessage({ id, method: 'init', wasmJsUrl });
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

  resume(): Promise<void>   { return this.call('resume'); }
  pause(): Promise<void>    { return this.call('pause'); }
  stepOver(): Promise<void> { return this.call('stepOver'); }
  stepInto(): Promise<void> { return this.call('stepInto'); }
  stepOut(): Promise<void>  { return this.call('stepOut'); }

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

  async channelServerRead(channelId: number, maxBytes: number, timeoutMs = 1000): Promise<Uint8Array> {
    const arr = await this.call<number[]>('channelServerRead', channelId, maxBytes, timeoutMs);
    return new Uint8Array(arr);
  }

  destroyChannel(channelId: number): Promise<void> {
    return this.call('destroyChannel', channelId);
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

  destroy(): void {
    this.#destroyed = true;
    const err = new Error('LLDBClient has been destroyed');
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    this.#worker.terminate();
  }
}
