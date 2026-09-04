// Integration tests: load the real LLDB wasm module and exercise the API.
// These tests do NOT require a debug target - they test everything that works
// with LLDB initialized but not connected to a process.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLDBClient } from "../dist/index.js";
import type { CommandResult, DAPSession, StopReason } from "../dist/index.js";
import { workerUrl, wasmJsUrl, wasmAvailable } from "./helpers.js";

const skip = !wasmAvailable();

// All integration tests share a single LLDBClient to avoid loading 57MB of
// wasm on every test. The client is created once and destroyed in afterAll.
let lldb: LLDBClient;

type DAPMessage = Record<string, unknown>;

function dapFrame(message: DAPMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

class DAPTestPeer {
  #input = Buffer.alloc(0);
  #seq = 1;
  readonly #pending = new Map<number, (message: DAPMessage) => void>();

  constructor(readonly session: DAPSession) {
    session.onData((data) => {
      this.#input = Buffer.concat([this.#input, Buffer.from(data)]);
      for (;;) {
        const headerEnd = this.#input.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.#input.subarray(0, headerEnd).toString("ascii");
        const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
        if (!match)
          throw new Error(`DAP message has no Content-Length: ${header}`);
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (this.#input.length < bodyStart + length) return;
        const message = JSON.parse(
          this.#input.subarray(bodyStart, bodyStart + length).toString("utf8"),
        ) as DAPMessage;
        this.#input = this.#input.subarray(bodyStart + length);
        if (message["type"] !== "response") continue;
        const requestSeq = message["request_seq"] as number;
        this.#pending.get(requestSeq)?.(message);
        this.#pending.delete(requestSeq);
      }
    });
  }

  prepare(command: string, args: DAPMessage = {}) {
    const seq = this.#seq++;
    const response = new Promise<DAPMessage>((resolve) =>
      this.#pending.set(seq, resolve),
    );
    return {
      frame: dapFrame({ seq, type: "request", command, arguments: args }),
      response,
    };
  }

  async request(command: string, args: DAPMessage = {}): Promise<DAPMessage> {
    const request = this.prepare(command, args);
    await this.session.write(request.frame);
    return request.response;
  }
}

beforeAll(async () => {
  if (skip) return;
  lldb = await LLDBClient.create({ workerUrl, wasmJsUrl });
});

afterAll(() => {
  lldb?.destroy();
});

describe.skipIf(skip)("LLDBClient integration", () => {
  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  it("creates an LLDBClient", () => {
    expect(lldb).toBeInstanceOf(LLDBClient);
  });

  // -------------------------------------------------------------------------
  // Command interpreter
  // -------------------------------------------------------------------------

  it("version command returns an lldb version string", async () => {
    const result: CommandResult = await lldb.runCommand("version");
    expect(result.output).toMatch(/lldb/i);
    // eReturnStatusFailed=6, eReturnStatusQuit=7; anything below is success.
    expect(result.status).toBeLessThan(6);
  });

  it("help command returns non-empty output", async () => {
    const result = await lldb.runCommand("help");
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.status).toBeLessThan(6);
  });

  it("target list returns no-targets message", async () => {
    const result = await lldb.runCommand("target list");
    expect(result.output).toMatch(/no target/i);
  });

  it("unknown command returns an error", async () => {
    const result = await lldb.runCommand("xyzzy_no_such_command");
    expect(result.error.length + result.output.length).toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
  });

  it("settings list returns output", async () => {
    const result = await lldb.runCommand("settings list");
    expect(result.output.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // State inspection without a process
  // -------------------------------------------------------------------------

  it("getStopReason returns none when no process", async () => {
    const reason: StopReason = await lldb.getStopReason();
    expect(reason.reason).toBe("none");
  });

  it("getNumThreads returns 0 when no process", async () => {
    expect(await lldb.getNumThreads()).toBe(0);
  });

  it("getNumFrames returns 0 when no process", async () => {
    expect(await lldb.getNumFrames()).toBe(0);
  });

  it("getStackTrace returns empty array when no process", async () => {
    const frames = await lldb.getStackTrace();
    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("getVariables returns empty array when no process", async () => {
    const vars = await lldb.getVariables();
    expect(Array.isArray(vars)).toBe(true);
    expect(vars).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Breakpoints without a target
  // -------------------------------------------------------------------------

  it("setBreakpoint rejects when no target", async () => {
    await expect(lldb.setBreakpoint("main.c", 10)).rejects.toThrow();
  });

  it("setBreakpointByAddress rejects when no target", async () => {
    await expect(lldb.setBreakpointByAddress(0x1000n)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // In-process channel lifecycle
  // -------------------------------------------------------------------------

  it("createChannel returns a positive channel ID", async () => {
    const id = await lldb.createChannel();
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
    await lldb.destroyChannel(id);
  });

  it("destroyChannel resolves without error", async () => {
    const id = await lldb.createChannel();
    await expect(lldb.destroyChannel(id)).resolves.not.toThrow();
  });

  it("multiple channels have distinct IDs", async () => {
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

  it("evaluateExpression returns an error when no frame", async () => {
    const result = await lldb.evaluateExpression("1 + 1");
    expect(result).toHaveProperty("error");
  });

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  it("onStop registers a callback without throwing", () => {
    expect(() => lldb.onStop(() => {})).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Debug Adapter Protocol
  // -------------------------------------------------------------------------

  it("handles fragmented, coalesced, and multi-buffer DAP traffic", async () => {
    const dap = await lldb.startDAP();
    const peer = new DAPTestPeer(dap);
    await expect(lldb.startDAP()).rejects.toThrow(/already been started/);

    const initialize = peer.prepare("initialize", {
      adapterID: "lldb-wasm-test",
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    await dap.write(initialize.frame.subarray(0, 1));
    await dap.write(initialize.frame.subarray(1, 17));
    await dap.write(initialize.frame.subarray(17));
    const initialized = await initialize.response;
    expect(initialized["success"]).toBe(true);
    expect(initialized["body"]).toBeTypeOf("object");

    // An unknown command is echoed in its error response. Making it larger
    // than the worker's 16 KiB drain buffer proves output is reassembled
    // across multiple drain iterations without truncation.
    const longCommand = `unknown-${"x".repeat(40_000)}`;
    const unknown = await peer.request(longCommand);
    expect(unknown["success"]).toBe(false);
    expect(unknown["command"]).toBe(longCommand);

    // Multiple complete requests may arrive in one stdin write.
    const threads = peer.prepare("threads");
    const disconnect = peer.prepare("disconnect");
    await dap.write(Buffer.concat([threads.frame, disconnect.frame]));
    const [threadResponse, disconnected] = await Promise.all([
      threads.response,
      disconnect.response,
    ]);
    expect(threadResponse["command"]).toBe("threads");
    expect(threadResponse["success"]).toBe(false);
    expect(disconnected["success"]).toBe(true);
    await dap.done;
    await expect(dap.close()).resolves.toBeUndefined();
    await expect(dap.close()).resolves.toBeUndefined();
    await expect(dap.write(dapFrame({}))).rejects.toThrow(/exited/);
  }, 20_000);

  it("rejects non-string DAP pre-init commands", async () => {
    const client = await LLDBClient.create({ workerUrl, wasmJsUrl });
    try {
      await expect(
        client.startDAP({ preInitCommands: [42 as unknown as string] }),
      ).rejects.toThrow();
    } finally {
      await client.destroy();
    }
  }, 20_000);

  it("rejects the DAP done promise on EOF in a partial frame", async () => {
    const client = await LLDBClient.create({ workerUrl, wasmJsUrl });
    try {
      const dap = await client.startDAP();
      await dap.write(Buffer.from('Content-Length: 100\r\n\r\n{"seq":1'));
      await dap.close();
      await expect(dap.done).rejects.toThrow(/internal error/);
      await expect(dap.write(dapFrame({}))).rejects.toThrow(/exited/);
    } finally {
      await client.destroy();
    }
  }, 20_000);

  it("settles DAP lifecycle promises when its client is destroyed", async () => {
    const client = await LLDBClient.create({ workerUrl, wasmJsUrl });
    const dap = await client.startDAP();
    await client.destroy();
    await expect(dap.done).resolves.toBeUndefined();
    await expect(dap.write(dapFrame({}))).rejects.toThrow(/exited/);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it("destroy terminates the worker cleanly", async () => {
    // Create a separate client just for this test so we can destroy it
    // without affecting the shared client used by other tests.
    const client = await LLDBClient.create({ workerUrl, wasmJsUrl });
    expect(() => client.destroy()).not.toThrow();
    // Further calls after destroy should reject (worker is gone).
    await expect(client.runCommand("version")).rejects.toThrow();
  });
});

describe.skipIf(!skip)("wasm not available", () => {
  it("skipped: run `just build-wasm && npm run copy-wasm` first", () => {
    // This placeholder ensures vitest reports a meaningful skip message.
  });
});
