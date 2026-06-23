//===-- ConnectionInProcess.cpp -------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/emscripten/ConnectionInProcess.h"

#include "lldb/Utility/Status.h"
#include "lldb/Utility/Timeout.h"

#include <algorithm>
#include <chrono>
#include <map>
#include <mutex>

using namespace lldb;
using namespace lldb_private;

// InProcessChannel

size_t InProcessChannel::Write(const void *src, size_t len) {
  if (closed || !len)
    return 0;
  std::unique_lock<std::mutex> lock(mutex);
  const uint8_t *p = static_cast<const uint8_t *>(src);
  buffer.insert(buffer.end(), p, p + len);
  cv.notify_one();
  return len;
}

size_t InProcessChannel::Read(void *dst, size_t len,
                              const Timeout<std::micro> &timeout,
                              ConnectionStatus &status) {
  std::unique_lock<std::mutex> lock(mutex);

  auto wait_for_data = [this]() { return !buffer.empty() || closed; };

  if (timeout) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::microseconds(timeout->count());
    if (!cv.wait_until(lock, deadline, wait_for_data)) {
      status = eConnectionStatusTimedOut;
      return 0;
    }
  } else {
    cv.wait(lock, wait_for_data);
  }

  if (buffer.empty()) {
    status = closed ? eConnectionStatusEndOfFile : eConnectionStatusTimedOut;
    return 0;
  }

  size_t n = std::min(len, buffer.size());
  uint8_t *out = static_cast<uint8_t *>(dst);
  std::copy(buffer.begin(), buffer.begin() + n, out);
  buffer.erase(buffer.begin(), buffer.begin() + n);
  status = eConnectionStatusSuccess;
  return n;
}

void InProcessChannel::Close() {
  closed = true;
  cv.notify_all();
}

void InProcessChannel::Interrupt() { cv.notify_all(); }

// ConnectionInProcess

ConnectionInProcess::ConnectionInProcess(std::shared_ptr<InProcessChannel> rx,
                                         std::shared_ptr<InProcessChannel> tx)
    : m_rx(std::move(rx)), m_tx(std::move(tx)), m_connected(true) {}

std::pair<std::unique_ptr<ConnectionInProcess>,
          std::unique_ptr<ConnectionInProcess>>
ConnectionInProcess::CreatePair() {
  auto ch_a =
      std::make_shared<InProcessChannel>(); // client reads, server writes
  auto ch_b =
      std::make_shared<InProcessChannel>(); // server reads, client writes
  return {
      std::unique_ptr<ConnectionInProcess>(new ConnectionInProcess(ch_a, ch_b)),
      std::unique_ptr<ConnectionInProcess>(new ConnectionInProcess(ch_b, ch_a)),
  };
}

ConnectionStatus ConnectionInProcess::Connect(llvm::StringRef url,
                                              Status *error_ptr) {
  // Already connected when constructed via CreatePair. This entry point
  // exists only to satisfy the interface.
  m_connected = true;
  return eConnectionStatusSuccess;
}

ConnectionStatus ConnectionInProcess::Disconnect(Status *error_ptr) {
  if (!m_connected)
    return eConnectionStatusSuccess;
  m_connected = false;
  m_rx->Close();
  m_tx->Close();
  return eConnectionStatusSuccess;
}

bool ConnectionInProcess::IsConnected() const { return m_connected; }

size_t ConnectionInProcess::Read(void *dst, size_t dst_len,
                                 const Timeout<std::micro> &timeout,
                                 ConnectionStatus &status, Status *error_ptr) {
  if (!m_connected) {
    status = eConnectionStatusNoConnection;
    return 0;
  }
  return m_rx->Read(dst, dst_len, timeout, status);
}

size_t ConnectionInProcess::Write(const void *src, size_t src_len,
                                  ConnectionStatus &status, Status *error_ptr) {
  if (!m_connected) {
    status = eConnectionStatusNoConnection;
    return 0;
  }
  size_t n = m_tx->Write(src, src_len);
  status = n > 0 ? eConnectionStatusSuccess : eConnectionStatusEndOfFile;
  return n;
}

bool ConnectionInProcess::InterruptRead() {
  m_rx->Interrupt();
  return true;
}

std::string ConnectionInProcess::GetURI() {
  return m_connected ? "inprocess://" : "";
}

// Channel registry

namespace {

struct ChannelEntry {
  std::unique_ptr<ConnectionInProcess> lldb_side;
  std::unique_ptr<ConnectionInProcess> server_side;
};

std::mutex g_mutex;
uint32_t g_next_id = 1;
std::map<uint32_t, ChannelEntry> g_channels;

} // namespace

uint32_t lldb_private::wasm::CreateInProcessChannel() {
  auto [lldb_end, server_end] = ConnectionInProcess::CreatePair();
  std::lock_guard<std::mutex> lock(g_mutex);
  uint32_t id = g_next_id++;
  g_channels[id] = {std::move(lldb_end), std::move(server_end)};
  return id;
}

std::unique_ptr<Connection>
lldb_private::wasm::TakeConnectionForChannel(uint32_t channel_id) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_channels.find(channel_id);
  if (it == g_channels.end())
    return nullptr;
  return std::move(it->second.lldb_side);
}

Connection *lldb_private::wasm::GetServerConnection(uint32_t channel_id) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_channels.find(channel_id);
  if (it == g_channels.end())
    return nullptr;
  return it->second.server_side.get();
}

void lldb_private::wasm::DestroyInProcessChannel(uint32_t channel_id) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_channels.erase(channel_id);
}
