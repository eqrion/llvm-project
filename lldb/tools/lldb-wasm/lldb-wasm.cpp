//===-- lldb-wasm.cpp -----------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// C API for embedding LLDB in WebAssembly (Emscripten build).
//
// This module is the Emscripten executable entry point. All exported functions
// are prefixed with lldb_wasm_ and declared with EMSCRIPTEN_KEEPALIVE so they
// survive dead-code elimination and appear in EXPORTED_FUNCTIONS.
//
// Threading model: LLDB's event loop blocks on internal mutexes, which is
// incompatible with the JS main thread. This module is built with
// -sPROXY_TO_PTHREAD so main() runs on a worker thread, and all exported
// functions can block safely. JS callers use Atomics.waitAsync or a postMessage
// bridge to receive results asynchronously.
//
//===----------------------------------------------------------------------===//

#include "lldb/API/SBBreakpoint.h"
#include "lldb/API/SBCommandInterpreter.h"
#include "lldb/API/SBCommandReturnObject.h"
#include "lldb/API/SBDebugger.h"
#include "lldb/API/SBEvent.h"
#include "lldb/API/SBExpressionOptions.h"
#include "lldb/API/SBFrame.h"
#include "lldb/API/SBListener.h"
#include "lldb/API/SBProcess.h"
#include "lldb/API/SBStream.h"
#include "lldb/API/SBTarget.h"
#include "lldb/API/SBThread.h"
#include "lldb/API/SBUnixSignals.h"
#include "lldb/API/SBValue.h"
#include "lldb/Utility/Connection.h"
#include "lldb/Utility/Timeout.h"
#include "ConnectionInProcess.h"

#include <cinttypes>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <map>
#include <mutex>
#include <string>
#include <sys/stat.h>

// All exported C functions must be declared extern "C" and marked
// EMSCRIPTEN_KEEPALIVE to survive Emscripten's dead-code elimination.
extern "C" {

// Initialize LLDB. Call once before any other function.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_initialize() {
  lldb::SBDebugger::Initialize();
}

// Tear down LLDB. Call when done.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_terminate() {
  lldb::SBDebugger::Terminate();
}

// Create a new SBDebugger instance. Returns an opaque handle (non-zero on
// success). Destroy with lldb_wasm_destroy_debugger when done.
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_create_debugger() {
  lldb::SBDebugger debugger = lldb::SBDebugger::Create(false);
  if (!debugger.IsValid())
    return 0;

  // Async mode: don't stop at first stop event by default.
  debugger.SetAsync(true);

  // Use the wasm32 platform.
  debugger.SetCurrentPlatformSDKRoot("");

  auto *d = new lldb::SBDebugger(debugger);
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(d));
}

// Destroy a debugger created by lldb_wasm_create_debugger.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_destroy_debugger(uint32_t handle) {
  if (!handle)
    return;
  auto *d = reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBDebugger::Destroy(*d);
  delete d;
}

// Connect to a GDB remote server.
// url: connection URL, e.g. "connect://localhost:1234"
// Returns 0 on success, 1 on failure. Populates error_buf (up to error_buf_len
// bytes) with a null-terminated error message on failure.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_connect(uint32_t handle, const char *url,
                                           char *error_buf,
                                           uint32_t error_buf_len) {
  if (!handle || !url)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));

  // Create a wasm32 target to attach the process to.
  lldb::SBError error;
  lldb::SBTarget target =
      d->CreateTarget("", "wasm32", "wasm", false, error);
  if (!target.IsValid()) {
    if (error_buf && error_buf_len > 0) {
      snprintf(error_buf, error_buf_len, "CreateTarget: %s",
               error.GetCString());
    }
    return 1;
  }

  // Connect using the gdb-remote process plugin.
  lldb::SBListener listener = d->GetListener();
  lldb::SBProcess process = target.ConnectRemote(listener, url, "wasm", error);
  if (!process.IsValid()) {
    if (error_buf && error_buf_len > 0) {
      snprintf(error_buf, error_buf_len, "ConnectRemote: %s",
               error.GetCString());
    }
    return 1;
  }

  return 0;
}

