# P0 probe experiments

A minimal, reproducible harness for the P0 research findings
([`../README.md`](../README.md)). One zero-dependency SwiftPM dynamic library
([`swift/`](swift/)) implements ABI contract v0
([`../ffi-bridge.md`](../ffi-bridge.md)); one Bun script ([`bench.js`](bench.js))
validates the contract end to end and measures the `bun:ffi` boundary
(experiments E0–E3, results in [`../benchmarks.md`](../benchmarks.md)).

This directory is research tooling, not product code. Nothing in here ships,
and nothing under `src/` depends on it.

## Run (macOS)

```bash
cd swift && swift build -c release && cd ..
bun bench.js              # full run (~2–3 min)
AD_P0_QUICK=1 bun bench.js  # smoke run (seconds, indicative numbers only)
```

Requires Xcode 26+ (Swift 6.3+) and Bun 1.3+. `AD_P0_LIB=/path/to/lib`
overrides the dylib path.

The run is: correctness asserts (ABI round-trips, no-trap error paths) →
time-budgeted benchmarks (iterations auto-calibrated per measurement) → leak
gate (RSS flat across 1e6 alloc/copy/free round trips) → the
`toArrayBuffer`-deallocator ownership variant, executed in a subprocess
because a wrong assumption about Bun's deallocator argument order must not be
able to corrupt the main run.

## Run (Linux, experiment E6 — local container, never CI)

E6's headline finding: `--static-swift-stdlib` is **not honored for
shared-library products** (hard link error with Foundation imported — the
driver adds the static archives without their search path — and a silent
no-op once `-L/usr/lib/swift_static/linux` is supplied, and for stdlib-only
builds). The working model is a plain dynamic build with an `$ORIGIN` rpath
plus the Swift runtime `.so` set staged next to the library — see
[`../toolchain.md`](../toolchain.md).

```bash
# Build stage — the Swift project's official image, rpath = $ORIGIN:
container run --rm -v "$PWD:/work" -w /work/swift docker.io/library/swift:6.3 bash -lc '
  swift build -c release -Xlinker -rpath -Xlinker "\$ORIGIN" &&
  mkdir -p /work/dist-native && cp .build/release/libP0Probe.so /work/dist-native/ &&
  cd /work/dist-native &&
  for dep in $(ldd libP0Probe.so | awk "/\/usr\/lib\/swift\/linux/ {print \$3}"); do cp "$dep" .; done &&
  strip --strip-unneeded *.so;
  du -ch *.so | tail -1;
  objdump -T libP0Probe.so | grep -o "GLIBC_[0-9.]*" | sort -Vu | tail -1'

# Run stage — Bun image, no Swift toolchain anywhere:
container run --rm -v "$PWD:/work" -w /work -e AD_P0_LIB=/work/dist-native/libP0Probe.so \
  docker.io/oven/bun:1.3 bun bench.js
```

A stdlib-only variant (`-Xswiftc -DP0_NO_FOUNDATION`) stubs
`ad_json_roundtrip` (bench.js detects it and skips the JSON legs) and shrinks
the staged runtime set from 61 MB to 9.4 MB — measured numbers in
[`../benchmarks.md`](../benchmarks.md).

Notes: `apple/container` build contexts must live under `/Users`, and the CLI
talks XPC (fails under sandboxed shells). The container build writes into the
same `swift/.build/` a macOS build uses, so work from a copy of this
directory if you want both artifacts around.

## Files

| File | Purpose |
| --- | --- |
| `swift/Package.swift` | Dynamic-library product, zero dependencies, tools 6.1 |
| `swift/Sources/P0Probe/probe.swift` | `@_cdecl` exports implementing contract v0: `ad_abi_version`, `ad_build_info`, `ad_noop`, `ad_add`, `ad_fnv1a`, `ad_echo`, `ad_json_roundtrip`, `ad_get_dealloc_fn`, `ad_free` |
| `bench.js` | Correctness asserts + calibrated benchmarks + leak gate + dealloc probe |
