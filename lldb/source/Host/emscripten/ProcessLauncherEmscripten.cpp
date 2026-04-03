//===-- ProcessLauncherEmscripten.cpp -------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// LLDB compiled to wasm is a remote debugging client. Process launching is
// not supported; always return an error.
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/posix/ProcessLauncherPosixFork.h"
#include "lldb/Host/HostProcess.h"
#include "lldb/Host/ProcessLaunchInfo.h"
#include "lldb/Utility/Status.h"

using namespace lldb_private;

HostProcess
ProcessLauncherPosixFork::LaunchProcess(const ProcessLaunchInfo &launch_info,
                                        Status &error) {
  error = Status::FromErrorString(
      "process launching is not supported in the wasm LLDB client");
  return HostProcess();
}
