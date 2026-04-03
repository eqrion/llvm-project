// Integration tests: load the real LLDB wasm module and exercise the API.
// These tests do NOT require a debug target - they test everything that works
// with LLDB initialized but not connected to a process.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLDBClient } from '../dist/index.js';
import type { CommandResult, StopReason } from '../dist/index.js';
import { workerUrl, wasmJsUrl, wasmAvailable } from './helpers.js';

const skip = !wasmAvailable();

// All integration tests share a single LLDBClient to avoid loading 57MB of
// wasm on every test. The client is created once and destroyed in afterAll.
let lldb: LLDBClient;

beforeAll(async () => {
  if (skip) return;
  lldb = await LLDBClient.create({ workerUrl, wasmJsUrl });
});

afterAll(() => {
  lldb?.destroy();
});

describe.skipIf(skip)('LLDBClient integration', () => {
  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  it('creates an LLDBClient', () => {
    expect(lldb).toBeInstanceOf(LLDBClient);
  });

  // -------------------------------------------------------------------------
  // Command interpreter
  // -------------------------------------------------------------------------

  it('version command returns an lldb version string', async () => {
    const result: CommandResult = await lldb.runCommand('version');
    expect(result.output).toMatch(/lldb/i);
    // eReturnStatusFailed=6, eReturnStatusQuit=7; anything below is success.
    expect(result.status).toBeLessThan(6);
  });

  it('help command returns non-empty output', async () => {
    const result = await lldb.runCommand('help');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.status).toBeLessThan(6);
  });

  it('target list returns no-targets message', async () => {
    const result = await lldb.runCommand('target list');
    expect(result.output).toMatch(/no target/i);
  });

  it('unknown command returns an error', async () => {
    const result = await lldb.runCommand('xyzzy_no_such_command');
    expect(result.error.length + result.output.length).toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
  });

  it('settings list returns output', async () => {
    const result = await lldb.runCommand('settings list');
    expect(result.output.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // State inspection without a process
  // -------------------------------------------------------------------------

  it('getStopReason returns none when no process', async () => {
    const reason: StopReason = await lldb.getStopReason();
    expect(reason.reason).toBe('none');
  });

  it('getNumThreads returns 0 when no process', async () => {
    expect(await lldb.getNumThreads()).toBe(0);
  });

  it('getNumFrames returns 0 when no process', async () => {
    expect(await lldb.getNumFrames()).toBe(0);
  });

  it('getStackTrace returns empty array when no process', async () => {
    const frames = await lldb.getStackTrace();
    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it('getVariables returns empty array when no process', async () => {
    const vars = await lldb.getVariables();
    expect(Array.isArray(vars)).toBe(true);
    expect(vars).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Breakpoints without a target
  // -------------------------------------------------------------------------

  it('setBreakpoint rejects when no target', async () => {
    await expect(lldb.setBreakpoint('main.c', 10)).rejects.toThrow();
  });

  it('setBreakpointByAddress rejects when no target', async () => {
    await expect(lldb.setBreakpointByAddress(0x1000n)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // In-process channel lifecycle
  // -------------------------------------------------------------------------

  it('createChannel returns a positive channel ID', async () => {
    const id = await lldb.createChannel();
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    await lldb.destroyChannel(id);
  });

  it('destroyChannel resolves without error', async () => {
    const id = await lldb.createChannel();
    await expect(lldb.destroyChannel(id)).resolves.not.toThrow();
  });

  it('multiple channels have distinct IDs', async () => {
    const [a, b, c] = await Promise.all([
      lldb.createChannel(),
      lldb.createChannel(),
      lldb.createChannel(),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
    await Promise.all([
      lldb.destroyChannel(a),
      lldb.destroyChannel(b),
      lldb.destroyChannel(c),
    ]);
  });

  // -------------------------------------------------------------------------
  // Evaluate expression without a frame
  // -------------------------------------------------------------------------

  it('evaluateExpression returns an error when no frame', async () => {
    const result = await lldb.evaluateExpression('1 + 1');
    expect(result).toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  it('onStop registers a callback without throwing', () => {
    expect(() => lldb.onStop(() => {})).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it('destroy terminates the worker cleanly', async () => {
    // Create a separate client just for this test so we can destroy it
    // without affecting the shared client used by other tests.
    const client = await LLDBClient.create({ workerUrl, wasmJsUrl });
    expect(() => client.destroy()).not.toThrow();
    // Further calls after destroy should reject (worker is gone).
    await expect(client.runCommand('version')).rejects.toThrow();
  });
});

describe.skipIf(!skip)('wasm not available', () => {
  it('skipped: run `just build-wasm && npm run copy-wasm` first', () => {
    // This placeholder ensures vitest reports a meaningful skip message.
  });
});
