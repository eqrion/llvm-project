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
// Threading model: the module runs inside a dedicated JS Worker (the npm
// package's worker.ts). That Worker owns the Emscripten filesystem and proxies
// FS syscalls for every pthread, so it must never block. LLDB's own threads
// (GDB-remote reader, event handler, the interactive interpreter) are pthreads
// that may block freely. The interactive interpreter therefore reads stdin from
// an in-process channel (see WasmConsole) rather than the proxied FS/TTY layer,
// keeping the Worker responsive to pump the GDB-remote transport.
//
//===----------------------------------------------------------------------===//

#include "lldb/API/SBBreakpoint.h"
#include "lldb/API/SBCommandInterpreter.h"
#include "lldb/API/SBCommandInterpreterRunOptions.h"
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
#include "lldb/Host/emscripten/ConnectionInProcess.h"
#include "lldb/Host/emscripten/WasmConsole.h"
#include "lldb/Utility/Connection.h"
#include "lldb/Utility/Timeout.h"

#include <atomic>
#include <cinttypes>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <functional>
#include <map>
#include <mutex>
#include <queue>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <utility>

// ---------------------------------------------------------------------------
// Off-worker session
// ---------------------------------------------------------------------------
//
// SB API calls that drive the debug session (connect, attach, continue, step,
// frame/variable queries) do blocking GDB-remote round-trips. They must NOT run
// on the JS worker thread: the worker pumps the transport bridge, so blocking
// it would deadlock the very round-trip we are waiting on. Instead the worker
// submits an operation (non-blocking) and the session pthread runs it, blocking
// freely while the worker stays responsive. Results are polled back by id.
namespace {

class Session {
public:
  void Submit(uint32_t id, std::function<std::string()> fn) {
    EnsureStarted();
    std::lock_guard<std::mutex> lock(m_mutex);
    m_requests.emplace(id, std::move(fn));
    m_cv.notify_one();
  }

  // Pop one completed result. Returns its id (> 0) and fills out_json, or 0 if
  // none are ready.
  uint32_t Poll(std::string &out_json) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_ready.empty())
      return 0;
    uint32_t id = m_ready.front();
    m_ready.pop();
    auto it = m_results.find(id);
    out_json = std::move(it->second);
    m_results.erase(it);
    return id;
  }

private:
  void EnsureStarted() {
    if (m_started.exchange(true))
      return;
    std::thread([this] { Loop(); }).detach();
  }

  void Loop() {
    for (;;) {
      std::pair<uint32_t, std::function<std::string()>> req;
      {
        std::unique_lock<std::mutex> lock(m_mutex);
        m_cv.wait(lock, [this] { return !m_requests.empty(); });
        req = std::move(m_requests.front());
        m_requests.pop();
      }
      std::string result = req.second(); // blocking SB work; worker stays free
      {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_results[req.first] = std::move(result);
        m_ready.push(req.first);
      }
    }
  }

  std::atomic<bool> m_started{false};
  std::mutex m_mutex;
  std::condition_variable m_cv;
  std::queue<std::pair<uint32_t, std::function<std::string()>>> m_requests;
  std::map<uint32_t, std::string> m_results;
  std::queue<uint32_t> m_ready;
};

Session g_session;

