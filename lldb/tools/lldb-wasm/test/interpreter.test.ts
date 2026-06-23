// Integration tests for the interactive command interpreter: drive the real
// LLDB REPL over the console channels (stdin/stdout) and assert it behaves like
// a real interactive lldb (prints the prompt, runs commands, exits on quit/EOF).

import { describe, it, expect } from 'vitest';
import { LLDBClient } from '../dist/index.js';
import { workerUrl, wasmJsUrl, wasmAvailable } from './helpers.js';

const skip = !wasmAvailable();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

// Spin up an interpreter, run `lines` through stdin, and collect all output.
// `end` chooses how to finish: a `quit` command or stdin EOF.
async function runRepl(
  lines: string[],
  end: 'quit' | 'eof',
): Promise<{ output: string; exited: boolean }> {
  const lldb = await LLDBClient.create({ workerUrl, wasmJsUrl });
  const chunks: Uint8Array[] = [];
  let exited = false;
  lldb.onOutput((b) => chunks.push(b));
  lldb.onInterpreterExit(() => { exited = true; });

  await lldb.runInterpreter();
  await sleep(200);
  for (const line of lines) {
    await lldb.writeStdin(enc.encode(line + '\n'));
    await sleep(200);
  }
  if (end === 'quit') await lldb.writeStdin(enc.encode('quit\n'));
  else await lldb.closeStdin();
  await sleep(400);

  const decoder = new TextDecoder();
  const output = chunks.map((c) => decoder.decode(c)).join('');
  lldb.destroy();
  return { output, exited };
}

describe.skipIf(skip)('interactive command interpreter', () => {
  it('prints the (lldb) prompt and command output, exits on quit', async () => {
    const { output, exited } = await runRepl(['version', 'help'], 'quit');
    expect(output).toContain('(lldb)');
    expect(output).toMatch(/lldb version|lldb-\d/);
    expect(output).toContain('Quit the LLDB debugger'); // from `help`
    expect(exited).toBe(true);
  }, 30_000);

  it('exits cleanly on stdin EOF (Ctrl-D)', async () => {
    const { output, exited } = await runRepl(['version'], 'eof');
    expect(output).toContain('(lldb)');
    expect(exited).toBe(true);
  }, 30_000);
});
