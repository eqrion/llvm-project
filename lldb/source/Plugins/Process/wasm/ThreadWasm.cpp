//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "ThreadWasm.h"

#include "ProcessWasm.h"
#include "RegisterContextWasm.h"
#include "UnwindWasm.h"
#include "lldb/Target/Process.h"
#include "lldb/Target/RegisterContext.h"
#include "lldb/Target/StopInfo.h"
#include "lldb/Target/Target.h"
#include "lldb/Target/ThreadPlan.h"
#include "lldb/Utility/Status.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

// ---------------------------------------------------------------------------
// ThreadPlanWasmStep
//
// Wasm has a virtual PC (from qWasmCallStack) that the generic step-instruction
// plan cannot use: it reads the PC register which is always 0 for wasm, so
// IsPlanStale() immediately returns true and the plan self-destructs before
// ever issuing vCont;s.
//
// This plan fixes that by:
//   - Recording the wasm call-stack depth and top-PC at creation.
//   - On WillResume: voting YES for a single-step (vCont;s).
//   - On each stop: querying qWasmCallStack to decide whether to continue.
//
// Modes
//   kStepIn  : stop as soon as the top-frame PC changes.
//   kStepOver: stop when the top-frame PC changes AND the stack depth has not
//              grown (i.e. we have not stepped into a callee).
//   kStepOut : stop when the stack depth decreases below the start depth.
// ---------------------------------------------------------------------------
namespace {
enum class WasmStepMode { StepIn, StepOver, StepOut };

class ThreadPlanWasmStep : public ThreadPlan {
public:
  ThreadPlanWasmStep(Thread &thread, WasmStepMode mode)
      : ThreadPlan(ThreadPlan::eKindGeneric, "wasm step", thread,
                   eVoteYes, eVoteNoOpinion),
        m_mode(mode) {
    auto cs = GetWasmCallStack();
    if (cs) {
      m_start_depth = cs->size();
      m_start_pc = cs->empty() ? 0 : (*cs)[0];
    }
  }

  bool ValidatePlan(Stream *) override { return true; }

  void GetDescription(Stream *s, lldb::DescriptionLevel level) override {
    s->PutCString("wasm step");
  }

  lldb::StateType GetPlanRunState() override { return eStateStepping; }

  bool WillStop() override { return true; }

  bool DoWillResume(StateType resume_state, bool current_plan) override {
    GetThread().SetResumeState(eStateStepping);
    return true;
  }

  bool DoPlanExplainsStop(Event *) override {
    // Claim every stop while we are the active plan so ShouldStop() decides.
    StopInfoSP stop_info = GetPrivateStopInfo();
    if (!stop_info)
      return true;
    StopReason reason = stop_info->GetStopReason();
    // Hand off breakpoint hits caused by a breakpoint the user set, not us.
    return reason != eStopReasonBreakpoint;
  }

  bool ShouldStop(Event *) override {
    auto cs = GetWasmCallStack();
    if (!cs || cs->empty()) {
      SetPlanComplete();
      return true;
    }

    size_t depth = cs->size();
    addr_t pc = (*cs)[0];

    bool should_stop = false;
    switch (m_mode) {
    case WasmStepMode::StepIn:
      should_stop = (pc != m_start_pc);
      break;
    case WasmStepMode::StepOver:
      if (depth > m_start_depth)
        return false;
      should_stop = (pc != m_start_pc);
      break;
    case WasmStepMode::StepOut:
      should_stop = (depth < m_start_depth);
      break;
    }
    if (should_stop)
      SetPlanComplete();
    return should_stop;
  }

  bool IsPlanStale() override { return false; }

  bool MischiefManaged() override {
    if (IsPlanComplete()) {
      ThreadPlan::MischiefManaged();
      return true;
    }
    return false;
  }

private:
  llvm::Expected<std::vector<addr_t>> GetWasmCallStack() {
    if (ProcessSP process_sp = GetThread().GetProcess()) {
      ProcessWasm *wasm_process = static_cast<ProcessWasm *>(process_sp.get());
      return wasm_process->GetWasmCallStack(GetThread().GetID());
    }
    return llvm::createStringError("no process");
  }