// Take ownership of a malloc'd C string (from an lldb_wasm_* JSON function) and
// return it as a std::string, freeing the original.
std::string TakeString(char *s) {
  std::string out = s ? s : "";
  free(s);
  return out;
}

} // namespace

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
  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
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
  lldb::SBTarget target = d->CreateTarget("", "wasm32", "wasm", false, error);
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
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_set_breakpoint_by_location(
    uint32_t handle, const char *file, uint32_t line) {
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
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_set_breakpoint_by_address(
    uint32_t handle, uint32_t addr_lo, uint32_t addr_hi) {
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
EMSCRIPTEN_KEEPALIVE void
lldb_wasm_enable_breakpoint(uint32_t handle, uint32_t bp_id, int enable) {
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();
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
        const char *signame =
            signals.GetSignalAsCString(thread.GetStopReasonDataAtIndex(0));
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();

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
      result += R"(,"line":)" + std::to_string(ctx.GetLineEntry().GetLine());
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();
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

  lldb::SBValueList vars = frame.GetVariables(
      true, true, true, true); // args, locals, statics, in_scope_only

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
EMSCRIPTEN_KEEPALIVE int
lldb_wasm_read_memory(uint32_t handle, uint32_t addr_lo, uint32_t addr_hi,
                      uint8_t *buf, uint32_t size, uint32_t *bytes_read) {
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
  lldb::SBThread thread =
      d->GetSelectedTarget().GetProcess().GetSelectedThread();

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
    result = R"({"value":")" + escape(value) + R"(","type":")" + escape(type) +
             "\"}";
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
// When the GDB remote server runs in the same wasm module as LLDB, TCP sockets
// are replaced by an in-memory channel pair (ConnectionInProcess). The channel
// registry lives in InProcessChannel.cpp (part of the ProcessWasm plugin).
// ProcessWasm::DoConnectRemote handles the "inprocess://<id>" URL scheme and
// claims the LLDB endpoint; these functions manage the lifecycle from the JS
// API side and give the GDB server access to its endpoint.

// Create an in-process channel. Returns a channel ID (> 0).
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_create_channel() {
  return lldb_private::wasm::CreateInProcessChannel();
}

// Connect a debugger to an in-process channel.
//
// This creates a wasm32 target, then calls ConnectRemote with the URL
// "inprocess://<channel_id>". ProcessWasm::DoConnectRemote intercepts that
// URL, claims the LLDB endpoint from the registry, injects it into the GDB
// remote communicator, and performs the GDB remote handshake.
//
// The GDB server MUST be running and ready to respond to the handshake before
// this is called (it blocks until the handshake completes).
//
// Returns 0 on success.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_connect_inprocess(uint32_t handle,
                                                     uint32_t channel_id) {
  if (!handle)
    return 1;

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));

  lldb::SBError error;
  lldb::SBTarget target = d->CreateTarget("", "wasm32", "wasm", false, error);
  if (!target.IsValid())
    return 1;

  // Encode the channel ID in the URL. ProcessWasm::DoConnectRemote parses it.
  std::string url = "inprocess://" + std::to_string(channel_id);
  lldb::SBListener listener = d->GetListener();
  lldb::SBProcess process =
      target.ConnectRemote(listener, url.c_str(), "wasm", error);
  return (process.IsValid() && error.Success()) ? 0 : 1;
}

// Server side: write bytes into the channel (server → LLDB).
// Returns bytes written, or -1 if the channel does not exist.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_channel_server_write(uint32_t channel_id,
                                                        const uint8_t *data,
                                                        uint32_t size) {
  lldb_private::Connection *conn =
      lldb_private::wasm::GetServerConnection(channel_id);
  if (!conn)
    return -1;
  lldb::ConnectionStatus status;
  return static_cast<int>(conn->Write(data, size, status, nullptr));
}

// Server side: read bytes from the channel (LLDB → server).
// Blocks for up to timeout_ms milliseconds; 0 means non-blocking (return
// immediately with whatever is buffered). Returns bytes read, or -1 if the
// channel does not exist.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_channel_server_read(uint32_t channel_id,
                                                       uint8_t *buf,
                                                       uint32_t size,
                                                       uint32_t timeout_ms) {
  lldb_private::Connection *conn =
      lldb_private::wasm::GetServerConnection(channel_id);
  if (!conn)
    return -1;
  lldb::ConnectionStatus status;
  lldb_private::Timeout<std::micro> timeout(
      std::chrono::microseconds(timeout_ms * 1000LL));
  return static_cast<int>(conn->Read(buf, size, timeout, status, nullptr));
}

