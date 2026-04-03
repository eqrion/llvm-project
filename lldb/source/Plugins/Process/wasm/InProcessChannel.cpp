//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "InProcessChannel.h"
#include "lldb/Host/emscripten/ConnectionInProcess.h"

#include <map>
#include <mutex>

using namespace lldb_private;
using namespace lldb_private::wasm;

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