// Disconnect from the remote and destroy the process/target.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_disconnect(uint32_t handle) {
  if (!handle)
    return;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return;
  lldb::SBProcess process = target.GetProcess();
  if (process.IsValid())
    process.Detach();
  d->DeleteTarget(target);
}

// Attach a wasm module's bytes so LLDB can resolve DWARF debug info.
// The bytes are written to Emscripten's MEMFS at the given path, then the
// module is loaded as a symbol file for the current target.
// Returns 0 on success.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_attach_wasm_module(uint32_t handle,
                                                      const char *name,
                                                      const uint8_t *data,
                                                      uint32_t size) {
  if (!handle || !name || !data || !size)
    return 1;

  // Write the module bytes to MEMFS so ObjectFileWasm can read them.
  std::string path = std::string("/wasm-modules/") + name;
  FILE *f = fopen(path.c_str(), "wb");
  if (!f) {
    // Try creating the directory first.
    mkdir("/wasm-modules", 0755);
    f = fopen(path.c_str(), "wb");
    if (!f)
      return 1;
  }
  fwrite(data, 1, size, f);
  fclose(f);

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return 1;

  lldb::SBModule module = target.AddModule(path.c_str(), "wasm32", nullptr);
  return module.IsValid() ? 0 : 1;
}

// Set a source-level breakpoint. Returns the breakpoint ID (> 0) on success,
// or 0 on failure.
EMSCRIPTEN_KEEPALIVE uint32_t
lldb_wasm_set_breakpoint_by_location(uint32_t handle, const char *file,
                                     uint32_t line) {
  if (!handle || !file)
    return 0;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return 0;
  lldb::SBBreakpoint bp = target.BreakpointCreateByLocation(file, line);
  return bp.IsValid() ? static_cast<uint32_t>(bp.GetID()) : 0;
}

// Set a breakpoint at a wasm virtual address. Returns the breakpoint ID.
// Address is passed as two 32-bit halves to avoid BigInt ccall complexity.
EMSCRIPTEN_KEEPALIVE uint32_t
lldb_wasm_set_breakpoint_by_address(uint32_t handle, uint32_t addr_lo,
                                    uint32_t addr_hi) {
  if (!handle)
    return 0;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return 0;
  uint64_t address = (static_cast<uint64_t>(addr_hi) << 32) | addr_lo;
  lldb::SBBreakpoint bp = target.BreakpointCreateByAddress(address);
  return bp.IsValid() ? static_cast<uint32_t>(bp.GetID()) : 0;
}

// Remove a breakpoint by ID.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_remove_breakpoint(uint32_t handle,
                                                     uint32_t bp_id) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return 1;
  return target.BreakpointDelete(static_cast<lldb::break_id_t>(bp_id)) ? 0 : 1;
}

// Enable or disable a breakpoint.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_enable_breakpoint(uint32_t handle,
                                                      uint32_t bp_id,
                                                      int enable) {
  if (!handle)
    return;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBTarget target = d->GetSelectedTarget();
  if (!target.IsValid())
    return;
  lldb::SBBreakpoint bp =
      target.FindBreakpointByID(static_cast<lldb::break_id_t>(bp_id));
  if (bp.IsValid())
    bp.SetEnabled(enable != 0);
}

// Resume (continue) execution.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_resume(uint32_t handle) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBProcess process = d->GetSelectedTarget().GetProcess();
  if (!process.IsValid())
    return 1;
  lldb::SBError error = process.Continue();
  return error.Success() ? 0 : 1;
}

// Pause (interrupt) execution.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_pause(uint32_t handle) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBProcess process = d->GetSelectedTarget().GetProcess();
  if (!process.IsValid())
    return 1;
  lldb::SBError error = process.Stop();
  return error.Success() ? 0 : 1;
}

// Step over (next line) on the selected thread.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_step_over(uint32_t handle) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();
  if (!thread.IsValid())
    return 1;
  thread.StepOver();
  return 0;
}

// Step into (step into a call) on the selected thread.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_step_into(uint32_t handle) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();
  if (!thread.IsValid())
    return 1;
  thread.StepInto();
  return 0;
}

