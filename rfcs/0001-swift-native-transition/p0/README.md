# P0 research corpus

Research for **P0 of the Swift-native transition**
([RFC 0001](../../0001-swift-native-transition.md) §7): toolchain, CI build
matrix, and the bun:ffi skeleton. Conducted 2026-06-11 against Bun 1.3.14,
Swift 6.3 (CI target) / 6.4-dev (local), macOS 27 arm64 and Linux arm64
(local apple/container). This corpus is repo documentation — like the RFC
itself it is never built or indexed by the docs site.

**Outcome: P0 is implementable as designed, with one architecture correction**
(Linux artifacts are runtime-set bundles, not static-stdlib dylibs — D-P0-1)
**and one hardened rule** (JSON never crosses the boundary on hot paths —
57× penalty on Linux, D-P0-11).

## Documents

| Doc | Contents |
| --- | --- |
| [toolchain.md](toolchain.md) | Version pin (6.3.x), swiftly, per-platform build strategy, the two Linux corrections (musl SDK; `--static-swift-stdlib`), bundle-size ladder |
| [ffi-bridge.md](ffi-bridge.md) | bun:ffi survey, **ABI contract v0** (normative), loader design, Node-API contingency |
| [benchmarks.md](benchmarks.md) | Methodology + measured numbers for E0–E3 and E6, derived rules for P1+ |
| [ci.md](ci.md) | Build matrix, caching, artifacts, quality gates, determinism exemption |
| [security.md](security.md) | Threat model: load-path policy, supply chain, memory boundary, signing (E7 findings) |
| [decisions.md](decisions.md) | D-P0-1 … D-P0-13, each with what decided it |
| [experiments/](experiments/) | The reproducible harness (SwiftPM probe + bench.js) behind every number |

## Experiments

| ID | Question | Verdict |
| --- | --- | --- |
| E0 | dlopen + first-call cost | 9.4 ms / 55 ms (macOS / Linux) → lazy load only |
| E1 | per-call overhead | 3.3 ns noop — calls are not the constraint |
| E2 | buffer-in compute | native 23–65× over JS 64-bit hashing, even at 64 B |
| E3 | buffer-out, ownership, JSON, leaks | ~0.5 µs + 0.08 ns/B round trip; copy-then-free leak-free over 1e6 iters; deallocator variant doesn't reclaim → rejected; JSON 7.7×/57× slower than pure JS |
| E5 | compiled-binary distribution | `dlopen` works directly on the embedded `$bunfs` path |
| E6 | Linux `.so` viability | static stdlib impossible for dylibs; `$ORIGIN` bundle works under `oven/bun` with zero Swift on host; 9.4/16/61 MB ladder; GLIBC_2.17 floor |
| E7 | Gatekeeper / signing | quarantine + signature flavor irrelevant under Bun's entitlements → loader path policy is the real control |

## The eight dimensions

| Dimension | Where P0 lands |
| --- | --- |
| **Performance** | 3.3 ns calls, 65× native compute wins (E1/E2); batching rule and lazy-dlopen rule (E0) derived from measurement, not taste (benchmarks.md §rules) |
| **Security** | Load-path allowlist as the primary control (E7 showed the OS won't gate us); corpus can never carry code; zero-dependency package = no `Package.resolved` attack surface (security.md) |
| **Reliability** | No-trap rule + in-band status (no aborts across the boundary, D-P0-4); kill switch defaults off with JS fallback; leak gate green over 1e6 round trips (E3); deterministic copy-then-free over GC hand-off (D-P0-3) |
| **Quality** | Every claim traces to a committed, re-runnable experiment; contract pinned by correctness asserts incl. error paths (experiments/) |
| **Coherency** | Loader mirrors the existing engine-probe idiom (`_resolveFontTextEngines`), config rides `config.js` coercions, errors map to `errors.js` taxonomy (ffi-bridge.md §3) |
| **Consistency** | Artifact naming, sha256 sidecars, runner choices, and cache shapes all extend existing CI conventions (ci.md); same ABI on both OSes, verified by the same suite |
| **Effectiveness** | One contract serves P1–P6; bridge-agnostic ABI keeps the Node-API pivot at ~150 lines of C shim (ffi-bridge.md §4); E6 recipe is the CI recipe; E5 makes standalone-binary distribution a non-feature (embed + dlopen, zero extra code) |
| **Lightweightness** | 65 KB macOS dylib; 9.4 MB Linux bundle for the P1 shape; probe has zero dependencies; harness is 2 source files; JSON/Foundation weight measured and fenced out of hot paths |

## P0 exit gates (green-light conditions for implementing P0 proper)

1. ☑ Dylib builds and `ad_abi_version` round-trips on macOS arm64 and Linux
   arm64 (container recipe documented and reproducible; CI recipe for all
   three runner targets written in ci.md).
2. ☑ Boundary costs measured; batching rule derived (< 5 % boundary share at
   the module's typical payload — see benchmarks.md).
3. ☑ RSS flat over 1e6 alloc/copy/free round trips (macOS and Linux).
4. ☑ Compiled-binary distribution answered (E5: embed + dlopen `$bunfs`) and
   signing policy set (E7/D-P0-10).
5. ☑ RFC 0001 corrected (musl SDK demoted to P7; runtime-set bundles;
   6.3.x pin — see the RFC's §5 and decision log).
6. ☐ Loader + `swift/` package implemented per ffi-bridge.md §2–3, with the
   A/B parity rig wired into `bun run ci` — **this is P0-implementation
   itself**, the only box this research leaves open.
