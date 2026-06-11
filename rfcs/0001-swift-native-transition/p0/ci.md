# CI design for the native build matrix

How `libAppleDocsCore` gets built, tested, and shipped once P0 proper is
green-lit. Designed against the existing workflows
(`.github/workflows/ci.yml`, `snapshot.yml`) so the native lane is an
extension, not a parallel system. Nothing here is implemented yet.

## Build matrix

Mirrors the existing bun-binary matrix (snapshot.yml `build-binaries`), plus
the arm64 Linux runner that became free for public repos:

| Runner | Artifact | Build |
| --- | --- | --- |
| `macos-26` | `apple-docs-native-darwin-arm64.tar.zst` (the dylib alone — Swift runtime ships in the OS) | `swift build -c release` |
| `ubuntu-latest` | `apple-docs-native-linux-x64.tar.zst` (`.so` + stripped Swift runtime set, rpath `$ORIGIN`) | `swift build -c release -Xlinker -rpath -Xlinker '$ORIGIN'` + stage `ldd`-listed `/usr/lib/swift/linux` libs |
| `ubuntu-24.04-arm` | `apple-docs-native-linux-arm64.tar.zst` (same bundle shape) | same |

The Linux staging step is exactly the E6 recipe
([`experiments/README.md`](experiments/README.md)); `--static-swift-stdlib`
does not work for shared-library products (D-P0-1). Bundle weight: 9.4 MB
(stdlib-only, P1) → 16 MB (FoundationEssentials) → 61 MB (full Foundation),
stripped.

Notes:

- `macos-26` (not `macos-latest`) for the canonical darwin build — same
  explicit-runner convention the snapshot job already uses. darwin-x64 stays
  out of the matrix until the bun-binary matrix grows it (the artifact set
  should never promise more platforms than the binaries do).
- Toolchain via swiftly honoring `.swift-version`
  ([`toolchain.md`](toolchain.md)); macOS runners may use the Xcode
  toolchain when it satisfies the pin.
- Artifact naming follows the existing `dist/apple-docs-<os>-<arch>`
  convention; each artifact gets a `.sha256` sidecar exactly like the
  binaries.

## Quality gates (extend `ci.yml`, same job philosophy)

| Gate | Tool | Parallel to |
| --- | --- | --- |
| Format | `swift format lint --strict` (bundled in 6.x toolchains) | biome |
| Tests | `swift test` — swift-testing, bundled | `bun test` |
| Build proof | release build on all three targets | typecheck |
| Boundary proof | the bench harness's correctness phase against the built artifact (asserts only, no timing) | leak-guard tests |

Caching: `actions/cache` on `~/.swiftpm` + `.build` keyed
`swift-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('swift/Package.swift', 'swift/Package.resolved', 'swift/.swift-version') }}`
— same shape as the existing bun cache key on `bun.lock`. While the package
has zero dependencies (P0–P1), `Package.resolved` is absent/empty and the
cache mostly accelerates incremental module builds.

## Release attachment

The `build-binaries` job in `snapshot.yml` gains the native artifacts (same
`softprops/action-gh-release` upload to the same tag). Compiled binaries
*embed* the dylib (E5/D-P0-9) — on Linux that means embedding the bundled
runtime set too, or accepting JS fallback in the standalone binary until the
set is slim (a P0-implementation decision once module weight is known). The
`.tar.zst` bundles serve dev installs and the production self-host path,
which run from a repo checkout and unpack to `dist/native/<os>-<arch>/`.

## Determinism

The snapshot pipeline's determinism gate (build twice, diff sha256) stays
**corpus-only**. Swift release builds are not bit-reproducible across
machines/runs today; native artifacts are exempt and tracked as future work
(D-P0-12). Integrity is per-build, via the `.sha256` sidecars generated next
to each artifact.

## Cost envelope

The probe builds in ~7 s clean on an M-class Mac; a realistic P1 module set
stays O(seconds) per platform. The three-leg matrix adds roughly 2–4 min of
billed time per snapshot run (dominated by runner spin-up and swiftly
install, both cacheable), which is noise against the existing 240-min
corpus-build budget. For `ci.yml` (every PR), the Swift lane only needs to
run when `swift/**` changes — a `paths` filter keeps JS-only PRs at today's
cost.
