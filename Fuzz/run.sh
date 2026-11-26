#!/usr/bin/env bash
# Build one libFuzzer harness with ASan and run it: Fuzz/run.sh <Target> [seconds] [extra libFuzzer flags...]
# Requires a toolchain with libFuzzer (swift.org Linux toolchains). Corpus: Fuzz/Corpus/<Target> (seeds are
# committed; new interesting inputs are kept locally). Crashes: Fuzz/Artifacts/<Target>/.
set -euo pipefail
target="${1:?usage: Fuzz/run.sh <Target> [seconds]}"
seconds="${2:-60}"
shift $(( $# >= 2 ? 2 : 1 ))
here="$(cd "$(dirname "$0")" && pwd)"
swift_cmd="${SWIFT:-swift}"
# Swift modules: ASan + libFuzzer-compatible coverage (inline 8-bit counters + PC table); C modules (vendored
# zstd, SQLite shim): clang's fuzzer-no-link instrumentation. Separate scratch path so flags never mix.
flags=(-c release --scratch-path "$here/.build/fuzz"
    -Xswiftc -sanitize=address -Xswiftc -sanitize-coverage=edge,inline-8bit-counters,pc-table,trace-cmp
    -Xcc -fsanitize=address -Xcc -fsanitize=fuzzer-no-link)
APPLE_DOCS_FUZZ=1 $swift_cmd build --package-path "$here" "${flags[@]}" --product "$target" >&2
bin="$(APPLE_DOCS_FUZZ=1 $swift_cmd build --package-path "$here" "${flags[@]}" --show-bin-path)/$target"
mkdir -p "$here/Corpus/$target" "$here/Artifacts/$target" "$here/.work/$target"
# No external symbolizer is needed (and a missing one must not kill the run); findings are re-run to symbolize.
export ASAN_OPTIONS="${ASAN_OPTIONS:-symbolize=0:detect_leaks=1}"
exec "$bin" -max_total_time="$seconds" -max_len=65536 -rss_limit_mb=2048 -timeout=10 -print_funcs=0 \
    -artifact_prefix="$here/Artifacts/$target/" "$here/.work/$target" "$here/Corpus/$target" "$@"
