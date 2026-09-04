//===-- lldb-wasm-dap.cpp ------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// Byte-stream host for LLDB's built-in Debug Adapter Protocol implementation.
// The DAP loop runs on a pthread so blocking debugger/RSP work never stalls the
// JavaScript worker that pumps lldb-wasm's in-process transports.
//
//===----------------------------------------------------------------------===//

#include "DAP.h"
#include "DAPLog.h"
#include "DAPSessionManager.h"
#include "Handler/RequestHandler.h"
#include "Handler/ResponseHandler.h"
#include "Protocol/ProtocolBase.h"
#include "Transport.h"
#include "lldb/Host/File.h"
#include "lldb/Host/MainLoop.h"
#include "lldb/Host/Pipe.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace lldb;
using namespace lldb_dap;
using namespace lldb_private;

namespace {

enum DAPStatus : int { Running = 0, Finished = 1, Failed = -1 };

class WasmDAPSession {
public:
  bool Start(const char *pre_init_commands_json, bool no_lldbinit) {
    if (lldb_private::Status status = m_input.CreateNew(); status.Fail()) {
      SetError(status.AsCString("failed to create DAP input pipe"));
      return false;
    }
    if (lldb_private::Status status = m_output.CreateNew(); status.Fail()) {
      SetError(status.AsCString("failed to create DAP output pipe"));
      return false;
    }

    std::vector<protocol::String> pre_init_commands;
    if (!ParseCommands(pre_init_commands_json, pre_init_commands))
      return false;

    const int input_fd = m_input.ReleaseReadFileDescriptor();
    const int output_fd = m_output.ReleaseWriteFileDescriptor();
    m_input_file = std::make_shared<NativeFile>(
        input_fd, File::eOpenOptionReadOnly, NativeFile::Owned);
    m_output_file = std::make_shared<NativeFile>(
        output_fd, File::eOpenOptionWriteOnly, NativeFile::Owned);

    const int read_fd = m_output.GetReadFileDescriptor();
    const int flags = fcntl(read_fd, F_GETFL);
    if (flags == -1 || fcntl(read_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
      SetError(std::string("failed to make DAP output non-blocking: ") +
               std::strerror(errno));
      return false;
    }

    m_loop = std::make_unique<MainLoop>();
    m_log = std::make_unique<lldb_dap::Log>(llvm::nulls(), m_log_mutex);
    m_transport = std::make_unique<Transport>(*m_log, *m_loop, m_input_file,
                                              m_output_file);
    m_dap =
        std::make_unique<DAP>(*m_log, ReplMode::Auto, pre_init_commands,
                              no_lldbinit, "lldb-wasm", *m_transport, *m_loop);

    if (llvm::Error error = m_dap->ConfigureIO()) {
      SetError(llvm::toString(std::move(error)));
      return false;
    }

    DAPSessionManager::GetInstance().RegisterSession(m_loop.get(), m_dap.get());
    m_thread = std::thread([this] {
      if (llvm::Error error = m_dap->Loop()) {
        SetError(llvm::toString(std::move(error)));
        m_status.store(Failed);
      } else {
        m_status.store(Finished);
      }
      DAPSessionManager::GetInstance().UnregisterSession(m_loop.get());
    });
    return true;
  }

  ~WasmDAPSession() {
    CloseInput();
    if (m_thread.joinable())
      m_thread.join();
  }

  int WriteInput(const uint8_t *data, uint32_t len) {
    if (!data)
      return 0;
    uint32_t written = 0;
    while (written < len) {
      ssize_t n = ::write(m_input.GetWriteFileDescriptor(), data + written,
                          len - written);
      if (n < 0) {
        if (errno == EINTR)
          continue;
        return -1;
      }
      written += static_cast<uint32_t>(n);
    }
    return static_cast<int>(written);
  }

  void CloseInput() { m_input.CloseWriteFileDescriptor(); }

  int ReadOutput(uint8_t *buf, uint32_t len) {
    if (!buf || !len)
      return 0;
    ssize_t n = ::read(m_output.GetReadFileDescriptor(), buf, len);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
      return 0;
    return n < 0 ? -1 : static_cast<int>(n);
  }

  int GetStatus() const { return m_status.load(); }

  std::string Error() const {
    std::lock_guard<std::mutex> lock(m_error_mutex);
    return m_error;
  }

private:
  bool ParseCommands(const char *json,
                     std::vector<protocol::String> &commands) {
    llvm::Expected<llvm::json::Value> value =
        llvm::json::parse(json ? json : "[]");
    if (!value) {
      SetError(llvm::toString(value.takeError()));
      return false;
    }
    llvm::json::Array *array = value->getAsArray();
    if (!array) {
      SetError("DAP pre-init commands must be a JSON array");
      return false;
    }
    for (const llvm::json::Value &item : *array) {
      std::optional<llvm::StringRef> command = item.getAsString();
      if (!command) {
        SetError("each DAP pre-init command must be a string");
        return false;
      }
      commands.emplace_back(*command);
    }
    return true;
  }

  void SetError(std::string error) {
    std::lock_guard<std::mutex> lock(m_error_mutex);
    m_error = std::move(error);
    m_status.store(Failed);
  }

  Pipe m_input;
  Pipe m_output;
  lldb::IOObjectSP m_input_file;
  lldb::IOObjectSP m_output_file;
  std::unique_ptr<MainLoop> m_loop;
  lldb_dap::Log::Mutex m_log_mutex;
  std::unique_ptr<lldb_dap::Log> m_log;
  std::unique_ptr<Transport> m_transport;
  std::unique_ptr<DAP> m_dap;
  std::thread m_thread;
  std::atomic<int> m_status{Running};
  mutable std::mutex m_error_mutex;
  std::string m_error;
};

std::unique_ptr<WasmDAPSession> g_dap;

char *CopyString(const std::string &string) {
  char *result = static_cast<char *>(malloc(string.size() + 1));
  std::memcpy(result, string.c_str(), string.size() + 1);
  return result;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int lldb_wasm_dap_start(const char *pre_init_commands_json,
                                             int no_lldbinit) {
  if (g_dap && g_dap->GetStatus() == Running)
    return 1;
  g_dap.reset();
  g_dap = std::make_unique<WasmDAPSession>();
  if (!g_dap->Start(pre_init_commands_json, no_lldbinit != 0))
    return 1;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int lldb_wasm_dap_stdin_write(const uint8_t *data,
                                                   uint32_t len) {
  return g_dap ? g_dap->WriteInput(data, len) : -1;
}

EMSCRIPTEN_KEEPALIVE void lldb_wasm_dap_stdin_close() {
  if (g_dap)
    g_dap->CloseInput();
}

EMSCRIPTEN_KEEPALIVE int lldb_wasm_dap_stdout_read(uint8_t *buf, uint32_t len) {
  return g_dap ? g_dap->ReadOutput(buf, len) : 0;
}

EMSCRIPTEN_KEEPALIVE int lldb_wasm_dap_status() {
  return g_dap ? g_dap->GetStatus() : Finished;
}

EMSCRIPTEN_KEEPALIVE char *lldb_wasm_dap_error() {
  return CopyString(g_dap ? g_dap->Error() : std::string());
}

} // extern "C"