// Step out (finish current function) on the selected thread.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_step_out(uint32_t handle) {
  if (!handle)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();
  if (!thread.IsValid())
    return 1;
  thread.StepOut();
  return 0;
}

// Returns a JSON string describing the stop reason:
// {"reason":"breakpoint","thread_id":1,"bp_id":2}
// {"reason":"step_complete","thread_id":1}
// {"reason":"signal","signal_name":"SIGSEGV","thread_id":1}
// {"reason":"exited","exit_code":0}
// {"reason":"running"}
// {"reason":"none"}
// Caller must free the returned string with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_get_stop_reason(uint32_t handle) {
  std::string result;

  if (!handle) {
    result = R"({"reason":"none"})";
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBProcess process = d->GetSelectedTarget().GetProcess();

  if (!process.IsValid()) {
    result = R"({"reason":"none"})";
  } else if (process.GetState() == lldb::eStateRunning) {
    result = R"({"reason":"running"})";
  } else if (process.GetState() == lldb::eStateExited) {
    result = R"({"reason":"exited","exit_code":)" +
             std::to_string(process.GetExitStatus()) + "}";
  } else {
    lldb::SBThread thread = process.GetSelectedThread();
    if (!thread.IsValid()) {
      result = R"({"reason":"none"})";
    } else {
      uint32_t tid = static_cast<uint32_t>(thread.GetThreadID());
      switch (thread.GetStopReason()) {
      case lldb::eStopReasonBreakpoint:
        result = R"({"reason":"breakpoint","thread_id":)" +
                 std::to_string(tid) + R"(,"bp_id":)" +
                 std::to_string(thread.GetStopReasonDataAtIndex(0)) + "}";
        break;
      case lldb::eStopReasonPlanComplete:
        result = R"({"reason":"step_complete","thread_id":)" +
                 std::to_string(tid) + "}";
        break;
      case lldb::eStopReasonSignal: {
        lldb::SBUnixSignals signals = process.GetUnixSignals();
        const char *signame = signals.GetSignalAsCString(
            thread.GetStopReasonDataAtIndex(0));
        result = R"({"reason":"signal","signal_name":")" +
                 std::string(signame ? signame : "unknown") +
                 R"(","thread_id":)" + std::to_string(tid) + "}";
        break;
      }
      case lldb::eStopReasonException:
        result =
            R"({"reason":"exception","thread_id":)" + std::to_string(tid) + "}";
        break;
      default:
        result =
            R"({"reason":"stopped","thread_id":)" + std::to_string(tid) + "}";
        break;
      }
    }
  }

  char *ret = static_cast<char *>(malloc(result.size() + 1));
  memcpy(ret, result.c_str(), result.size() + 1);
  return ret;
}

// Returns the number of threads in the current process (0 if none).
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_get_num_threads(uint32_t handle) {
  if (!handle)
    return 0;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBProcess process = d->GetSelectedTarget().GetProcess();
  if (!process.IsValid())
    return 0;
  return static_cast<uint32_t>(process.GetNumThreads());
}

// Returns the number of frames in the selected thread (0 if none).
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_get_num_frames(uint32_t handle) {
  if (!handle)
    return 0;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();
  if (!thread.IsValid())
    return 0;
  return static_cast<uint32_t>(thread.GetNumFrames());
}