// Destroy a channel and release both its connection endpoints.
EMSCRIPTEN_KEEPALIVE void lldb_wasm_destroy_channel(uint32_t channel_id) {
  lldb_private::wasm::DestroyInProcessChannel(channel_id);
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
    lldb::ReturnStatus status = interp.HandleCommand(command, result, false);
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
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += c;
        break;
      }
    }
    return out;
  };

  std::string result_json = R"({"output":")" + escape(output_str) +
                            R"(","error":")" + escape(error_str) +
                            R"(","status":)" + std::to_string(return_status) +
                            "}";

  char *ret = static_cast<char *>(malloc(result_json.size() + 1));
  memcpy(ret, result_json.c_str(), result_json.size() + 1);
  return ret;
}

// ---------------------------------------------------------------------------
// Interactive command interpreter
// ---------------------------------------------------------------------------
//
// Runs the genuine LLDB command-interpreter REPL on a dedicated thread, reading
// from / writing to the wasm console channels (see WasmConsole.h). The call
// returns immediately so the worker thread stays free to pump the GDB-remote
// transport and feed stdin. The REPL exits when stdin is closed (Ctrl-D) or the
// user runs `quit`.

static std::atomic<bool> g_interpreter_started{false};
static std::atomic<bool> g_interpreter_finished{false};

EMSCRIPTEN_KEEPALIVE void lldb_wasm_run_command_interpreter(uint32_t handle) {
  if (!handle || g_interpreter_started.exchange(true))
    return;

  auto *d =
      reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));

  // Synchronous mode: execution commands (continue/step/run) block until the
  // target stops and print the stop reason themselves. This avoids LLDB's async
  // event-handler thread, whose pthread_join hangs under Emscripten on exit.
  // The worker thread stays free to pump the GDB-remote transport, so these
  // waits complete normally.
  d->SetAsync(false);

  d->SetInputFile(lldb_private::wasm_console::GetInputFile());
  d->SetOutputFile(lldb_private::wasm_console::GetOutputFile());
  d->SetErrorFile(lldb_private::wasm_console::GetOutputFile());

  std::thread([d]() {
    lldb::SBCommandInterpreterRunOptions opts;
    opts.SetAutoHandleEvents(false);
    opts.SetSpawnThread(false);
    opts.SetStopOnError(false);
    opts.SetStopOnCrash(false);
    d->RunCommandInterpreter(opts);
    g_interpreter_finished.store(true);
  }).detach();
}

// Feed bytes to the interpreter's stdin. Returns bytes written.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_console_stdin_write(const uint8_t *data,
                                                       uint32_t len) {
  if (!data)
    return 0;
  return static_cast<int>(lldb_private::wasm_console::WriteStdin(data, len));
}

// Signal end-of-input; the interpreter exits its read loop (like Ctrl-D).
EMSCRIPTEN_KEEPALIVE void lldb_wasm_console_stdin_close() {
  lldb_private::wasm_console::CloseStdin();
}

// Drain pending interpreter output into buf. Non-blocking. Returns bytes read.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_console_stdout_read(uint8_t *buf,
                                                       uint32_t len) {
  if (!buf || !len)
    return 0;
  return static_cast<int>(lldb_private::wasm_console::ReadStdout(buf, len));
}

// Returns 1 once the interpreter has exited (quit/EOF), else 0.
EMSCRIPTEN_KEEPALIVE int lldb_wasm_console_interpreter_finished() {
  return g_interpreter_finished.load() ? 1 : 0;
}

