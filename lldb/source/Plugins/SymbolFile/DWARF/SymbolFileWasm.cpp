//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "SymbolFileWasm.h"
#include "Plugins/Process/wasm/ProcessWasm.h"
#include "Plugins/SymbolFile/DWARF/LogChannelDWARF.h"
#include "Utility/WasmVirtualRegisters.h"
#include "lldb/Target/RegisterContext.h"
#include "lldb/Utility/DataBufferHeap.h"
#include "lldb/Utility/DataExtractor.h"
#include "lldb/Utility/LLDBLog.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::plugin::dwarf;

SymbolFileWasm::SymbolFileWasm(ObjectFileSP objfile_sp,
                               SectionList *dwo_section_list)
    : SymbolFileDWARF(objfile_sp, dwo_section_list) {}

SymbolFileWasm::~SymbolFileWasm() = default;

lldb::offset_t
SymbolFileWasm::GetVendorDWARFOpcodeSize(const DataExtractor &data,
                                         const lldb::offset_t data_offset,
                                         const uint8_t op) const {
  if (op != llvm::dwarf::DW_OP_WASM_location)
    return LLDB_INVALID_OFFSET;

  lldb::offset_t offset = data_offset;
  const uint8_t wasm_op = data.GetU8(&offset);
  switch (wasm_op) {
  case 0: // LOCAL
  case 1: // GLOBAL_FIXED
  case 2: // OPERAND_STACK
    data.GetULEB128(&offset);
    break;
  case 3: // GLOBAL_RELOC
    data.GetU32(&offset);
    break;
  default:
    return LLDB_INVALID_OFFSET;
  }

  return offset - data_offset;
}

bool SymbolFileWasm::ParseVendorDWARFOpcode(uint8_t op,
                                            const DataExtractor &opcodes,
                                            lldb::offset_t &offset,
                                            RegisterContext *reg_ctx,
                                            lldb::RegisterKind reg_kind,
                                            std::vector<Value> &stack) const {
  if (op != llvm::dwarf::DW_OP_WASM_location)
    return false;

  uint32_t index = 0;
  uint8_t tag = eWasmTagNotAWasmLocation;

  /// |DWARF Location Index | WebAssembly Construct |
  /// |---------------------|-----------------------|
  /// |0                    | Local                 |
  /// |1 or 3               | Global                |
  /// |2                    | Operand Stack         |
  const uint8_t wasm_op = opcodes.GetU8(&offset);
  switch (wasm_op) {
  case 0: // LOCAL
    index = opcodes.GetULEB128(&offset);
    tag = eWasmTagLocal;
    break;
  case 1: // GLOBAL_FIXED
    index = opcodes.GetULEB128(&offset);
    tag = eWasmTagGlobal;
    break;
  case 2: // OPERAND_STACK
    index = opcodes.GetULEB128(&offset);
    tag = eWasmTagOperandStack;
    break;
  case 3: // GLOBAL_RELOC
    index = opcodes.GetU32(&offset);
    tag = eWasmTagGlobal;
    break;
  default:
    return false;
  }

  // Get the ProcessWasm to send qWasmLocal/qWasmGlobal packets.
  // We bypass ReadRegisterValueAsScalar because the reg_ctx passed here is
  // often a GDBRemoteRegisterContext which doesn't understand wasm virtual
  // register numbers. Going directly to the process avoids that indirection.
  // Navigate to ProcessWasm via the module's target, which avoids relying on
  // reg_ctx->CalculateProcess() which can return the base ProcessGDBRemote.
  wasm::ProcessWasm *wasm_process = nullptr;
  // SymbolFileWasm is only instantiated for wasm modules, so the process
  // must always be a ProcessWasm. We reach it through the target to avoid
  // the intermediate GDBRemoteRegisterContext returning ProcessGDBRemote.
  if (reg_ctx) {
    if (TargetSP target_sp = reg_ctx->CalculateTarget()) {
      const ProcessSP &proc_sp = target_sp->GetProcessSP();
      if (proc_sp)
        wasm_process = static_cast<wasm::ProcessWasm *>(proc_sp.get());
    }
  }
  if (!wasm_process)
    return false;

  // Use frame 0 as the default; if reg_ctx is a RegisterContextWasm we could
  // extract the actual frame index, but frame 0 is correct for most cases.
  const uint32_t frame_index = 0;
  llvm::Expected<lldb::DataBufferSP> maybe_buffer =
      wasm_process->GetWasmVariable(
          static_cast<WasmVirtualRegisterKinds>(tag), frame_index, index);
  if (!maybe_buffer) {
    LLDB_LOG_ERROR(GetLog(DWARFLog::DebugInfo), maybe_buffer.takeError(), "{0}");
    return false;
  }

  DataExtractor data(*maybe_buffer, wasm_process->GetByteOrder(),
                     wasm_process->GetAddressByteSize());
  lldb::offset_t data_offset = 0;
  Value tmp;
  switch ((*maybe_buffer)->GetByteSize()) {
  case 1: tmp.GetScalar() = data.GetU8(&data_offset); break;
  case 2: tmp.GetScalar() = data.GetU16(&data_offset); break;
  case 4: tmp.GetScalar() = data.GetU32(&data_offset); break;
  case 8: tmp.GetScalar() = data.GetU64(&data_offset); break;
  default:
    return false;
  }
  tmp.SetValueType(Value::ValueType::Scalar);
  stack.push_back(tmp);
  return true;
}
