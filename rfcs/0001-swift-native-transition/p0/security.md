# Security model of the native boundary

Threat analysis for introducing a dlopen'ed native library into a stack whose
current posture is "pure JS + system tools spawned with deadlines". The
boundary adds two new classes of risk — *what code gets loaded* and *what
happens at the memory boundary* — and this document pins the controls for
both. Verified behaviors come from experiments E5/E7.

## 1. What code gets loaded (the control that matters most)

Measured reality on macOS 27 (E7): with Bun's shipped entitlements
(`com.apple.security.cs.disable-library-validation: true`, hardened runtime),
`dlopen` from Bun loads ad-hoc-signed dylibs **regardless of quarantine
attribute or signature flavor** — quarantined, re-signed, and clean copies
all loaded. Compiled `bun build --compile` binaries are ad-hoc signed without
hardened runtime, so they enforce nothing either. **The OS will not gate our
library loads. The loader's path policy is the actual security control.**

Policy (binding for the P0 implementation, [`ffi-bridge.md`](ffi-bridge.md) §3):

- Load only from: an explicit `APPLE_DOCS_NATIVE_LIB` absolute path (operator
  intent — same trust level as editing the service plist), the embedded
  `$bunfs` asset (immutable, inside the signed/checksummed binary), the
  install tree (`dist/native/<os>-<arch>/`), or the dev build tree
  (`swift/.build/release/`).
- **Never from `DATA_DIR`, never from CWD, never via `PATH` or
  `LD_LIBRARY_PATH`/`DYLD_*` search.** The corpus is downloaded data;
  snapshots must never be able to carry executable code into the process.
  (Bun's `allow-dyld-environment-variables` entitlement makes `DYLD_*`
  injection *possible* — for an attacker who can already set the service
  environment, which is outside this threat model, but one more reason the
  loader passes only absolute, allowlisted paths to `dlopen`.)
- The kill switch defaults **off**: a host with no `APPLE_DOCS_NATIVE` set
  never dlopens anything.

## 2. Supply chain

- **Zero SwiftPM dependencies in P0** — there is no `Package.resolved`
  attack surface at all. When P2+ adds apple/swiftlang/pointfreeco packages,
  the RFC 0001 policy applies: pinned versions, committed `Package.resolved`,
  vetted-exception process.
- Toolchain pinned (`.swift-version`, D-P0-2) and installed from swift.org
  via swiftly — no third-party toolchain mirrors. CI actions pinned by major
  version today, by SHA when the lane is implemented (GitHub's own
  recommendation).
- Release integrity: `.sha256` sidecars per artifact (existing convention);
  embedded-dylib distribution (E5) additionally inherits the binary's
  checksum, making the standalone path tamper-evident end to end.

## 3. The memory boundary

Contract v0 is designed so the dangerous patterns cannot be expressed:

| Risk | Control |
| --- | --- |
| Use-after-free across the boundary | Copy-then-free inside one call frame (D-P0-3); no retained pointers, no GC-owned native memory |
| Double free / mismatched allocator | Single allocation per result, `malloc`/`free` symmetry (D-P0-5), `ad_free(NULL)` no-op, free in `finally` |
| Corrupt length → giant read | Length re-read through a 16-byte header view; > 1 GiB rejected before any payload access |
| Native crash takes down the host | No-trap rule: exports validate and return status, never abort (pinned by negative-length / malformed-JSON asserts in the harness) |
| Callback re-entrancy / JS-engine races | `JSCallback` banned outright (D-P0-6); JS thread is the only caller (D-P0-13) |
| Type confusion at FFI | Symbol table + expected ABI version live in one module; `ad_abi_version` hard-check refuses drift (loader falls back to JS) |

Residual risk, stated honestly: Swift is memory-safe *inside* the library,
but `@_cdecl` entry points handle raw pointers, and `bun:ffi` itself is
experimental C-glue. The kill switch (JS fallback identical in behavior) is
the mitigation for the unknown-unknowns class; fuzzing the `ad_*` surface
becomes worthwhile once real modules land (P1, noted in RFC 0001's risk
register).

## 4. Signing policy for shipped artifacts (D-P0-10)

- arm64 macOS dylibs are ad-hoc signed by the linker automatically; we keep
  that, plus sha256 sidecars. No Developer ID / notarization for P0–P6: it
  buys nothing while Bun's entitlements bypass library validation, and the
  loose dylib is consumed by checkout-based installs that verify checksums.
- Revisit at P7: hardened-runtime Swift *executables* do enforce library
  validation and Gatekeeper on first launch — that phase needs Developer ID
  + notarization (and prefers static linking over dylib loading anyway).

## 5. Operational notes

- A structured warn (with `ad_build_info` output) on every fallback-to-JS
  keeps silent downgrades out of production — same observability bar as the
  font-engine fallback chain.
- `apple-docs version --json` should report the loaded native lib (path,
  abi, build info) once P0 lands, so an operator can confirm at a glance
  which implementation served a request path.
