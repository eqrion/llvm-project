//===-- ConnectionInProcess.h -----------------------------------*- C++ -*-===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// In-process bidirectional connection for use when the GDB remote server runs
// in the same wasm module. Both sides share memory directly; no sockets or
// pipes are involved.
//
// Usage:
//   auto [client, server] = ConnectionInProcess::CreatePair();
//   // Give client to LLDB's GDBRemoteCommunication via SetConnection().
//   // Give server to the GDB server implementation.
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_HOST_EMSCRIPTEN_CONNECTIONINPROCESS_H
#define LLDB_HOST_EMSCRIPTEN_CONNECTIONINPROCESS_H

#include "lldb/Utility/Connection.h"
#include "lldb/Utility/Timeout.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <utility>

namespace lldb_private {

// A simple lock-free-free channel: a mutex-protected byte deque with a
// condition variable for blocking reads.
struct InProcessChannel {
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<uint8_t> buffer;
  std::atomic<bool> closed{false};

  // Write bytes. Returns number written (always == len unless closed).
  size_t Write(const void *src, size_t len);

  // Blocking read with optional timeout. Returns bytes read, sets status.
  size_t Read(void *dst, size_t len, const Timeout<std::micro> &timeout,
              lldb::ConnectionStatus &status);

  void Close();
  void Interrupt();
};

class ConnectionInProcess : public Connection {
public:
  // Create a connected pair. The first element is the LLDB client side;
  // the second is the server side. Each side reads from one channel and
  // writes to the other.
  static std::pair<std::unique_ptr<ConnectionInProcess>,
                   std::unique_ptr<ConnectionInProcess>>
  CreatePair();

  ~ConnectionInProcess() override = default;

  lldb::ConnectionStatus Connect(llvm::StringRef url,
                                 Status *error_ptr) override;
  lldb::ConnectionStatus Disconnect(Status *error_ptr) override;
  bool IsConnected() const override;

  size_t Read(void *dst, size_t dst_len, const Timeout<std::micro> &timeout,
              lldb::ConnectionStatus &status, Status *error_ptr) override;
  size_t Write(const void *src, size_t src_len, lldb::ConnectionStatus &status,
               Status *error_ptr) override;
  bool InterruptRead() override;
  std::string GetURI() override;

private:
  ConnectionInProcess(std::shared_ptr<InProcessChannel> rx,
                      std::shared_ptr<InProcessChannel> tx);

  std::shared_ptr<InProcessChannel> m_rx;
  std::shared_ptr<InProcessChannel> m_tx;
  bool m_connected = false;
};

} // namespace lldb_private

#endif // LLDB_HOST_EMSCRIPTEN_CONNECTIONINPROCESS_H
