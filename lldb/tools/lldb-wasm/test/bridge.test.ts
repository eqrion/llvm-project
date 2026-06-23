// Bridge transport test: verify that bytes LLDB writes to a bridged channel are
// delivered to the bridgeChannel() listener via the non-blocking drain. This is
// the mechanism firefox-lldb uses to pump RSP to a TCP platform server.
//
// We drive `platform connect inprocess://<id>` from the interpreter (which runs
// on its own pthread, leaving the worker free to drain). This also exercises
// PlatformWasmRemoteGDBServer::CreatePlatformConnection (the platform-side
// bridge). No server responds, so LLDB just emits the initial handshake bytes.

import { describe, it, expect } from 'vitest';
import { LLDBClient } from '../dist/index.js';
import { workerUrl, wasmJsUrl, wasmAvailable } from './helpers.js';

const skip = !wasmAvailable();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(skip)('bridge transport', () => {
  it('delivers LLDB platform-connect handshake bytes to the bridge listener', async () => {
    const lldb = await LLDBClient.create({ workerUrl, wasmJsUrl });
    try {
      const channelId = await lldb.createChannel();
      const chunks: Uint8Array[] = [];
      await lldb.bridgeChannel(channelId, (d) => chunks.push(d));

      await lldb.runInterpreter();
      await sleep(150);
      await lldb.writeStdin(enc('platform select wasm\n'));
      await sleep(150);
      await lldb.writeStdin(enc(`platform connect inprocess://${channelId}\n`));
      await sleep(800);

      const text = chunks.map((c) => Buffer.from(c).toString('latin1')).join('');
      // The first bytes an LLDB gdb-remote client sends are the ack and the
      // no-ack-mode query.
      expect(text).toContain('QStartNoAckMode');

      await lldb.unbridgeChannel(channelId);
    } finally {
      lldb.destroy();
    }
  }, 30_000);
});
