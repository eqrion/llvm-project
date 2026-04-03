export interface StopReason {
  reason:
    | 'breakpoint'
    | 'step_complete'
    | 'signal'
    | 'exception'
    | 'stopped'
    | 'running'
    | 'exited'
    | 'none';
  thread_id?: number;
  bp_id?: number;
  signal_name?: string;
  exit_code?: number;
}

export interface FrameInfo {
  index: number;
  function: string;
  file?: string;
  line?: number;
  pc: string;
}

export interface Variable {
  name: string;
  type: string;
  value: string;
}

export interface CommandResult {
  output: string;
  error: string;
  status: number;
}

export type ExpressionResult =
  | { value: string; type: string; error?: never }
  | { error: string; value?: never; type?: never };

export interface LLDBClientOptions {
  /** URL of lldb-wasm.js (the Emscripten output). Defaults to the bundled copy. */
  wasmJsUrl?: string;
  /** URL of the compiled worker script. Defaults to dist/worker.js alongside the package. */
  workerUrl?: string;
}

/**
 * Called by LLDB when it needs to read a source file that is not already in
 * the in-memory filesystem. Return the file's bytes, or null if unavailable.
 *
 * The path is whatever the DWARF debug info recorded at compile time
 * (e.g. /home/user/project/src/main.c). Use source-map remapping or a
 * path rewriter in your implementation as needed.
 */
export type FileProvider = (path: string) => Promise<Uint8Array | null>;
