// Unit tests: verify the package exports the expected symbols and that
// types have the right shape. No wasm loading required.

import { describe, it, expect } from 'vitest';
import * as pkg from '../dist/index.js';

describe('package exports', () => {
  it('exports LLDBClient class', () => {
    expect(pkg.LLDBClient).toBeDefined();
    expect(typeof pkg.LLDBClient).toBe('function');
  });

  it('LLDBClient.create is a static method', () => {
    expect(typeof pkg.LLDBClient.create).toBe('function');
  });

  it('LLDBClient instance methods exist on prototype', () => {
    const proto = pkg.LLDBClient.prototype as Record<string, unknown>;
    const methods = [
      'connect', 'disconnect',
      'attachWasmModule',
      'setBreakpoint', 'setBreakpointByAddress', 'removeBreakpoint', 'enableBreakpoint',
      'resume', 'pause', 'stepOver', 'stepInto', 'stepOut',
      'getStopReason', 'getNumThreads', 'getNumFrames', 'getStackTrace',
      'getVariables', 'readMemory', 'evaluateExpression',
      'runCommand',
      'createChannel', 'connectInProcess', 'channelServerWrite',
      'channelServerRead', 'destroyChannel',
      'onStop', 'destroy',
    ];
    for (const m of methods) {
      expect(proto[m], `method ${m}`).toBeDefined();
      expect(typeof proto[m], `method ${m} is function`).toBe('function');
    }
  });
});
