# CMake cache for building LLDB as WebAssembly with Emscripten.
# Invoke via: emcmake cmake -S llvm -B build-wasm -C lldb/cmake/caches/Emscripten.cmake
#
# Requires LLVM_NATIVE_TOOL_DIR to point to a native build containing
# llvm-tblgen, clang-tblgen, and lldb-tblgen. Build those first with:
#   cmake -S llvm -B build-native -DLLVM_ENABLE_PROJECTS="clang;lldb"
#     -DLLVM_TARGETS_TO_BUILD=WebAssembly
#   cmake --build build-native --target llvm-tblgen clang-tblgen lldb-tblgen

# Build only what we need.
set(LLVM_ENABLE_PROJECTS "clang;lldb" CACHE STRING "")
set(LLVM_TARGETS_TO_BUILD "WebAssembly" CACHE STRING "")

# Build type.
set(CMAKE_BUILD_TYPE "Release" CACHE STRING "")
set(LLVM_ENABLE_ASSERTIONS OFF CACHE BOOL "")

# Cross-compilation: native tblgen tools.
# LLVM_NATIVE_TOOL_DIR must be set externally (via -D on the cmake invocation).
if(DEFINED LLVM_NATIVE_TOOL_DIR)
  set(LLVM_TABLEGEN "${LLVM_NATIVE_TOOL_DIR}/llvm-tblgen" CACHE STRING "")
  set(CLANG_TABLEGEN "${LLVM_NATIVE_TOOL_DIR}/clang-tblgen" CACHE STRING "")
  set(LLDB_TABLEGEN_EXE "${LLVM_NATIVE_TOOL_DIR}/lldb-tblgen" CACHE STRING "")
endif()

# LLVM options.
set(LLVM_ENABLE_THREADS ON CACHE BOOL "")
set(LLVM_ENABLE_ZLIB OFF CACHE BOOL "")
set(LLVM_ENABLE_ZSTD OFF CACHE BOOL "")
set(LLVM_ENABLE_TERMINFO OFF CACHE BOOL "")
set(LLVM_ENABLE_LIBXML2 OFF CACHE BOOL "")
set(LLVM_ENABLE_LIBEDIT OFF CACHE BOOL "")
set(LLVM_ENABLE_CURL OFF CACHE BOOL "")
set(LLVM_ENABLE_HTTPLIB OFF CACHE BOOL "")
set(LLVM_ENABLE_FFI OFF CACHE BOOL "")
set(LLVM_INCLUDE_TESTS OFF CACHE BOOL "")
set(LLVM_INCLUDE_EXAMPLES OFF CACHE BOOL "")
set(LLVM_INCLUDE_BENCHMARKS OFF CACHE BOOL "")
set(LLVM_ENABLE_BINDINGS OFF CACHE BOOL "")
set(LLVM_ENABLE_OCAMLDOC OFF CACHE BOOL "")
set(LLVM_ENABLE_Z3_SOLVER OFF CACHE BOOL "")

# Don't build most LLVM/Clang standalone tools - they're not needed.
# Note: LLVM_BUILD_TOOLS/LLVM_INCLUDE_TOOLS must stay ON to include LLDB.
set(LLVM_BUILD_TOOLS OFF CACHE BOOL "")
set(CLANG_BUILD_TOOLS OFF CACHE BOOL "")

# LLDB options: disable all optional dependencies.
set(LLDB_ENABLE_PYTHON OFF CACHE BOOL "")
set(LLDB_ENABLE_LUA OFF CACHE BOOL "")
set(LLDB_ENABLE_CURSES OFF CACHE BOOL "")
set(LLDB_ENABLE_LIBEDIT OFF CACHE BOOL "")
set(LLDB_ENABLE_LZMA OFF CACHE BOOL "")
set(LLDB_ENABLE_LIBXML2 OFF CACHE BOOL "")
set(LLDB_ENABLE_TREESITTER OFF CACHE BOOL "")
set(LLDB_ENABLE_PROTOCOL_SERVERS OFF CACHE BOOL "")
set(LLDB_INCLUDE_TESTS OFF CACHE BOOL "")
set(LLDB_BUILD_FRAMEWORK OFF CACHE BOOL "")
set(LLDB_EXPORT_ALL_SYMBOLS ON CACHE BOOL "")

# Build only the lldb-wasm tool, not the standard CLI driver or server.
set(LLDB_TOOL_LLDB_BUILD OFF CACHE BOOL "")
set(LLDB_TOOL_LLDB_SERVER_BUILD OFF CACHE BOOL "")
set(LLDB_TOOL_LLDB_DAP_BUILD OFF CACHE BOOL "")

# Emscripten-specific compile/link flags.
# Pthreads require SharedArrayBuffer (COOP/COEP headers must be set by the server).
# -mtail-call: enable WebAssembly tail-call feature required by Clang's
#   bytecode interpreter (clangAST/Opcodes.inc uses musttail calls).
set(CMAKE_C_FLAGS "-pthread -mtail-call" CACHE STRING "")
set(CMAKE_CXX_FLAGS "-pthread -mtail-call" CACHE STRING "")
set(CMAKE_EXE_LINKER_FLAGS
  "-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864"
  CACHE STRING "")

# Static linking only - no dynamic libraries in wasm.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "")