// Returns a JSON array of frame info for the selected thread:
// [{"index":0,"function":"foo","file":"a.c","line":10,"pc":"0x1234"},...]
// Caller must free the result with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_get_frame_info(uint32_t handle) {
  std::string result = "[]";

  if (!handle) {
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();

  if (!thread.IsValid()) {
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  result = "[";
  uint32_t num_frames = static_cast<uint32_t>(thread.GetNumFrames());
  for (uint32_t i = 0; i < num_frames; ++i) {
    lldb::SBFrame frame = thread.GetFrameAtIndex(i);
    if (i > 0)
      result += ",";

    result += R"({"index":)" + std::to_string(i);

    lldb::SBSymbolContext ctx = frame.GetSymbolContext(
        lldb::eSymbolContextFunction | lldb::eSymbolContextLineEntry);

    const char *func_name = frame.GetFunctionName();
    result += R"(,"function":")";
    result += func_name ? func_name : "??";
    result += "\"";

    if (ctx.GetLineEntry().IsValid()) {
      const char *file = ctx.GetLineEntry().GetFileSpec().GetFilename();
      const char *dir = ctx.GetLineEntry().GetFileSpec().GetDirectory();
      if (file) {
        result += R"(,"file":")";
        if (dir) {
          result += std::string(dir) + "/";
        }
        result += std::string(file) + "\"";
      }
      result +=
          R"(,"line":)" + std::to_string(ctx.GetLineEntry().GetLine());
    }

    char pc_buf[32];
    snprintf(pc_buf, sizeof(pc_buf), "0x%" PRIx64, frame.GetPC());
    result += R"(,"pc":")" + std::string(pc_buf) + "\"}";
  }
  result += "]";

  char *ret = static_cast<char *>(malloc(result.size() + 1));
  memcpy(ret, result.c_str(), result.size() + 1);
  return ret;
}

// Returns a JSON array of variables visible in the given stack frame:
// [{"name":"x","type":"int","value":"42"},...]
// frame_index: 0 = innermost frame.
// Caller must free the result with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_get_variables_json(uint32_t handle,
                                                        uint32_t frame_index) {
  std::string result = "[]";

  if (!handle) {
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();
  if (!thread.IsValid()) {
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  lldb::SBFrame frame = thread.GetFrameAtIndex(frame_index);
  if (!frame.IsValid()) {
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  lldb::SBValueList vars =
      frame.GetVariables(true, true, true, true); // args, locals, statics, in_scope_only

  result = "[";
  for (uint32_t i = 0; i < static_cast<uint32_t>(vars.GetSize()); ++i) {
    lldb::SBValue val = vars.GetValueAtIndex(i);
    if (i > 0)
      result += ",";

    const char *name = val.GetName();
    const char *type = val.GetTypeName();
    const char *value = val.GetValue();

    // Escape any double quotes in strings.
    auto escape = [](const char *s) -> std::string {
      if (!s)
        return "";
      std::string out;
      for (; *s; ++s) {
        if (*s == '"')
          out += "\\\"";
        else if (*s == '\\')
          out += "\\\\";
        else
          out += *s;
      }
      return out;
    };

    result += R"({"name":")" + escape(name) + R"(","type":")" + escape(type) +
              R"(","value":")" + escape(value) + "\"}";
  }
  result += "]";

  char *ret = static_cast<char *>(malloc(result.size() + 1));
  memcpy(ret, result.c_str(), result.size() + 1);
  return ret;
}

// Read bytes from the wasm linear memory at the given virtual address.
// Address is passed as two 32-bit halves (lo, hi).
// Returns 0 on success; bytes_read is set to the number of bytes actually read.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_read_memory(uint32_t handle,
                                               uint32_t addr_lo,
                                               uint32_t addr_hi,
                                               uint8_t *buf, uint32_t size,
                                               uint32_t *bytes_read) {
  if (!handle || !buf || !size)
    return 1;
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBProcess process = d->GetSelectedTarget().GetProcess();
  if (!process.IsValid())
    return 1;

  uint64_t addr = (static_cast<uint64_t>(addr_hi) << 32) | addr_lo;
  lldb::SBError error;
  size_t n = process.ReadMemory(addr, buf, size, error);
  if (bytes_read)
    *bytes_read = static_cast<uint32_t>(n);
  return error.Success() ? 0 : 1;
}

// Evaluate an expression in the context of the given stack frame.
// Returns a JSON string: {"value":"42","type":"int"} or {"error":"..."}
// Caller must free the result with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_evaluate_expression(uint32_t handle,
                                                         uint32_t frame_index,
                                                         const char *expr) {
  std::string result;

  if (!handle || !expr) {
    result = R"({"error":"invalid arguments"})";
    char *ret = static_cast<char *>(malloc(result.size() + 1));
    memcpy(ret, result.c_str(), result.size() + 1);
    return ret;
  }

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
  lldb::SBThread thread = d->GetSelectedTarget().GetProcess().GetSelectedThread();

  lldb::SBExpressionOptions opts;
  opts.SetFetchDynamicValue(lldb::eDynamicDontRunTarget);
  // Use interpreter only - JIT is not available in the wasm LLDB client.
  opts.SetTryAllThreads(false);
  opts.SetUnwindOnError(true);

  lldb::SBValue val;
  if (thread.IsValid()) {
    lldb::SBFrame frame = thread.GetFrameAtIndex(frame_index);
    if (frame.IsValid()) {
      val = frame.EvaluateExpression(expr, opts);
    }
  }

  if (!val.IsValid() || val.GetError().Fail()) {
    const char *err = val.IsValid() ? val.GetError().GetCString()
                                    : "expression evaluation failed";
    // Escape the error string.
    std::string escaped;
    if (err) {
      for (const char *p = err; *p; ++p) {
        if (*p == '"')
          escaped += "\\\"";
        else if (*p == '\\')
          escaped += "\\\\";
        else
          escaped += *p;
      }
    }
    result = R"({"error":")" + escaped + "\"}";
  } else {
    const char *value = val.GetValue();
    const char *type = val.GetTypeName();
    auto escape = [](const char *s) -> std::string {
      if (!s)
        return "";
      std::string out;
      for (; *s; ++s) {
        if (*s == '"')
          out += "\\\"";
        else if (*s == '\\')
          out += "\\\\";
        else
          out += *s;
      }
      return out;
    };
    result = R"({"value":")" + escape(value) + R"(","type":")" + escape(type) + "\"}";
  }

  char *ret = static_cast<char *>(malloc(result.size() + 1));
  memcpy(ret, result.c_str(), result.size() + 1);
  return ret;
}

