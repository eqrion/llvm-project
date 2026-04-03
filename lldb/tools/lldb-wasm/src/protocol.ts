// Internal message protocol between LLDBClient (main thread) and the Worker.

import type { StopReason } from './types.js';

// Main thread → Worker
export type Request =
  | { id: number; method: 'init'; wasmJsUrl: string }
  | { id: number; method: string; args: unknown[] };

// Worker → Main thread (in response to a Request)
export interface Response {
  id: number;
  result?: unknown;
  error?: string;
}

// Worker → Main thread (unsolicited, when the process stops)
export interface StopEvent {
  type: 'event';
  event: StopReason;
}

// Worker → Main thread (once wasm is loaded and LLDB is initialized)
export interface ReadyMessage {
  type: 'ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerMessage = Response | StopEvent | ReadyMessage | ErrorMessage;
