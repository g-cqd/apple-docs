# FFI bridge: bun:ffi survey, ABI contract v0, loader design

Research target: the Swift↔Bun boundary that every P1–P6 module will cross.
Validated end to end by [`experiments/`](experiments/) (all correctness
asserts green on macOS arm64 and Linux arm64); costs measured in
[`benchmarks.md`](benchmarks.md).

## 1. bun:ffi as of Bun 1.3.14

What P0 uses:

| API | Role | Notes |
| --- | --- | --- |
| `dlopen(path, symbols)` | Load + bind | JIT-compiled trampolines (TinyCC); measured 3.3 ns/call for `() -> u32` (E1) |
| `FFIType.buffer` + explicit `i64` length arg | Buffer in | Passes the TypedArray's pointer; **no implicit length**, so every buffer argument is a `(buffer, len)` pair |
| `FFIType.ptr` returns | Buffer out | Returned as a number (pointer) to a contract-v0 allocation |
| `toArrayBuffer(ptr, offset, len)` | Read native memory | A *view*, not a copy — contract v0 copies out of it before `ad_free` |
| `CString(ptr, offset, len)` | Text out | **Clones** the bytes, so freeing afterwards is safe; measured equal to `toArrayBuffer`+`TextDecoder` at 4 KB (E3) |
| `suffix` | Platform dylib extension | `dylib` / `so` / `dll` |

What P0 bans, and why:

- **`JSCallback`** — documented crash history (oven-sh/bun#17157 and related);
  unnecessary because JS always pulls (D-P0-6).
- **Retained native pointers** — every result is copied and freed within the
  same call frame (D-P0-3). No `FinalizationRegistry`, no deallocator
  callbacks: the E3 probe showed `toArrayBuffer`-deallocator hand-off
  reclaimed nothing under explicit GC (+50 MB / 10 k hand-offs).
- **`dlclose`** — the Swift runtime does not support unloading; the handle
  lives for the process lifetime.

Status caveat, on the record: Bun's own docs mark `bun:ffi` *experimental*
("known bugs and limitations… not be relied on in production; Node-API is the
stable path"). P0 accepts this because (a) the kill switch makes JS the
default and the fallback, (b) the surface we use is the narrow, oldest part
of the API (dlopen + scalars + buffers — no callbacks, no structs), and
(c) the contingency below is cheap. Bun's acquisition by Anthropic
(Dec 2025) improves the maintenance outlook but is not load-bearing for this
decision (D-P0-7).

## 2. ABI contract v0 (normative)

Everything `libAppleDocsCore` exports follows these rules. The probe
(`experiments/swift/Sources/P0Probe/probe.swift`) is the reference
implementation.

**Exports.** C symbols via `@_cdecl`, prefixed `ad_`. C types only — no Swift
types cross the boundary. Mandatory exports:

```c
uint32_t ad_abi_version(void);   // loader hard-checks ==, else JS fallback
void*    ad_build_info(void);    // standard buffer, JSON: {abi, platform, arch, compiler}
void     ad_free(void* p);       // frees any contract buffer; free(NULL) is a no-op
```

**Inputs.** Buffers and strings enter as `(const uint8_t* ptr, intptr_t len)`
pairs (`FFIType.buffer` + `i64`). Strings are UTF-8 bytes, not
NUL-terminated. Scalars use fixed-width C types.

**Outputs.** One return value: a pointer to a single Swift-`malloc`ed
allocation (D-P0-5):

```
offset 0   u64 LE   payloadLen
offset 8   u32 LE   status        0 = ok; nonzero = error, payload is UTF-8 message
offset 12  u8       formatId      0 = bytes, 1 = UTF-8 text, 2 = JSON
offset 13  3×u8     reserved (zero)
offset 16  …        payload (16-byte aligned — malloc alignment preserved
                    for future Float32/Float64/SIMD payload views)
```

`NULL` is returned only on allocation failure (D-P0-4, D-P0-8).

**JS read protocol** (reference: `readResult()` in `experiments/bench.js`):
parse the header via `DataView(toArrayBuffer(p, 0, 16))`, take
`Number(getBigUint64(0, true))`, **reject lengths > 1 GiB** as corruption,
copy the payload out of `toArrayBuffer(p, 16, len)` (or `CString(p, 16, len)`
for text), then `ad_free(p)` in `finally`. Lengths can never legitimately
reach 2^53, so `Number` is safe; never use 32-bit bitwise ops on lengths.

**No-trap rule.** Exported functions must never `fatalError`, force-unwrap,
or precondition-trap on input — an abort in the dylib kills the host process
and defeats the JS fallback. Validate, then return status. The probe's
negative-length and malformed-JSON asserts pin this behavior.

**Threading.** Calls arrive on the JS thread only; exports must be pure
transforms of their inputs (no mutable global state). Worker threads are
deferred (D-P0-13).

**Versioning.** Any signature or header change bumps `ad_abi_version`. The
loader refuses mismatches and falls back to JS with a warning. Per-export
payload evolution rides on `formatId` without an ABI bump.

## 3. Loader design (to be implemented when P0 proper is green-lit)

A single module (`src/native/loader.js`, ≤400-line budget) mirroring the
repo's capability-probe idiom — memoized resolve + `_reset` test seam, exactly
like `_resolveFontTextEngines()` in `src/resources/apple-fonts/render.js`:

1. **Kill switch** `APPLE_DOCS_NATIVE` (parsed in `src/config.js` with the
   existing `bool()`/list coercions): unset or `0`/`off` → loader returns
   `null`, JS everywhere (the default for P0). `1`/`on` → all migrated
   modules. Comma list (`ranking,hash`) → only those modules
   (`isNativeEnabled('ranking')`).
2. **Resolution order**: `APPLE_DOCS_NATIVE_LIB` (explicit operator override,
   absolute path) → embedded `$bunfs` path when compiled (E5/D-P0-9) →
   `dist/native/<os>-<arch>/libAppleDocsCore.<suffix>` → dev fallback
   `swift/.build/release/`. Never `DATA_DIR`, never CWD, never `PATH` — the
   corpus must not be able to carry code (see [`security.md`](security.md)).
3. **Handshake**: `dlopen` in a try/catch; check
   `ad_abi_version() === EXPECTED`; on any failure log one structured warning
   (with `ad_build_info` when available) and memoize `null` — every caller
   silently uses its JS implementation. The kill switch can also force
   per-module JS at runtime for A/B parity checks.
4. **Symbol table** lives in one place next to the expected ABI version; new
   modules add symbols and bump the constant in the same diff.

## 4. Node-API contingency

If bun:ffi disqualifies itself (pivot triggers in D-P0-7): keep the Swift
core untouched — the `@_cdecl` surface is bridge-agnostic — and add a thin C
shim (`napi_module` wrapping the same `ad_*` calls, built into the same
dylib), then swap the loader's `dlopen` for `require()`. Bun supports
Node-API natively and its docs name it the stable path. Estimated scope: the
shim (~150 lines of C), a SwiftPM C target, loader swap; no JS call-site or
Swift changes. This contingency is why contract v0 forbids bun:ffi-specific
constructs (callbacks, deallocators) in the ABI itself.
