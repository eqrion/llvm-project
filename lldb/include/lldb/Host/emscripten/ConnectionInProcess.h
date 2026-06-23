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

// Registry of in-process channels, keyed by an integer ID encoded in the
// "inprocess://<id>" connect URL. JS (or an in-wasm GDB server) creates a
// channel and exposes its server endpoint; LLDB claims the client endpoint when
// it connects. Used by both ProcessWasm (process connection) and
// PlatformWasmRemoteGDBServer (platform connection).
namespace wasm {

/// Create a bidirectional in-process channel. Returns a channel ID > 0. Both
/// endpoints are held in the registry until claimed or destroyed.
uint32_t CreateInProcessChannel();

/// Claim the LLDB-side connection for a channel. Transfers ownership out of the
/// registry; subsequent calls with the same ID return nullptr.
std::unique_ptr<Connection> TakeConnectionForChannel(uint32_t channel_id);

/// Return the server-side connection without transferring ownership, for
/// exchanging GDB RSP packets with LLDB. Returns nullptr if the channel does
/// not exist.
Connection *GetServerConnection(uint32_t channel_id);

/// Release a channel and both of its connections.
void DestroyInProcessChannel(uint32_t channel_id);

} // namespace wasm

} // namespace lldb_private

#endif // LLDB_HOST_EMSCRIPTEN_CONNECTIONINPROCESS_H
