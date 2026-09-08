import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLDBClient } from '../dist/index.js';
import type { Logger } from '../dist/index.js';

type MessageHandler = (event: MessageEvent<unknown>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

class FakeWorker {
  static current: FakeWorker | null = null;

  readonly #messageHandlers = new Set<MessageHandler>();
  readonly #errorHandlers = new Set<ErrorHandler>();
  readonly #heldSessions = new Map<number, string>();

  constructor(_url: URL, _options?: { type: string }) {
    FakeWorker.current = this;
  }

  addEventListener(type: string, callback: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.#messageHandlers.add(callback as MessageHandler);
    else if (type === 'error') this.#errorHandlers.add(callback as ErrorHandler);
  }

  removeEventListener(type: string, callback: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.#messageHandlers.delete(callback as MessageHandler);
    else if (type === 'error') this.#errorHandlers.delete(callback as ErrorHandler);
  }

  postMessage(value: unknown): void {
    const request = value as {
      id: number;
      method: string;
      args?: unknown[];
      operationId?: number;
    };
    queueMicrotask(() => {
      if (request.method === 'init') {
        this.emit({ type: 'ready' });
        this.emit({ id: request.id });
        return;
      }

      if (request.operationId !== undefined) {
        this.emit({ type: 'operationStarted', id: request.operationId });
      }

      if (request.method.startsWith('session')) {
        const operationId = request.args?.[0] as number;
        const command = String(request.args?.[1] ?? '');
        this.emit({ id: request.id });
        if (command === 'hold') {
          this.#heldSessions.set(operationId, command);
          return;
        }
        this.emit({ type: 'operationStarted', id: operationId });
        this.emit({
          type: 'sessionResult',
          id: operationId,
          json: JSON.stringify({ output: '', error: '', status: 1 }),
        });
        return;
      }

      let result: unknown;
      if (request.method === 'createChannel') result = 17;
      else if (request.method === 'runCommand') {
        const failed = request.args?.[0] === 'bad command';
        result = {
          output: '',
          error: failed ? 'unknown command' : '',
          status: failed ? 6 : 1,
        };
      }
      this.emit({ id: request.id, result });
    });
  }

  terminate(): void {}

  fail(message: string): void {
    for (const callback of this.#errorHandlers) callback({ message } as ErrorEvent);
  }

  private emit(data: unknown): void {
    for (const callback of this.#messageHandlers) {
      callback({ data } as MessageEvent<unknown>);
    }
  }
}

function recordingLogger(): { logger: Logger; lines: Record<keyof Logger, string[]> } {
  const lines: Record<keyof Logger, string[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    lines,
    logger: {
      debug: (message) => lines.debug.push(message),
      info: (message) => lines.info.push(message),
      warn: (message) => lines.warn.push(message),
      error: (message) => lines.error.push(message),
    },
  };
}

const originalWorker = globalThis.Worker;

beforeEach(() => {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  FakeWorker.current = null;
});

describe('logging', () => {
  it('accepts the shared Logger shape and records worker and RPC lifecycle', async () => {
    const { logger, lines } = recordingLogger();
    const client = await LLDBClient.create({ logger });

    expect(lines.debug.some((line) => line.includes('worker.started'))).toBe(true);
    expect(lines.debug.some((line) => line.includes('rpc.opened'))).toBe(true);
    expect(lines.debug.some((line) => line.includes('worker.ready'))).toBe(true);

    await client.destroy();

    expect(lines.debug.some((line) => line.includes('rpc.closed'))).toBe(true);
    expect(lines.debug.some((line) => line.includes('worker.exited'))).toBe(true);
  });

  it('records queued, native-started, and completed session commands with one ID', async () => {
    const { logger, lines } = recordingLogger();
    const client = await LLDBClient.create({ logger });
    await client.sessionCommand('thread backtrace');

    const lifecycle = lines.debug.filter((line) => line.includes('operation.'));
    expect(lifecycle).toHaveLength(3);
    expect(lifecycle[0]).toMatch(/operation\.queued .*"id":1.*"command":"thread backtrace"/);
    expect(lifecycle[1]).toMatch(/operation\.started .*"id":1.*"queueDurationMs":\d+/);
    expect(lifecycle[2]).toMatch(/operation\.completed .*"id":1.*"durationMs":\d+/);

    await client.destroy();
  });

  it('records LLDB command failures and all outstanding operation IDs', async () => {
    const { logger, lines } = recordingLogger();
    const client = await LLDBClient.create({ logger });
    const held = client.sessionCommand('hold');
    await Promise.resolve();

    const result = await client.runCommand('bad command');
    expect(result.status).toBe(6);
    expect(lines.error).toContainEqual(
      expect.stringMatching(
        /operation\.failed .*"id":2.*"error":"unknown command".*"outstandingOperationIds":\[1,2\]/,
      ),
    );

    const rejected = expect(held).rejects.toThrow('destroyed');
    await client.destroy();
    await rejected;
  });

  it('rejects outstanding work and logs its IDs when the worker errors', async () => {
    const { logger, lines } = recordingLogger();
    const client = await LLDBClient.create({ logger });
    const held = client.sessionCommand('hold');
    await Promise.resolve();

    const rejected = expect(held).rejects.toThrow('worker crashed');
    FakeWorker.current?.fail('worker crashed');
    await rejected;

    expect(lines.error).toContainEqual(
      expect.stringMatching(/worker\.errored .*"outstandingOperationIds":\[1\]/),
    );
    expect(lines.error).toContainEqual(
      expect.stringMatching(/operation\.failed .*"id":1.*"outstandingOperationIds":\[1\]/),
    );
    await client.destroy();
  });
});
