//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_WASM_THREADWASM_H
#define LLDB_SOURCE_PLUGINS_PROCESS_WASM_THREADWASM_H

#include "Plugins/Process/gdb-remote/ThreadGDBRemote.h"
#include "lldb/Target/Thread.h"

namespace lldb_private {
namespace wasm {

/// ProcessWasm provides the access to the Wasm program state
/// retrieved from the Wasm engine.
class ThreadWasm : public process_gdb_remote::ThreadGDBRemote {
public:
  ThreadWasm(Process &process, lldb::tid_t tid)
      : process_gdb_remote::ThreadGDBRemote(process, tid) {}
  ~ThreadWasm() override = default;

  /// Retrieve the current call stack from the WebAssembly remote process.
  llvm::Expected<std::vector<lldb::addr_t>> GetWasmCallStack();

  lldb::RegisterContextSP
  CreateRegisterContextForFrame(StackFrame *frame) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepSingleInstruction(
      bool step_over, bool abort_other_plans, bool stop_other_threads,
      Status &status) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepInRange(
      bool abort_other_plans, const AddressRange &range,
      const SymbolContext &addr_context, const char *step_in_target,
      lldb::RunMode stop_other_threads, Status &status,
      LazyBool step_in_avoids_code_without_debug_info =
          eLazyBoolCalculate,
      LazyBool step_out_avoids_code_without_debug_info =
          eLazyBoolCalculate) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepInRange(
      bool abort_other_plans, const LineEntry &line_entry,
      const SymbolContext &addr_context, const char *step_in_target,
      lldb::RunMode stop_other_threads, Status &status,
      LazyBool step_in_avoids_code_without_debug_info =
          eLazyBoolCalculate,
      LazyBool step_out_avoids_code_without_debug_info =
          eLazyBoolCalculate) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepOverRange(
      bool abort_other_plans, const AddressRange &range,
      const SymbolContext &addr_context, lldb::RunMode stop_other_threads,
      Status &status,
      LazyBool step_out_avoids_code_without_debug_info =
          eLazyBoolCalculate) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepOverRange(
      bool abort_other_plans, const LineEntry &line_entry,
      const SymbolContext &addr_context, lldb::RunMode stop_other_threads,
      Status &status,
      LazyBool step_out_avoids_code_without_debug_info =
          eLazyBoolCalculate) override;

  lldb::ThreadPlanSP QueueThreadPlanForStepOut(
      bool abort_other_plans, SymbolContext *addr_context, bool first_insn,
      bool stop_other_threads, Vote stop_vote, Vote run_vote,
      uint32_t frame_idx, Status &status,
      LazyBool step_out_avoids_code_without_debug_info =
          eLazyBoolCalculate) override;

protected:
  Unwind &GetUnwinder() override;

  ThreadWasm(const ThreadWasm &);
  const ThreadWasm &operator=(const ThreadWasm &) = delete;
};

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PROCESS_WASM_THREADWASM_H
