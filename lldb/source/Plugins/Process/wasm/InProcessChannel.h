//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// Registry for in-process GDB remote channels used when the GDB server runs
// inside the same wasm module as LLDB.
//
// The C API in lldb-wasm.cpp creates channels via CreateInProcessChannel() and
// exposes the server-side endpoint for the GDB server to read/write packets.
// ProcessWasm::DoConnectRemote claims the LLDB-side endpoint via
// TakeConnectionForChannel() and injects it into the GDB remote communicator.
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_PLUGINS_PROCESS_WASM_INPROCESSCHANNEL_H
#define LLDB_PLUGINS_PROCESS_WASM_INPROCESSCHANNEL_H

#include "lldb/Utility/Connection.h"

#include <cstdint>
#include <memory>

namespace lldb_private {

namespace wasm {

/// Create a bidirectional in-process GDB remote channel.
/// Returns a channel ID > 0. Both endpoints are held in the registry until
/// claimed or destroyed.
uint32_t CreateInProcessChannel();

/// Claim the LLDB-side connection for a channel. Transfers ownership out of
/// the registry; subsequent calls with the same ID return nullptr.
/// Called by ProcessWasm::DoConnectRemote.
std::unique_ptr<Connection> TakeConnectionForChannel(uint32_t channel_id);

/// Return the server-side connection without transferring ownership.
/// The caller may call Read/Write on it to exchange GDB RSP packets with LLDB.
/// Returns nullptr if the channel does not exist.
Connection *GetServerConnection(uint32_t channel_id);

/// Release a channel and both of its connections.
void DestroyInProcessChannel(uint32_t channel_id);

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_PLUGINS_PROCESS_WASM_INPROCESSCHANNEL_H
