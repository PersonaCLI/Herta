#!/usr/bin/env bash
# Rebuild the 3D device card's Basis Universal transcoder — CSP-safe.
#
# WHY (ADR 0057 §3)
#
# three ships examples/jsm/libs/basis/basis_transcoder.js as an embind build with
# DYNAMIC_EXECUTION=1: it compiles its invoker functions with the Function
# constructor, which the packaged CSP (`script-src 'self' 'wasm-unsafe-eval'`,
# csp.ts) refuses inside the transcoder's worker — and three's WorkerPool has no
# error path, so the atlas load then never settles (scene.ts bounds it).
# Rebuilding upstream with -sDYNAMIC_EXECUTION=0 makes embind emit plain
# closures: same API, byte-identical transcode results (three.js#34389).
#
# USAGE: packages/gui/scripts/rebuild-basis-transcoder.sh [scratch-dir]
# Default scratch: <repo>/.herta/basis-build (gitignored). Needs git, python3,
# cmake, make and network — emsdk installs itself into the scratch dir.
set -euo pipefail

EMSDK_VERSION="6.0.8"
BASIS_TAG="v1_50_0_2"
# emscripten 6.0.8's own default INCOMING_MODULE_JS_API list (src/settings.js)
# PLUS wasmBinary: the default list dropped it, and KTX2Loader hands the
# transcoder its wasm through `Module.wasmBinary` inside a blob: worker — without
# the keyword the glue ignores it and tries to fetch basis_transcoder.wasm
# relative to the blob: URL, and every worker dies.
INCOMING_API="ENVIRONMENT,arguments,canvas,dynamicLibraries,elementPointerLock,instantiateWasm,locateFile,monitorRunDependencies,noExitRuntime,noInitialRun,onAbort,onExit,onRuntimeInitialized,postRun,preInit,preRun,print,printErr,setStatus,statusMessage,stderr,stdin,stdout,thisProgram,wasm,websocket,wasmBinary"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$GUI/../.." && pwd)"
SCRATCH="${1:-$REPO/.herta/basis-build}"
OUT="$GUI/src/renderer/public/device-scene/basis"

mkdir -p "$SCRATCH"
cd "$SCRATCH"

if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
fi
(cd emsdk && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
# shellcheck disable=SC1091
set +u
source "$SCRATCH/emsdk/emsdk_env.sh"
set -u

if [ ! -d basis_universal ]; then
  git clone --depth 1 --branch "$BASIS_TAG" \
    https://github.com/BinomialLLC/basis_universal.git
fi

cd basis_universal/webgl/transcoder
# Three edits to the scratch checkout of upstream's CMakeLists, all idempotent:
#   * C++17 — upstream sets 11, but the embind headers of current emscripten
#     refuse anything below 17 outright ("embind requires -std=c++17");
#   * the three flags this build exists for, appended to the LINK_FLAGS line
#     rather than replacing the shipped set (KTX2 + Zstandard stay on: the
#     card's space-v1 atlases are zstd-supercompressed UASTC/HDR).
if ! grep -q "DYNAMIC_EXECUTION=0" CMakeLists.txt ||
  ! grep -q "CMAKE_CXX_STANDARD 17" CMakeLists.txt; then
  python3 - "$INCOMING_API" <<'PY'
import pathlib, sys

extra = (
    " -s DYNAMIC_EXECUTION=0 -s EXPORTED_RUNTIME_METHODS=HEAP8"
    " -s INCOMING_MODULE_JS_API=" + sys.argv[1] + " "
)
p = pathlib.Path("CMakeLists.txt")
t = p.read_text()
t = t.replace("set(CMAKE_CXX_STANDARD 11)", "set(CMAKE_CXX_STANDARD 17)")
needle = "-s EXPORT_NAME=BASIS "
if needle not in t:
    raise SystemExit("LINK_FLAGS line not found — upstream layout changed")
if "DYNAMIC_EXECUTION=0" not in t:
    t = t.replace(needle, needle + extra, 1)
p.write_text(t)
PY
fi

# CMAKE_POLICY_VERSION_MINIMUM: upstream's CMakeLists still says
# `cmake_minimum_required(VERSION 3.0)`, which CMake >= 4 refuses outright.
rm -rf build
emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build -j"$(nproc)"

BUILT_JS="build/basis_transcoder.js"
BUILT_WASM="build/basis_transcoder.wasm"

# The three properties KTX2Loader needs, checked before anything is adopted.
grep -q "newFunc(Function" "$BUILT_JS" && {
  echo "refusing: the build still generates functions with the Function constructor" >&2
  exit 1
}
grep -q "new Function(" "$BUILT_JS" && {
  echo "refusing: the build still contains a string eval" >&2
  exit 1
}
grep -qE 'Module\[?"wasmBinary"\]?' "$BUILT_JS" || {
  echo "refusing: the glue ignores Module.wasmBinary (KTX2Loader passes it in)" >&2
  exit 1
}
head -c 400 "$BUILT_JS" | grep -q "var BASIS" || {
  echo "refusing: MODULARIZE/EXPORT_NAME wrapper is gone" >&2
  exit 1
}

cp "$BUILT_JS" "$OUT/basis_transcoder.js"
cp "$BUILT_WASM" "$OUT/basis_transcoder.wasm"

echo "rebuilt from basis_universal $BASIS_TAG with emsdk $EMSDK_VERSION"
md5sum "$OUT/basis_transcoder.js" "$OUT/basis_transcoder.wasm"
ls -l "$OUT/basis_transcoder.js" "$OUT/basis_transcoder.wasm"
