// Internal message protocol between LLDBClient (main thread) and the Worker.

import type { StopReason } from './types.js';

// Main thread → Worker
export type Request =
  | {
      id: number;
      method: 'init';
      wasmJsUrl: string;
      fileSAB: SharedArrayBuffer;
    }
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

// Worker → Main thread (unsolicited, interactive interpreter stdout/stderr)
export interface OutputEvent {
  type: 'output';
  data: number[];
}

// Worker → Main thread (unsolicited, interpreter exited via quit/EOF)
export interface InterpreterExitEvent {
  type: 'interpreterExit';
}

// Worker → Main thread (unsolicited, DAP stdout bytes)
export interface DAPOutputEvent {
  type: 'dapOutput';
  data: number[];
}

// Worker → Main thread (unsolicited, DAP loop exited)
export interface DAPExitEvent {
  type: 'dapExit';
  error?: string;
}

// Worker → Main thread (unsolicited, bytes LLDB wrote to a bridged channel's
// server side; the embedder forwards these to its socket/transport)
export interface ChannelDataEvent {
  type: 'channelData';
  channelId: number;
  data: number[];
}

// Worker → Main thread (a session op submitted earlier has completed)
export interface SessionResultEvent {
  type: 'sessionResult';
  id: number;
  json: string;
}

// Worker → Main thread (once wasm is loaded and LLDB is initialized)
export interface ReadyMessage {
  type: 'ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerMessage =
  | Response
  | StopEvent
  | OutputEvent
  | InterpreterExitEvent
  | DAPOutputEvent
  | DAPExitEvent
  | ChannelDataEvent
  | SessionResultEvent
  | ReadyMessage
  | ErrorMessage;
