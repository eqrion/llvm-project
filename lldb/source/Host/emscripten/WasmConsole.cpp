//===-- WasmConsole.cpp ---------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/emscripten/WasmConsole.h"
#include "lldb/Host/File.h"
#include "lldb/Host/emscripten/ConnectionInProcess.h"
#include "lldb/Utility/Status.h"
#include "lldb/Utility/Timeout.h"

#include <chrono>
#include <memory>

using namespace lldb;
using namespace lldb_private;

namespace {

// A File whose only capability is a blocking byte read from a channel. The
// command interpreter's IOHandler detects the absence of a FILE* (GetStream()
// returns nullptr) and falls back to Read(), so this runs entirely on the
// interpreter's pthread without touching Emscripten's FS layer.
class ConsoleInputFile : public File {
public:
  explicit ConsoleInputFile(std::shared_ptr<InProcessChannel> chan)
      : m_chan(std::move(chan)) {
    m_is_interactive = eLazyBoolYes;
    m_is_real_terminal = eLazyBoolNo;
    m_supports_colors = eLazyBoolNo;
  }

  bool IsValid() const override { return true; }

  Status Read(void *buf, size_t &num_bytes) override {
    ConnectionStatus status;
    num_bytes =
        m_chan->Read(buf, num_bytes, Timeout<std::micro>(std::nullopt), status);
    // num_bytes == 0 here means the channel was closed: EOF, which the
    // IOHandler treats as end of input.
    return Status();
  }

private:
  std::shared_ptr<InProcessChannel> m_chan;
};

// A File that forwards writes to a channel JS drains without blocking.
class ConsoleOutputFile : public File {
public:
  explicit ConsoleOutputFile(std::shared_ptr<InProcessChannel> chan)
      : m_chan(std::move(chan)) {
    m_is_interactive = eLazyBoolYes;
    m_is_real_terminal = eLazyBoolNo;
    m_supports_colors = eLazyBoolNo;
  }

  bool IsValid() const override { return true; }

  Status Write(const void *buf, size_t &num_bytes) override {
    num_bytes = m_chan->Write(buf, num_bytes);
    return Status();
  }

private:
  std::shared_ptr<InProcessChannel> m_chan;
};

struct Console {
  std::shared_ptr<InProcessChannel> in = std::make_shared<InProcessChannel>();
  std::shared_ptr<InProcessChannel> out = std::make_shared<InProcessChannel>();
  FileSP in_file = std::make_shared<ConsoleInputFile>(in);
  FileSP out_file = std::make_shared<ConsoleOutputFile>(out);
};

Console &GetConsole() {
  static Console *const g_console = new Console();
  return *g_console;
}

} // namespace

namespace lldb_private::wasm_console {

FileSP GetInputFile() { return GetConsole().in_file; }
FileSP GetOutputFile() { return GetConsole().out_file; }

size_t WriteStdin(const void *data, size_t len) {
  return GetConsole().in->Write(data, len);
}

void CloseStdin() { GetConsole().in->Close(); }

size_t ReadStdout(void *buf, size_t len) {
  ConnectionStatus status;
  return GetConsole().out->Read(
      buf, len, Timeout<std::micro>(std::chrono::microseconds(0)), status);
}

} // namespace lldb_private::wasm_console
