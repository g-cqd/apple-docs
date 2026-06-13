# RFC 0003 — render service execution records (archive)

Detailed phase-execution records for the Swift render service, moved here so
the living [RFC 0003](../0003-swift-render-service.md) stays a concise
status + the phase-3 forward plan. Audit trail for the darwin phases
(1, 2) + the Linux HarfBuzz shaper (phase 4) + the D-0003-3 probe findings.
Repo documentation; never built or indexed. Parent:
[RFC 0001 §7 P3](../0001-swift-native-transition.md).

---

## Phase 1 — darwin exports + dispatch (EXECUTED 2026-06-13)

Shipped the `ADRender` target (FontText.swift under `#if canImport(CoreText)`,
SymbolPdf.swift under `#if canImport(AppKit)`) +
`ad_render_font_text`/`ad_render_symbol_pdf` exports
(ADCore/RenderExports.swift); render-native.js behind the `render` token
(default-on); native-first in apple-fonts/render.js (`renderFontTextSvgCurves`)
and apple-symbols/render.js (`renderSymbolToPdfBytes`), per-call null→spawn
fallback intact.

**D-0003-3 settled SAFE** for symbol-pdf by a standalone probe (6 public
symbols, sequential + `Promise.all` concurrency: byte-identical to spawn, no
host crash/hang on Bun's runloop-less JS thread). Parity
(test/unit/native/render-parity.test.js, darwin-gated): native == spawn ==
committed goldens, byte-identical (symbol leg compares the post-processed
SVG, not the non-deterministic PDF; font leg skips without corpus fonts so CI
exercises the symbol leg). Bench (test/benchmarks/render-bench.js, warm p50):
**symbol-pdf 1497×, font-text 163×** — ≥5× gate MET by three orders of
magnitude. Linux builds the AppKit/CoreText-stripped dylib clean; its exports
return `.invalidInput` → JS spawn fallback. EXPECTED_ABI unchanged (1).

## Phase 2 — prerender switch + symbol-png (EXECUTED 2026-06-13)

`ad_render_symbol_pdf_batch` (ADCore/RenderExports.swift) renders a chunk in
one FFI call via `DispatchQueue.concurrentPerform` (the generic batch helpers
`renderIndexed`/`lenPrefixedPayload` lifted to ADBase/BatchResult.swift,
shared with content; SymbolPdf.render now wraps each render in
`autoreleasepool`). The prerender engine moved to
apple-symbols/prerender-engine.js: `renderScopeBucketNative` chunks the queue
(256/call), writes the hits, and funnels the rare nulls (bitmap-only /
failures) to the **unchanged worker pool**, which classifies them exactly as
before; non-darwin / native-off / whole-chunk-null degrade to the pool.

**D-0003-3 concurrency settled SAFE** (Probe A): 400 public symbols rendered
concurrently in-dylib are byte-identical to the serial single + spawn,
crash-free — phase-1's "Promise.all" probe had only ever run serially (Bun
FFI is synchronous on one JS thread), so this is the first real
concurrent-AppKit proof. **symbol-png ported** (SymbolPng.swift,
`ad_render_symbol_png`, native-first in `renderSymbolPng`): **D-0003-3 PNG
case settled SAFE** (Probe B): 6 cases byte-identical to spawn, no crash.

Gates (render-prerender-bench.js, 800×2 slice): **2.0× throughput** over the
4–16 worker pool, **byte-identical** output (1600/1600), **RSS bounded** —
13.5k renders of 500 distinct symbols held 240 MB vs 588 MB for 4k distinct
(RSS tracks the glyph cache, not render count → the per-render
autoreleasepool works, no leak). **Prerequisite fix**: svg-emit.js used
`Math.random()` for SVG mask ids, so ~40% of prerendered SVGs (the cut-out
symbols) were never byte-reproducible run-to-run; now a deterministic content
hash (fnv1a of the geometry). EXPECTED_ABI unchanged; the batch + png exports
are additive.

## Phase 4 — Linux HarfBuzz shaper + hb-view kill (EXECUTED 2026-06-13)

