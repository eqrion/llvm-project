# lldb-wasm

LLDB compiled to WebAssembly. Runs entirely in the browser or Node.js -- no
native binary required. Built for debugging WebAssembly modules via a GDB
remote connection.

## Requirements

This package uses `SharedArrayBuffer` and `Atomics` for the virtual filesystem
bridge and for pthreads inside the wasm module. In a browser context your page
must be served with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Node.js 18+ is supported without any special flags.

## Installation

```
npm install lldb-wasm
```

## Usage

```js
import { LLDBClient } from 'lldb-wasm';

// Start LLDB in a Web Worker. Returns once the wasm module is loaded.
const lldb = await LLDBClient.create();

// Connect to a GDB remote target (e.g. a browser's wasm debugging proxy).
await lldb.connect('ws://localhost:9000');

// Load the wasm module under debug.
const bytes = await fetch('/app.wasm').then((r) => r.arrayBuffer());
await lldb.attachWasmModule('app.wasm', new Uint8Array(bytes));

// Set a breakpoint and run.
const bpId = await lldb.setBreakpoint('src/main.c', 42);
await lldb.resume();

// Inspect state when stopped.
lldb.onStop(async (reason) => {
  const frames = await lldb.getStackTrace();
  const vars = await lldb.getVariables();
  console.log(reason, frames, vars);
});

// Clean up when done.
await lldb.destroy();
```

### Debug Adapter Protocol

The package also embeds upstream LLDB's Debug Adapter Protocol implementation.
`startDAP()` exposes it as a byte stream, so an embedder can connect it to an
editor over stdio, a socket, or another transport without parsing or
reimplementing DAP:

```js
const dap = await lldb.startDAP({
  preInitCommands: ['platform select remote-gdb-server', 'platform connect inprocess://1'],
});

dap.onData((bytes) => editor.write(bytes));
editor.onData((bytes) => void dap.write(bytes));
editor.onEnd(() => void dap.close());

await dap.done;
```

The bytes retain DAP's normal `Content-Length` framing. `preInitCommands` run
when the client sends `initialize`, before the adapter creates a target. One DAP
session can be started per `LLDBClient`; create a new client for another
session. The embedder remains responsible for any transport LLDB commands use,
such as bridging the `inprocess://` channel in the example.

### Hosting the wasm file yourself

By default the package loads `lldb-wasm.wasm` (58 MB) from its own `wasm/`
directory. You can host it on a CDN or asset server and point the client at it:

```js
const lldb = await LLDBClient.create({
  wasmJsUrl: 'https://cdn.example.com/lldb-wasm.js',
});
```

### Providing source files

LLDB can read source files for display during debugging. Supply a callback that
fetches file content by path:

```js
lldb.setFileProvider(async (path) => {
  const res = await fetch(`/sources${path}`);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
});
```

## Building from source

Requires [Emscripten](https://emscripten.org) and [just](https://just.systems).
From the repository root:

```
just build-all   # native tblgen tools + libxml2 + wasm
just npm-build   # copy artifacts + compile TypeScript
```

See the root `justfile` for all available recipes.

## License

Apache-2.0