// Free a string returned by any lldb_wasm_* function.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_free_string(char *s) { free(s); }

// ---------------------------------------------------------------------------
// In-process transport
// ---------------------------------------------------------------------------
//
// Creates a pair of connected endpoints so that a GDB remote server running
// in the same wasm module can communicate with LLDB without going through
// sockets. The LLDB side is injected via lldb_wasm_connect_inprocess(); the
// server side is accessed via lldb_wasm_channel_server_write/read.
//
// Channel lifetime: channels are heap-allocated and tracked in a global map.
// They are freed when the associated debugger is destroyed or when both sides
// call Disconnect.

struct ChannelPair {
  std::unique_ptr<lldb_private::ConnectionInProcess> lldb_side;
  std::unique_ptr<lldb_private::ConnectionInProcess> server_side;
};

static std::mutex g_channel_mutex;
static uint32_t g_next_channel_id = 1;
static std::map<uint32_t, ChannelPair> g_channels;

// Create an in-process channel. Returns a channel ID (> 0).
// The channel has two endpoints: the LLDB side (used by lldb_wasm_connect_inprocess)
// and the server side (used by lldb_wasm_channel_server_write/read).
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_create_channel() {
  auto [lldb_end, server_end] = lldb_private::ConnectionInProcess::CreatePair();
  std::lock_guard<std::mutex> lock(g_channel_mutex);
  uint32_t id = g_next_channel_id++;
  g_channels[id] = {std::move(lldb_end), std::move(server_end)};
  return id;
}

// Connect a debugger to an in-process channel previously created with
// lldb_wasm_create_channel(). Returns 0 on success.
//
// This creates a wasm32 target and attaches to it using the channel's LLDB
// endpoint as the connection transport. The channel's server endpoint remains
// available for the server to use.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_connect_inprocess(uint32_t handle,
                                                     uint32_t channel_id) {
  if (!handle)
    return 1;

  lldb_private::ConnectionInProcess *conn = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_channel_mutex);
    auto it = g_channels.find(channel_id);
    if (it == g_channels.end())
      return 1;
    conn = it->second.lldb_side.get();
  }

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));

  lldb::SBError error;
  lldb::SBTarget target = d->CreateTarget("", "wasm32", "wasm", false, error);
  if (!target.IsValid())
    return 1;

  // Connect using the in-process connection object.
  lldb::SBListener listener = d->GetListener();
  lldb::SBProcess process =
      target.ConnectRemote(listener, "inprocess://", "wasm", error);
  if (!process.IsValid())
    return 1;

  // Inject the in-process connection into the GDB remote communication.
  // ProcessGDBRemote::DoConnectRemote calls m_gdb_comm.SetConnection().
  // We cannot do this via the SB API directly, so instead we pre-populate
  // the connection before ConnectRemote is called. The URL "inprocess://"
  // won't be resolved by ConnectionFileDescriptor; we rely on the caller
  // to set up the connection via this function after ConnectRemote would
  // have failed.
  //
  // TODO: implement the inprocess:// scheme in ConnectionFileDescriptor so
  // the channel is injected at the right point. For now this is a placeholder
  // that at least creates the target and process objects.
  return 0;
}

