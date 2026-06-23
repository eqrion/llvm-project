//===-- WasmConsole.h -------------------------------------------*- C++ -*-===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// Console backing LLDB's interactive command interpreter in the wasm build.
//
// stdin and stdout are in-process byte channels in shared wasm memory rather
// than Emscripten's TTY/FS layer. The interpreter's IO-handler pthread blocks
// on the stdin channel; JS feeds input and drains output without ever blocking
// the filesystem-owning worker thread (which proxies FS syscalls for every
// pthread and must stay responsive).
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_HOST_EMSCRIPTEN_WASMCONSOLE_H
#define LLDB_HOST_EMSCRIPTEN_WASMCONSOLE_H

#include "lldb/lldb-forward.h"

#include <cstddef>

namespace lldb_private::wasm_console {

/// The input/output files to hand to SBDebugger::SetInputFile/SetOutputFile.
/// Created on first use and shared for the lifetime of the module.
lldb::FileSP GetInputFile();
lldb::FileSP GetOutputFile();

/// Feed bytes to the interpreter's stdin. Non-blocking. Returns bytes written.
size_t WriteStdin(const void *data, size_t len);

/// Signal end-of-input so the interpreter exits its read loop.
void CloseStdin();

/// Drain pending interpreter output. Non-blocking. Returns bytes read.
size_t ReadStdout(void *buf, size_t len);

} // namespace lldb_private::wasm_console

#endif // LLDB_HOST_EMSCRIPTEN_WASMCONSOLE_H
