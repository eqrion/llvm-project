//===-- HostInfoEmscripten.cpp --------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/emscripten/HostInfoEmscripten.h"
#include "lldb/Utility/ArchSpec.h"

#include "llvm/Support/Threading.h"

#include <mutex>

using namespace lldb_private;

void HostInfoEmscripten::Initialize() { HostInfoPosix::Initialize(); }

void HostInfoEmscripten::Terminate() { HostInfoBase::Terminate(); }

llvm::StringRef HostInfoEmscripten::GetDistributionId() {
  static std::string g_distribution_id = "emscripten";
  return g_distribution_id;
}

FileSpec HostInfoEmscripten::GetProgramFileSpec() {
  static FileSpec g_program_filespec;
  return g_program_filespec;
}

void HostInfoEmscripten::ComputeHostArchitectureSupport(ArchSpec &arch_32,
                                                        ArchSpec &arch_64) {
  // LLDB compiled to wasm32 - report the host as wasm32.
  arch_32.SetTriple("wasm32-unknown-unknown");
  arch_64.SetTriple("wasm64-unknown-unknown");
}
