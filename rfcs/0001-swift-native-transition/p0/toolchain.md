# Toolchain: versions, managers, per-platform build strategy

Research date: 2026-06-11. Sources: swift.org install/SDK docs, swiftlang
release announcements, local verification (Xcode 27 beta), experiment E6.

## Version landscape and the pin

| Channel | Version | Status (June 2026) |
| --- | --- | --- |
| Stable | **Swift 6.3.2** | Released 2026-03-24; what swiftly installs by default |
| In release | Swift 6.4 | Branched 2026-05-04, ships ~Sept 2026 with Xcode 27 GA |
| Local dev | 6.4-dev (Xcode 27.0 beta) | What this research ran on macOS |

**Pin: Swift 6.3.x for CI and artifacts (D-P0-2).** Rationale: artifacts that
ship must come from a stable, reproducibly installable toolchain; the probe
compiled identically under 6.3-image and 6.4-dev, so developer machines may
run ahead of the pin. Mechanics: a `.swift-version` file at the Swift package
root (swiftly reads it natively), bumped by PR like any dependency.
Language mode: Swift 6 (strict concurrency) from day one — retrofitting it
later is the expensive direction. `swift-tools-version: 6.1` keeps the
manifest readable by both pinned and dev toolchains.

## Toolchain managers

- **macOS dev**: Xcode's bundled toolchain is fine (it tracks ≥ the pin).
  swiftly optional.
- **Linux + CI**: **swiftly 1.x** — the official installer
  (`swift.org/install/linux/swiftly/`). In GitHub Actions either
  `vapor/swiftly-action@v0.2` or `swift-actions/setup-swift@v3` (now
  swiftly-based; v3 in beta) — final choice is a P0-implementation detail;
  both honor `.swift-version`. Gotcha for hand-rolled steps: swiftly's env
  setup must be sourced into `$GITHUB_ENV`/`$GITHUB_PATH` because each step
  is a fresh shell.

## Per-platform dylib strategy

### macOS (arm64 now; x86_64 when CI warrants it)

`swift build -c release` produces `libP0Probe.dylib` with **no embedded
runtime** — Swift's ABI-stable runtime ships in the OS (`/usr/lib/swift`).
The arm64 linker ad-hoc signs automatically (E7). Probe artifact: **65 KB**.
Universal (arm64+x86_64) binaries via `lipo` of two builds remain possible
but are deferred: the bun-binary matrix today ships arm64-only for darwin,
and the dylib matrix should mirror the binary matrix (see [`ci.md`](ci.md)).

### Linux: the musl correction (supersedes RFC 0001 §5 as written)

The RFC assumed the **Static Linux SDK (musl)** would cross-compile the
Linux artifacts from macOS. That is wrong for dylibs: the static SDK
supports **no dynamic linking whatsoever** — it cannot emit a `.so`, and
`dlopen` is unavailable under it (swift.org, "Getting Started with the
Static Linux SDK"). Mixing a musl-linked `.so` into glibc Bun would be
unsound even if it could. The SDK remains exactly right for **P7's single
static executable**, where it eliminates the distro-compatibility problem.

**Second correction, from E6: `--static-swift-stdlib` is not honored for
shared-library products either.** Measured on `swift:6.3` (linux/arm64):
with Foundation imported, the link *fails* (`ld.gold: cannot find
-lCoreFoundation/-l_FoundationCShims/…` — the driver adds the static
archives without adding `/usr/lib/swift_static/linux` to the search path);
with the `-L` supplied manually, or for a stdlib-only build, the flag becomes
a silent no-op — the `.so` comes out ~100 KB with the full dynamic runtime
dependency set (`ldd`: libswiftCore, _Concurrency, _StringProcessing,
_RegexParser, swiftGlibc, dispatch, BlocksRuntime, … + Foundation stack +
`lib_FoundationICU` when Foundation is used). Static runtime embedding is an
executable-product feature today.

For P0–P6 the Linux dylib path is therefore (D-P0-1):

- **Build natively on Linux** with the glibc toolchain, plain
  `swift build -c release`, linking with `-Xlinker -rpath -Xlinker '$ORIGIN'`.
- **Ship the Swift runtime `.so` set next to the library** (copy the
  `/usr/lib/swift/linux` entries `ldd` reports, `strip --strip-unneeded`).
  The `$ORIGIN` rpath makes the bundle self-contained: target hosts need
  **no Swift installation**. Measured (E6, stripped): **9.4 MB** stdlib-only
  (the P1 shape) · **16 MB** with `FoundationEssentials` (the realistic P2+
  shape — no ICU) · **61 MB** with the full `Foundation` umbrella
  (`lib_FoundationICU` dominates). Artifact = one `.tar.zst` of the
  directory per `<os>-<arch>`.
- CI runners: `ubuntu-latest` (x64) and `ubuntu-24.04-arm` (arm64, free for
  public repos since 2025).
- **glibc floor**: `objdump -T` on the E6 artifact reports **GLIBC_2.17**
  max — comfortably below any supported distro; record the floor per
  artifact in CI.
- Verified end to end in E6 (local apple/container): the staged bundle ran
  the full correctness + benchmark suite under `oven/bun:1.3` (no Swift in
  the image) on linux/arm64 — numbers in [`benchmarks.md`](benchmarks.md).
- Keep Foundation out of P1 modules entirely (9.4 MB set, fastest cold
  load). When Foundation becomes unavoidable (P2+), target
  `FoundationEssentials` — verified to drop ICU/Internationalization from
  the set (16 MB vs 61 MB). Caveat discovered in E6: Essentials does **not**
  export legacy `JSONSerialization` (Codable/`JSONEncoder` only), and its
  `WritingOptions` differ — plan JSON handling on Codable or our own
  serializer. The probe's full-Foundation `JSONSerialization` leg measured
  ~7× slower on Linux than macOS for the same payloads
  ([`benchmarks.md`](benchmarks.md) E6) — one more reason JSON stays off hot
  paths (D-P0-11).

### Cross-compilation from macOS (appendix, not the plan)

`apple/swift-sdk-generator` can produce glibc-targeting Linux SDKs usable
from macOS (`swift build --swift-sdk <id>`), and it satisfies the dependency
policy (apple org). Useful as a *developer convenience* for quick Linux
syntax/link checks without a container. Not used for shipped artifacts:
native runners are simpler, exercise the real linker/libc, and run the tests
on the real platform in the same job.

### Windows (explicitly later)

Unchanged from RFC 0001: a later phase. swiftly does not support Windows;
`SwiftyLab/setup-swift` and the official Windows toolchain exist when needed.

## Local container recipe (E6, reproducible)

See [`experiments/README.md`](experiments/README.md) for the exact
`container run` commands (build in `docker.io/library/swift:6.3`, inspect,
then bench in `oven/bun:1.3` with no Swift toolchain present). apple/container
quirks that cost time before: build contexts must live under `/Users`, and
the CLI talks XPC (fails under sandboxed shells).
