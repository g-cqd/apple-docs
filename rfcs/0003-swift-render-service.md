# RFC 0003 — Swift render service (RFC 0001 P3)

- **Status: ACTIVE** — phases 1, 2, 4 EXECUTED (2026-06-13); **only phase 3
  (darwin spawn-script kills) remains**, held on the RFC 0001 §4
  release-cycle gate. Carries RFC 0001 §7 P3.
- **Detailed execution records**: [`records.md`](0003-swift-render-service/records.md)
  (phases 1/2/4 + the D-0003-3 probe findings).
- Repo documentation; not built or indexed by the docs site.

## 1. Motivation

Five inline Swift scripts (~725 LOC under `src/resources/swift/`) did all
symbol/font rendering, JIT-spawned via `Bun.spawn swift <script>`:
query-time one-shots (`symbol-pdf`, `symbol-png`, `font-text`) paid ~200 ms
of JIT cold-start per cache-miss render; build-time workers
(`symbol-worker`, `symbol-codepoint-worker`) carried process plumbing; and
Linux font rendering shelled out to the **hb-view host binary**. P3
consolidates rendering into `libAppleDocsCore` behind the bridge (loader,
kill switch `render`, contract v0).

## 2. Inventory (surveyed 2026-06-11) + native status

| Script | LOC | Output | Native status (2026-06-13) |
| --- | --- | --- | --- |
| symbol-worker | 133 | PDF frames (prerender) | → `ad_render_symbol_pdf_batch` (prerender default on darwin) |
| symbol-pdf | 87 | PDF (query) | → in-dylib, default-on, spawn fallback |
| symbol-png | 95 | PNG (query) | → in-dylib, default-on, spawn fallback |
| font-text | 168 | SVG (query) | darwin → CoreText in-dylib; **Linux → `ad_render_font_text_shaped` (dlopen'd libharfbuzz)** |
| symbol-codepoint-worker | 242 | JSON lines | **stays spawned** (D-0003-1: private swiftinterfaces) |

Every *darwin* render spawn is consolidated into the dylib except the
codepoint worker; the spawn scripts remain as the fallback (phase-3 kills
gated). **Linux** font-text now shapes in-dylib — the **hb-view host binary
is no longer required**. Symbols on Linux still serve from prerendered
snapshot SVGs (~273k files, 27 weight×scale variants). Query-time flow:
`sf_symbol_renders` DB → snapshot file → live render.

## 3. Hard criteria (gates — all MET)

| Metric | Gate | Result |
| --- | --- | --- |
| Warm query render | ≥ 5× faster than spawn p50 | **163× (font-text) / 1497× (symbol-pdf)** |
| Snapshot prerender throughput | ≥ the pooled-worker path | **2.0×**, RSS bounded |
| darwin output parity | byte-clean fixture diffs | byte-identical (render-parity.test.js) |
| Linux font-text parity | tolerance vs hb-view goldens | **0–1.1%** supersampled, layout identical (shaper-parity.test.js) |
| Platform builds | Linux dylib builds with no AppKit/CoreText (`#if canImport`) | clean on linux-x64/arm64 |
| Memory | render-service RSS bounded across a full prerender | met (per-render `autoreleasepool`) |

## 4. Architecture

`ADRender` target, platform-split: **darwin** — symbol PDF/PNG (AppKit +
private `vectorGlyph`/`drawInContext:`), font-text via CoreText (all under
`#if canImport`); **cross-platform** — `HarfBuzzShaper` (dlopen'd
libharfbuzz, HB draw API → SVG, the first real Linux render code). JS
dispatch `src/resources/render-native.js` (announce-once, `_forceImpl`,
per-call null→spawn fallback — renders are stateless, so fusion-style
fallback fits). The generic batch helpers live in ADBase/BatchResult.swift
(shared with content). Requests small (len-prefixed utf8 + u32/f64);
responses binary (PDF/PNG bytes, SVG utf8) over contract v0.

## 5. Decisions (settled — detail in records.md)

| ID | Question | Decision |
| --- | --- | --- |
| D-0003-1 | codepoint-worker in-dylib vs spawned (private swiftinterfaces) | **stays-spawned** — build-time only, amortized (<0.5 ms/symbol); revisit only if it blocks |
| D-0003-2 | Linux shaper binding | **SETTLED: dlopen, HarfBuzz ALONE** — the HB 7+ `hb_font_draw_glyph` draw API makes FreeType unnecessary; libzstd dlopen pattern (absent → placeholder + one warning). Spike GO |
| D-0003-3 | AppKit thread model in-dylib | **SETTLED SAFE** by three probes — serial symbol-pdf, concurrent (`concurrentPerform`, 400 symbols), and NSBitmap PNG all byte-identical to spawn, crash-free on Bun's thread (records.md) |
| D-0003-4 | FFI buffers vs socketpair for large payloads | **FFI buffers** — phase-2 chunks at 256 symbols/call (~1 MB), RSS bounded; no socketpair |

## 6. Phases

1. **darwin exports + dispatch** — **DONE** (font-text + symbol-pdf,
   163×/1497×; records.md).
2. **Prerender switch + symbol-png** — **DONE** (`ad_render_symbol_pdf_batch`
   2.0× over the pool, byte-identical, RSS bounded; symbol-png native-first;
   records.md). Folds in RFC 0001 §10 candidate (D).
4. **Linux shaper + hb-view kill** — **DONE** (un-deferred; `HarfBuzzShaper`
   dlopens libharfbuzz, hb-view host requirement dropped, spike GO; records.md).

### Phase 3 — darwin kills + records (REMAINING, gated)

Delete the one-shot spawn scripts (`symbol-pdf.js`, `symbol-png.js`,
`font-text.js`) + the `symbol-worker.js` pool **after a release cycle at
render-native default** (RFC 0001 §4) — they are the current fallback, and
deleting them weakens the `APPLE_DOCS_NATIVE=off` escape hatch for symbols,
so the native default must soak in a release first. Then update RFC 0001
§3/§7. **Not killed**: `symbol-codepoint-worker.js` (D-0003-1) and `hb-view`
(an optional Linux fallback). **Held** pending the release-cycle gate.

## 7. Risks

Retired (records.md). The live caveat is phase 3's escape-hatch dependency:
removing the spawn scripts requires the native default to bake in a release
first; the codepoint worker + hb-view stay as deliberate spawned fallbacks.

---
*Maintenance*: phase-3 completion updates RFC 0001 §3/§7. Detail in
[`records.md`](0003-swift-render-service/records.md) + git.
