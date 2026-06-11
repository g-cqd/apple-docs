# P0 boundary benchmarks

Measured costs of the bun:ffi boundary under ABI contract v0
([`ffi-bridge.md`](ffi-bridge.md)), produced by
[`experiments/bench.js`](experiments/bench.js). The numbers exist to answer
one question: *where is the break-even line that P1+ modules must clear?*

## Methodology

- **Machine**: Mac (Apple Silicon, arm64), macOS 27.0. Treat absolute numbers
  as this-machine-only; the *ratios* are what transfer.
- **Versions**: Bun 1.3.14; probe built with Swift 6.4-dev (Xcode 27 beta),
  `swift build -c release`. CI will pin 6.3.x (D-P0-2); spot-checking the
  probe under both showed no behavioral difference.
- **Rig**: per measurement, iterations are auto-calibrated from a 250 ms
  per-batch budget (32-call probe), then 20 batches run; the table reports
  mean / p50 / p95 of per-op time across batches. `AD_P0_QUICK=1` shrinks
  budgets for smoke runs and is never used for recorded numbers.
- **Caveats**: (a) the JS FNV-1a baseline is the fastest plain-`Number`
  64-bit formulation we found (two u32 halves, sparse-prime decomposition) —
  representative of "JS forced to do 64-bit integer work", not of all JS
  hashing; (b) FFI `u64` returns include the BigInt conversion cost —
  deliberately, because callers pay it; (c) `js add baseline` is JIT-inlined
  and serves only as the floor.

## E0 — cold load (per process)

| Step | Cost |
| --- | --- |
| `dlopen` (Swift runtime + Foundation init) | **9.4 ms** |
| First symbol call after load | 5.9 µs |
| Every subsequent call | see E1 |

Implication: load lazily and only when `APPLE_DOCS_NATIVE` enables a module;
a CLI invocation that never touches native code must not pay the 9 ms.

## E1 — raw call overhead

| Measurement | mean | p50 | p95 |
| --- | --- | --- | --- |
| ffi `ad_noop()` | 3.3 ns | 3.2 ns | 3.4 ns |
| ffi `ad_add(i32,i32)` | 10.1 ns | 9.7 ns | 12.5 ns |
| js add (inlined floor) | 0.3 ns | 0.3 ns | 0.4 ns |

The JIT-compiled trampolines deliver on Bun's claim: a no-arg native call is
~3 ns, scalar marshalling adds ~7 ns. FFI call count is **not** the design
constraint at these costs — payload copies are.

## E2 — buffer-in compute (the P1 hashing workload)

| Size | ffi fnv1a (mean) | js fnv1a (mean) | native advantage |
| --- | --- | --- | --- |
| 64 B | 113.7 ns | 2.62 µs | 23× |
| 4 KB | 5.15 µs | 306.6 µs | 60× |
| 64 KB | 81.5 µs | 5.20 ms | 64× |
| 1 MB | 1.33 ms | 86.1 ms | 65× |

Native wins even at 64 B — the boundary cost (~110 ns incl. BigInt return)
is already smaller than the JS implementation of the same 64-bit math.

## E3 — buffer-out round trip (alloc → header parse → copy → free)

| Size | round trip (mean) | p95 |
| --- | --- | --- |
| 64 B | 476 ns | 658 ns |
| 4 KB | 1.17 µs | 1.76 µs |
| 64 KB | 10.7 µs | 11.9 µs |
| 1 MB | 87.2 µs | 89.5 µs |

Model: **~0.5 µs fixed + ~0.08 ns/byte** (one malloc+memcpy native-side, one
copy JS-side, one free). Text extraction paths are equivalent — pick by type,
not speed: `toArrayBuffer`+`TextDecoder` 976 ns vs `CString` clone 944 ns at
4 KB.

**JSON across the boundary** (stringify → ffi parse+re-serialize → parse,
vs the same stringify+parse in pure JS):

| Size | ffi round trip | js round trip | penalty |
| --- | --- | --- | --- |
| ~4 KB | 94.0 µs | 12.2 µs | 7.7× |
| ~64 KB | 1.55 ms | 201 µs | 7.7× |

Double serialization dominates → JSON is for cold paths only (D-P0-11). Hot
paths use binary payloads.

