// Test setup: polyfill the browser Worker API using Node's worker_threads.
// Our LLDBClient uses `new Worker(url, { type: 'module' })` and then
// calls addEventListener/removeEventListener on it, which are browser APIs.
// This adapter maps them onto worker_threads' event emitter interface.

import { Worker as NodeWorker } from 'node:worker_threads';

class WorkerPolyfill extends EventTarget {
  readonly #worker: InstanceType<typeof NodeWorker>;

  constructor(url: URL | string, options?: WorkerOptions) {
    super();
    this.#worker = new NodeWorker(url, {
      // worker_threads understands 'module' type for ESM workers.
      workerData: null,
    });
    this.#worker.on('message', (data: unknown) => {
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
    });
    this.#worker.on('error', (err: Error) => {
      this.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));
    });
    this.#worker.on('exit', (code: number) => {
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    });
  }

  postMessage(data: unknown): void {
    this.#worker.postMessage(data);
  }

  terminate(): void {
    void this.#worker.terminate();
  }
}

if (typeof globalThis.Worker === 'undefined') {
  (globalThis as Record<string, unknown>).Worker = WorkerPolyfill;
}