// Find a variable by name in a stack frame and return it as JSON:
//   {"valid":true,"value":"10","type":"int","unsigned":10,"signed":10}
//   {"valid":false}
// Caller must free the result with lldb_wasm_free_string.
EMSCRIPTEN_KEEPALIVE char *lldb_wasm_find_variable(uint32_t handle,
                                                   uint32_t frame_index,
                                                   const char *name) {
  std::string result = R"({"valid":false})";
  if (handle && name) {
    auto *d =
        reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
    lldb::SBThread thread =
        d->GetSelectedTarget().GetProcess().GetSelectedThread();
    if (thread.IsValid()) {
      lldb::SBFrame frame = thread.GetFrameAtIndex(frame_index);
      if (frame.IsValid()) {
        lldb::SBExpressionOptions opts;
        opts.SetFetchDynamicValue(lldb::eDynamicDontRunTarget);
        opts.SetTryAllThreads(false);
        opts.SetUnwindOnError(true);
        lldb::SBValue val = frame.EvaluateExpression(name, opts);
        if (val.IsValid() && !val.GetError().Fail()) {
          auto escape = [](const char *s) -> std::string {
            std::string out;
            for (const char *p = s ? s : ""; *p; ++p) {
              if (*p == '"' || *p == '\\')
                out += '\\';
              out += *p;
            }
            return out;
          };
          result = R"({"valid":true,"value":")" + escape(val.GetValue()) +
                   R"(","type":")" + escape(val.GetTypeName()) +
                   R"(","unsigned":)" +
                   std::to_string(val.GetValueAsUnsigned()) + R"(,"signed":)" +
                   std::to_string(val.GetValueAsSigned()) + "}";
        }
      }
    }
  }
  char *ret = static_cast<char *>(malloc(result.size() + 1));
  memcpy(ret, result.c_str(), result.size() + 1);
  return ret;
}

// ---------------------------------------------------------------------------
// Session ops (run on the session pthread; see the Session class above)
// ---------------------------------------------------------------------------
//
// Each op copies its arguments, enqueues a closure that calls the matching
// (blocking) lldb_wasm_* function, and returns immediately. The worker drains
// results with lldb_wasm_session_poll.

EMSCRIPTEN_KEEPALIVE void lldb_wasm_session_command(uint32_t req_id,
                                                    uint32_t handle,
                                                    const char *command) {
  std::string cmd = command ? command : "";
  g_session.Submit(req_id, [handle, cmd] {
    // Session ops run on the session pthread, so blocking is fine and desired:
    // synchronous mode makes execution commands (continue/step) wait for the
    // stop and report it, instead of returning "resuming" immediately.
    auto *d =
        reinterpret_cast<lldb::SBDebugger *>(static_cast<uintptr_t>(handle));
    d->SetAsync(false);
    return TakeString(lldb_wasm_run_command(handle, cmd.c_str()));
  });
}

EMSCRIPTEN_KEEPALIVE void lldb_wasm_session_state(uint32_t req_id,
                                                  uint32_t handle) {
  g_session.Submit(req_id, [handle] {
    return TakeString(lldb_wasm_get_stop_reason(handle));
  });
}

EMSCRIPTEN_KEEPALIVE void lldb_wasm_session_frames(uint32_t req_id,
                                                   uint32_t handle) {
  g_session.Submit(req_id, [handle] {
    return TakeString(lldb_wasm_get_frame_info(handle));
  });
}

EMSCRIPTEN_KEEPALIVE void lldb_wasm_session_variable(uint32_t req_id,
                                                     uint32_t handle,
                                                     uint32_t frame_index,
                                                     const char *name) {
  std::string var = name ? name : "";
  g_session.Submit(req_id, [handle, frame_index, var] {
    return TakeString(
        lldb_wasm_find_variable(handle, frame_index, var.c_str()));
  });
}

// Drain one completed session result. Writes the result JSON into buf (up to
// size bytes) and returns its request id, or 0 if none are ready.
EMSCRIPTEN_KEEPALIVE uint32_t lldb_wasm_session_poll(uint8_t *buf,
                                                     uint32_t size,
                                                     uint32_t *out_len) {
  std::string json;
  uint32_t id = g_session.Poll(json);
  if (id == 0)
    return 0;
  uint32_t n = static_cast<uint32_t>(json.size());
  if (n > size)
    n = size;
  if (buf && n)
    memcpy(buf, json.data(), n);
  if (out_len)
    *out_len = n;
  return id;
}

} // extern "C"

int main() {
  // Nothing to do here; the JS wrapper calls lldb_wasm_initialize() after the
  // module is ready and drives everything through the exported functions.
  return 0;
}
