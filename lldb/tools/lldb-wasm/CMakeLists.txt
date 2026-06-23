if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  message(FATAL_ERROR "lldb-wasm must be built with Emscripten")
endif()

get_property(LLDB_ALL_PLUGINS GLOBAL PROPERTY LLDB_PLUGINS)

add_executable(lldb-wasm lldb-wasm.cpp)

target_include_directories(lldb-wasm PRIVATE
  ${LLDB_SOURCE_DIR}/source/Host/emscripten
  ${LLDB_SOURCE_DIR}/source/Plugins/Process/wasm)

target_link_libraries(lldb-wasm PRIVATE liblldb)

# Output as lldb-wasm.js + lldb-wasm.wasm.
set_target_properties(lldb-wasm PROPERTIES SUFFIX ".js")

# Emscripten link flags.
# -sMODULARIZE=1 / -sEXPORT_ES6=1: factory function as an ES6 default export.
# -sUSE_PTHREADS=1: enable pthreads for LLDB's internal threads (GDB remote
#   reader, event broadcaster). Each pthread maps to a Web Worker.
# -sPTHREAD_POOL_SIZE=8: pre-spawn workers so LLDB doesn't stall on first thread.
# -sENVIRONMENT=web,worker,node: support browsers, workers, and Node (for tests).
# No PROXY_TO_PTHREAD: our main() is trivial (returns 0 immediately), so proxying
# it to a pthread wastes a worker slot. The npm package runs the wasm inside a
# dedicated JS Worker, keeping the main thread free without PROXY_TO_PTHREAD.
set(LLDB_WASM_LINK_FLAGS
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAPU32"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=134217728"
  "-sPTHREAD_POOL_SIZE=8"
  "-sENVIRONMENT=web,worker,node"
  "-sWASM_BIGINT=1"
  "-sEXPORTED_FUNCTIONS=_lldb_wasm_initialize,_lldb_wasm_terminate,_lldb_wasm_create_debugger,_lldb_wasm_destroy_debugger,_lldb_wasm_connect,_lldb_wasm_disconnect,_lldb_wasm_attach_wasm_module,_lldb_wasm_set_breakpoint_by_location,_lldb_wasm_set_breakpoint_by_address,_lldb_wasm_remove_breakpoint,_lldb_wasm_enable_breakpoint,_lldb_wasm_resume,_lldb_wasm_pause,_lldb_wasm_step_over,_lldb_wasm_step_into,_lldb_wasm_step_out,_lldb_wasm_get_stop_reason,_lldb_wasm_get_num_threads,_lldb_wasm_get_num_frames,_lldb_wasm_get_frame_info,_lldb_wasm_get_variables_json,_lldb_wasm_read_memory,_lldb_wasm_evaluate_expression,_lldb_wasm_free_string,_lldb_wasm_create_channel,_lldb_wasm_connect_inprocess,_lldb_wasm_channel_server_write,_lldb_wasm_channel_server_read,_lldb_wasm_destroy_channel,_lldb_wasm_run_command,_lldb_wasm_run_command_interpreter,_lldb_wasm_console_stdin_write,_lldb_wasm_console_stdin_close,_lldb_wasm_console_stdout_read,_lldb_wasm_console_interpreter_finished,_lldb_wasm_find_variable,_lldb_wasm_session_command,_lldb_wasm_session_state,_lldb_wasm_session_frames,_lldb_wasm_session_variable,_lldb_wasm_session_poll,_malloc,_free"
)

string(JOIN " " LLDB_WASM_LINK_FLAGS_STR ${LLDB_WASM_LINK_FLAGS})
set_target_properties(lldb-wasm PROPERTIES
  LINK_FLAGS "${LLDB_WASM_LINK_FLAGS_STR}")