**Leak gate**: RSS over 1,000,000 × 4 KB alloc/copy/free round trips:
1942.0 MB → 1915.5 MB (Δ −1.4 %). Copy-then-free is leak-free at the
contract level.

**Ownership variant (dealloc probe, subprocess)**: handing buffers to the GC
via `toArrayBuffer`'s deallocator survived but reclaimed nothing under
`Bun.gc(true)` — RSS +50 MB over only 10 k hand-offs. Rejected (D-P0-3).

## E6 — Linux (glibc, arm64, local apple/container)

Environment: `swift:6.3` image (build) → `oven/bun:1.3` image (run, **no
Swift toolchain present**), linux/arm64 VM. Bundle: `.so` with rpath
`$ORIGIN` + stripped runtime set ([`toolchain.md`](toolchain.md), D-P0-1).
All correctness asserts pass, leak gate passes (RSS shrank), dealloc probe
reproduces the macOS verdict (survives, doesn't reclaim).

**Link findings** (the reason this experiment existed):

- `--static-swift-stdlib` + Foundation import → **link error** (`ld.gold:
  cannot find -lCoreFoundation / -l_FoundationCShims / …`): the driver adds
  the static archives without adding `/usr/lib/swift_static/linux` to the
  search path.
- With `-Xlinker -L/usr/lib/swift_static/linux`, or stdlib-only → builds,
  but the flag is a **silent no-op**: ~100 KB `.so`, full dynamic runtime
  set in `ldd`. Static runtime embedding is executable-only today.
- Working model: plain dynamic build + staged runtime set. Stripped bundle
  sizes: **9.4 MB** stdlib-only · **16 MB** + FoundationEssentials ·
  **61 MB** + full Foundation (ICU). Probe `.so` itself: 68 KB stripped.
  glibc floor: **GLIBC_2.17**. Zero `not found` in `ldd` on the Bun image.

**Numbers** (same rig, same day):

| Measurement | linux-arm64 | darwin-arm64 (ref) |
| --- | --- | --- |
| E0 dlopen | **55.4 ms** | 9.4 ms |
| E0 first call | 1.0 µs | 5.9 µs |
| E1 ffi `ad_noop()` | 3.6 ns | 3.3 ns |
| E1 ffi `ad_add` | 25.4 ns | 10.1 ns |
| E2 ffi fnv1a 4 KB | 5.13 µs | 5.15 µs |
| E2 js fnv1a 4 KB | 206.9 µs | 306.6 µs |
| E3 echo round-trip 4 KB | 908 ns | 1.17 µs |
| E3 echo round-trip 1 MB | 209.7 µs | 87.2 µs |
| E3 json ffi ~4 KB | **666.8 µs** | 94.0 µs |
| E3 json js ~4 KB | 11.7 µs | 12.2 µs |

Reading: call overhead and native compute transfer essentially unchanged
(the trampolines and the Swift codegen behave identically); the VM's memory
subsystem shows in the 1 MB copies; dlopen pays ~6× for resolving the
runtime set (lazy loading matters even more on Linux). The standout is
**JSON: 57× slower than pure JS on Linux** (vs 7.7× on macOS) —
swift-corelibs/swift-foundation `JSONSerialization` is far slower than
Darwin's. This hardens D-P0-11 into a rule, not a preference.

## Derived rules for P1+

1. **Batch by payload, not by call.** With 3–10 ns calls and ~0.5 µs per
   buffer round trip, a native function must either do ≥ ~1 µs of real work
   per call (E2: 64-byte hashing already qualifies) or be called with batched
   inputs. Rule of thumb adopted as the P0 exit gate: *boundary cost must
   stay < 5 % of total time at the module's typical payload* — for transforms
   that emit ≈ what they consume, that means ≥ ~4 KB per crossing or
   compute-bound work native-side.
2. **Binary payloads on hot paths; JSON only where a human would not notice
   7.7× (macOS) / 57× (Linux)** — startup, admin, one-shot CLI paths.
3. **Copy-then-free, always.** The deterministic copy costs less than 0.1
   ns/byte and removes the entire native-lifetime class of bugs.
4. **Lazy dlopen.** 9.4 ms (macOS) / 55 ms (Linux runtime-set resolution) is
   invisible behind a server boot, unacceptable as a tax on a 50 ms CLI
   invocation that never calls native code.
