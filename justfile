root := justfile_directory()
build_native := root / "build-native"
build_wasm := root / "build-wasm"
build_libxml2 := root / "build-libxml2"
libxml2_version := "2.12.9"
emsdk := env("EMSDK", env("HOME") + "/src/emsdk")
emcmake := emsdk + "/upstream/emscripten/emcmake"
pkg := root / "lldb/tools/lldb-wasm"

# Build libxml2 for wasm (required by LLDB's gdb-remote module/register loading).
# Downloads the source and cross-compiles a minimal static lib with Emscripten.
build-libxml2:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f {{build_libxml2}}/install/lib/libxml2.a ]; then
        echo "libxml2 already built"; exit 0
    fi
    mkdir -p {{root}}/libxml2-src
    curl -sL "https://download.gnome.org/sources/libxml2/2.12/libxml2-{{libxml2_version}}.tar.xz" \
        | tar xJ -C {{root}}/libxml2-src --strip-components=1
    {{emcmake}} cmake -S {{root}}/libxml2-src -B {{build_libxml2}} \
        -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_LZMA=OFF \
        -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_FTP=OFF \
        -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_PROGRAMS=OFF \
        -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_CATALOG=OFF \
        -DCMAKE_INSTALL_PREFIX={{build_libxml2}}/install
    cmake --build {{build_libxml2}} --target install -- -j$(nproc 2>/dev/null || sysctl -n hw.logicalcpu)

# Build native tblgen tools required for cross-compilation (one-time setup).
build-native:
    cmake -S {{root}}/llvm -B {{build_native}} \
        -DLLVM_ENABLE_PROJECTS="clang;lldb" \
        -DLLVM_TARGETS_TO_BUILD=WebAssembly \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_ENABLE_ASSERTIONS=OFF \
        -DLLVM_INCLUDE_TESTS=OFF \
        -DLLVM_INCLUDE_EXAMPLES=OFF \
        -DLLVM_INCLUDE_BENCHMARKS=OFF
    cmake --build {{build_native}} \
        --target llvm-tblgen clang-tblgen lldb-tblgen \
        -- -j$(nproc 2>/dev/null || sysctl -n hw.logicalcpu)

# Configure the wasm build (re-run after changing cmake files or cache).
configure-wasm: build-libxml2
    {{emcmake}} cmake -S {{root}}/llvm -B {{build_wasm}} \
        -C {{root}}/lldb/cmake/caches/Emscripten.cmake \
        -DLLVM_NATIVE_TOOL_DIR={{build_native}}/bin

# Build the lldb-wasm target.
build-wasm:
    cmake --build {{build_wasm}} \
        --target lldb-wasm \
        -- -j$(nproc 2>/dev/null || sysctl -n hw.logicalcpu)

# Full workflow: native tools -> libxml2 -> configure -> build.
build-all: build-native build-libxml2 configure-wasm build-wasm

# Reconfigure and rebuild wasm (keeps native tools).
rebuild-wasm: configure-wasm build-wasm

# Install npm dependencies for the lldb-wasm package.
npm-install:
    cd {{pkg}} && npm install

# Build the npm package (copy wasm artifacts + compile TypeScript).
npm-build: build-wasm
    cd {{pkg}} && npm run build

# Run the test suite (builds first).
test: npm-build
    cd {{pkg}} && npx vitest run --reporter=verbose

# Pack the npm package into a tarball (for local testing with npm install).
npm-pack: npm-build
    cd {{pkg}} && npm pack

# Remove the wasm build directory.
clean-wasm:
    rm -rf {{build_wasm}}

# Remove everything.
clean-all:
    rm -rf {{build_native}} {{build_wasm}} {{build_libxml2}} {{root}}/libxml2-src

# Run the demo dev server (serves with COOP/COEP headers for SharedArrayBuffer).
# Requires `just npm-build` first.
demo port="8000": npm-build
    node {{pkg}}/demo/server.mjs {{port}}

# Show the output wasm artifact paths.
artifacts:
    @ls -lh {{build_wasm}}/bin/lldb-wasm.* 2>/dev/null || echo "No artifacts yet - run build-wasm first"