Un-deferred by the operator; spike-first. `ADRender/HarfBuzzShaper.swift`
dlopens **libharfbuzz alone** — the HB 7+ `hb_font_draw_glyph` draw API
yields glyph outlines, so FreeType isn't needed (one fewer dep than D-0003-2
assumed; FreeType struct-mirroring avoided). It runs the SAME HarfBuzz
hb-view does (`hb_shape` → glyph ids/advances/offsets; `hb_font_draw_glyph` →
cubic/quadratic path), so glyph selection + layout are identical; only the
SVG serialisation differs. Exposed as `ad_render_font_text_shaped` (no
AppKit/CoreText guard — the **first real Linux render code** in the dylib);
wired as the `hb-native` engine in apple-fonts/render.js, ordered before
`hb-view` and reachable **without** hb-view installed.

**Spike (scripts/shaper-spike.mjs) verdict: GO** — across Latin, mixed,
combining marks, mono, RTL Arabic, RTL Hebrew the trimmed raster dims match
hb-view exactly and, at 5× supersample, the meaningful-diff (35%-fuzz,
excludes anti-aliasing edges) is **0–1.1%** (the residual is thin-stroke
sub-pixel rasterisation phase, converging to 0 with more supersampling —
proven, not a geometry difference). A crash the spike caught: `hb_version`
writes all three out-params unconditionally, so passing `nil` SIGSEGV'd —
fixed. Gate: shaper-parity.test.js (tolerance: dims ±ε + diff < 2%,
lib/tool-gated; Linux CI installs libharfbuzz + hb-view + rsvg + ImageMagick
+ DejaVu). A later precision bump emits full 26.6 (6-decimal) coords matching
hb-view's exact values. The `hb-view` host-package requirement is dropped
(self-hosting.md): libharfbuzz.so.0 is near-ubiquitous, absent → hb-view
spawn → placeholder. **Emoji** (COLR/sbix) stays out of scope. EXPECTED_ABI
unchanged (additive export).

## D-0003-3 — AppKit thread model (full probe findings)

The scripts own their processes' main threads; FFI calls arrive on Bun's JS
thread. CoreText/CoreGraphics are thread-safe; `NSImage`-based rasterization
was the question. Three probes settled it SAFE:

- **symbol-pdf, serial (phase-1 probe)**: `NSImage(systemSymbolName:)` + the
  private `vectorGlyph`/`drawInContext:` + CGContext-PDF path runs
  crash/hang-free in the dlopen'd dylib on Bun's thread, byte-identical to
  spawn — these are off-screen image/vector ops, not event-loop-bound, so the
  absent AppKit runloop doesn't matter.
- **concurrent (phase-2 Probe A)**: the batch export drives
  `DispatchQueue.concurrentPerform` → genuinely concurrent `NSImage`/
  `vectorGlyph` across GCD threads; 400 public symbols byte-identical to the
  serial single + spawn, crash-free. (Phase-1's "Promise.all" only ran
  serially — Bun FFI is synchronous on one JS thread.)
- **PNG (phase-2 Probe B)**: in-dylib `NSBitmapImageRep` rasterization
  (`ad_render_symbol_png`) byte-identical to the spawn across 6
  colour/weight/scale cases, no crash.

Only the codepoint worker (D-0003-1) stays spawned (private swiftinterfaces).

## Risks (retired)

| Risk | Outcome |
| --- | --- |
| Shaper fidelity vs hb-view | spike GO at 0–1.1% supersampled; goldens via shaper-parity; placeholder fallback unchanged |
| AppKit off-main-thread UB | D-0003-3 probes A/B settled SAFE (serial + concurrent + NSBitmap) |
| Private-framework drift (codepoint) | stays-spawned per D-0003-1; version-probed at spawn |
| Prerender at scale through FFI | 256/chunk batches, RSS bounded (autoreleasepool); 2.0× over the pool |
| Dylib size growth | render code small; no bundled runtimes — dlopen'd system libs only |
