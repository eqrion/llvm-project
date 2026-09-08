#!/usr/bin/env bash

# Build the native tablegen tools and the lldb-wasm artifact in a fresh,
# predictable CI environment. EMSDK must point at an activated Emscripten SDK.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/../../../.." && pwd)
build_native="${repo_root}/build-native"
build_wasm="${repo_root}/build-wasm"
build_libxml2="${repo_root}/build-libxml2"
libxml2_source="${repo_root}/libxml2-src"
libxml2_archive="${repo_root}/libxml2-2.12.9.tar.xz"
jobs=${LLVM_WASM_BUILD_JOBS:-$(nproc)}

: "${EMSDK:?EMSDK must point at an activated Emscripten SDK}"

emcmake="${EMSDK}/upstream/emscripten/emcmake"
if [[ ! -x "${emcmake}" ]]; then
  echo "Emscripten's emcmake was not found at ${emcmake}" >&2
  exit 1
fi

cmake -S "${repo_root}/llvm" -B "${build_native}" -G Ninja \
  -DLLVM_ENABLE_PROJECTS="clang;lldb" \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF
cmake --build "${build_native}" \
  --target llvm-tblgen clang-tblgen lldb-tblgen --parallel "${jobs}"

curl --fail --location --retry 3 \
  --output "${libxml2_archive}" \
  https://download.gnome.org/sources/libxml2/2.12/libxml2-2.12.9.tar.xz
echo "59912db536ab56a3996489ea0299768c7bcffe57169f0235e7f962a91f483590  ${libxml2_archive}" \
  | sha256sum --check --strict
mkdir -p "${libxml2_source}"
tar xJf "${libxml2_archive}" -C "${libxml2_source}" --strip-components=1

"${emcmake}" cmake -S "${libxml2_source}" -B "${build_libxml2}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DLIBXML2_WITH_PYTHON=OFF \
  -DLIBXML2_WITH_ZLIB=OFF \
  -DLIBXML2_WITH_LZMA=OFF \
  -DLIBXML2_WITH_ICONV=OFF \
  -DLIBXML2_WITH_HTTP=OFF \
  -DLIBXML2_WITH_FTP=OFF \
  -DLIBXML2_WITH_TESTS=OFF \
  -DLIBXML2_WITH_PROGRAMS=OFF \
  -DLIBXML2_WITH_MODULES=OFF \
  -DLIBXML2_WITH_CATALOG=OFF \
  -DCMAKE_INSTALL_PREFIX="${build_libxml2}/install"
cmake --build "${build_libxml2}" --target install --parallel "${jobs}"

"${emcmake}" cmake -S "${repo_root}/llvm" -B "${build_wasm}" -G Ninja \
  -C "${repo_root}/lldb/cmake/caches/Emscripten.cmake" \
  -DLLVM_NATIVE_TOOL_DIR="${build_native}/bin"
cmake --build "${build_wasm}" --target lldb-wasm --parallel "${jobs}"