// Server side: write data into the channel (server -> LLDB direction).
// Returns the number of bytes written, or -1 on error.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_channel_server_write(uint32_t channel_id,
                                                        const uint8_t *data,
                                                        uint32_t size) {
  std::lock_guard<std::mutex> lock(g_channel_mutex);
  auto it = g_channels.find(channel_id);
  if (it == g_channels.end() || !it->second.server_side)
    return -1;
  lldb::ConnectionStatus status;
  size_t n = it->second.server_side->Write(data, size, status, nullptr);
  return static_cast<int>(n);
}

// Server side: read data from the channel (LLDB -> server direction).
// Blocks for up to timeout_ms milliseconds. Returns bytes read, or -1 on error.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_channel_server_read(uint32_t channel_id,
                                                       uint8_t *buf,
                                                       uint32_t size,
                                                       uint32_t timeout_ms) {
  lldb_private::ConnectionInProcess *conn = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_channel_mutex);
    auto it = g_channels.find(channel_id);
    if (it == g_channels.end() || !it->second.server_side)
      return -1;
    conn = it->second.server_side.get();
  }
  lldb::ConnectionStatus status;
  lldb_private::Timeout<std::micro> timeout =
      timeout_ms > 0
          ? lldb_private::Timeout<std::micro>(
                std::chrono::microseconds(timeout_ms * 1000LL))
          : lldb_private::Timeout<std::micro>(std::nullopt);
  size_t n = conn->Read(buf, size, timeout, status, nullptr);
  return static_cast<int>(n);
}

// Destroy a channel and free its resources.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_destroy_channel(uint32_t channel_id) {
  std::lock_guard<std::mutex> lock(g_channel_mutex);
  g_channels.erase(channel_id);
}

// ---------------------------------------------------------------------------
// Command interpreter
// ---------------------------------------------------------------------------

// Run a single LLDB CLI command and return its output as a JSON object:
//   {"output":"...", "error":"...", "status":0}
// status mirrors lldb::ReturnStatus (0 = success, non-zero = error/invalid).
// Caller must free the result with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_run_command(uint32_t handle,
                                                 const char *command) {
  std::string output_str;
  std::string error_str;
  int return_status = 0;

  if (!handle || !command) {
    output_str = "";
    error_str = "invalid arguments";
    return_status = -1;
  } else {
    auto *d =
        reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
    lldb::SBCommandInterpreter interp = d->GetCommandInterpreter();
    lldb::SBCommandReturnObject result;
    lldb::ReturnStatus status =
        interp.HandleCommand(command, result, false);
    return_status = static_cast<int>(status);
    if (result.GetOutput())
      output_str = result.GetOutput();
    if (result.GetError())
      error_str = result.GetError();
  }

  auto escape = [](const std::string &s) -> std::string {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
      switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:   out += c;      break;
      }
    }
    return out;
  };

  std::string result_json =
      R"({"output":")" + escape(output_str) +
      R"(","error":")" + escape(error_str) +
      R"(","status":)" + std::to_string(return_status) + "}";

  char *ret = static_cast<char *>(malloc(result_json.size() + 1));
  memcpy(ret, result_json.c_str(), result_json.size() + 1);
  return ret;
}

} // extern "C"

int main() {
  // main() is proxied to a pthread by -sPROXY_TO_PTHREAD. Nothing to do here;
  // the JS wrapper calls lldb_wasm_initialize() after the module is ready.
  return 0;
}