  WasmStepMode m_mode;
  size_t m_start_depth = 0;
  addr_t m_start_pc = 0;
};
} // namespace

// ---------------------------------------------------------------------------
// ThreadWasm
// ---------------------------------------------------------------------------

Unwind &ThreadWasm::GetUnwinder() {
  if (!m_unwinder_up) {
    assert(CalculateTarget()->GetArchitecture().GetMachine() ==
           llvm::Triple::wasm32);
    m_unwinder_up.reset(new wasm::UnwindWasm(*this));
  }
  return *m_unwinder_up;
}

llvm::Expected<std::vector<lldb::addr_t>> ThreadWasm::GetWasmCallStack() {
  if (ProcessSP process_sp = GetProcess()) {
    ProcessWasm *wasm_process = static_cast<ProcessWasm *>(process_sp.get());
    return wasm_process->GetWasmCallStack(GetID());
  }
  return llvm::createStringError("no process");
}

lldb::RegisterContextSP ThreadWasm::GetRegisterContext() {
  if (m_reg_context_sp)
    return m_reg_context_sp;
  ProcessSP process_sp(GetProcess());
  if (!process_sp)
    return {};
  ProcessWasm *wasm_process = static_cast<ProcessWasm *>(process_sp.get());
  m_reg_context_sp = std::make_shared<RegisterContextWasm>(
      *this, 0, wasm_process->GetRegisterInfo());
  return m_reg_context_sp;
}

lldb::RegisterContextSP
ThreadWasm::CreateRegisterContextForFrame(StackFrame *frame) {
  uint32_t concrete_frame_idx = 0;
  ProcessSP process_sp(GetProcess());
  ProcessWasm *wasm_process = static_cast<ProcessWasm *>(process_sp.get());

  if (frame)
    concrete_frame_idx = frame->GetConcreteFrameIndex();

  if (concrete_frame_idx == 0)
    return std::make_shared<RegisterContextWasm>(
        *this, concrete_frame_idx, wasm_process->GetRegisterInfo());

  return GetUnwinder().CreateRegisterContextForFrame(frame);
}

static ThreadPlanSP MakeWasmStepPlan(Thread &thread, WasmStepMode mode,
                                     bool abort_other_plans, Status &status) {
  ThreadPlanSP plan = std::make_shared<ThreadPlanWasmStep>(thread, mode);
  status = thread.QueueThreadPlan(plan, abort_other_plans);
  return plan;
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepSingleInstruction(
    bool step_over, bool abort_other_plans, bool, Status &status) {
  auto mode = step_over ? WasmStepMode::StepOver : WasmStepMode::StepIn;
  return MakeWasmStepPlan(*this, mode, abort_other_plans, status);
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepInRange(
    bool abort_other_plans, const AddressRange &, const SymbolContext &,
    const char *, lldb::RunMode, Status &status, LazyBool, LazyBool) {
  return MakeWasmStepPlan(*this, WasmStepMode::StepIn, abort_other_plans,
                          status);
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepInRange(
    bool abort_other_plans, const LineEntry &, const SymbolContext &,
    const char *, lldb::RunMode, Status &status, LazyBool, LazyBool) {
  return MakeWasmStepPlan(*this, WasmStepMode::StepIn, abort_other_plans,
                          status);
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepOverRange(
    bool abort_other_plans, const AddressRange &, const SymbolContext &,
    lldb::RunMode, Status &status, LazyBool) {
  return MakeWasmStepPlan(*this, WasmStepMode::StepOver, abort_other_plans,
                          status);
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepOverRange(
    bool abort_other_plans, const LineEntry &, const SymbolContext &,
    lldb::RunMode, Status &status, LazyBool) {
  return MakeWasmStepPlan(*this, WasmStepMode::StepOver, abort_other_plans,
                          status);
}

ThreadPlanSP ThreadWasm::QueueThreadPlanForStepOut(
    bool abort_other_plans, SymbolContext *, bool, bool, Vote, Vote, uint32_t,
    Status &status, LazyBool) {
  return MakeWasmStepPlan(*this, WasmStepMode::StepOut, abort_other_plans,
                          status);
}
