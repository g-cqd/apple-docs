# RFC 0003 — Swift render service (RFC 0001 P3)

- **Status**: Draft (living document) — carries RFC 0001 §7 P3 the way
  RFC 0002 carried P2.
- **Audience**: maintainers. Lives in `rfcs/` deliberately: repo
  documentation, not product documentation; not built or indexed by the
  docs site.

## 1. Motivation

Five inline Swift scripts (~725 LOC under `src/resources/swift/`) do all
symbol/font rendering today, JIT-spawned via `Bun.spawn swift <script>`:

- Query-time one-shots (`symbol-pdf`, `symbol-png`, `font-text`) pay
  ~200 ms of Swift JIT cold-start per call under a 10 s deadline — the
  user-visible pain when a render misses the caches.
- Build-time workers (`symbol-worker`, `symbol-codepoint-worker`) already
  amortize the cold-start through pooling/long-living, but carry process
  plumbing (length-prefixed stdout frames, stdin line protocols, restart
  logic) that the FFI bridge made obsolete elsewhere.
- Linux font rendering depends on the **hb-view host binary** — the last
  host-package requirement the parity work left behind.

P3 consolidates rendering into `libAppleDocsCore` as a persistent service
behind the established bridge (loader, kill switch, contract v0).
**Reordered 2026-06-12 (rfcs/README.md)**: the darwin work runs first as
a SIDE slice in parallel with P4; the Linux HarfBuzz/FreeType shaper —
and the hb-view kill that depends on it — is DEFERRED (hb-view keeps
serving Linux; it works, the host-package dependency is accepted until
the revisit triggers fire). P5's gate is correspondingly P2 +
P3-**darwin** native-by-default; the deferred Linux phase does not sit on
the critical path.

## 2. Inventory (surveyed 2026-06-11)

| Script | LOC | Output | Mode | Spawn site |
| --- | --- | --- | --- | --- |
| symbol-worker | 133 | PDF frames | pooled (4–16), stdin names | apple-symbols/sync.js:266 |
| symbol-pdf | 87 | PDF | one-shot, argv | apple-symbols/render.js:221 |
| symbol-png | 95 | PNG | one-shot, argv | apple-symbols/render.js:198 |
| font-text | 168 | SVG | one-shot, argv | apple-fonts/render.js:155 |
| symbol-codepoint-worker | 242 | JSON lines | long-lived, stdin names | apple-symbols/codepoint-dump.js:318 |

Imports: AppKit + CoreGraphics + ObjectiveC (symbol-worker/pdf), AppKit
(png), CoreText + CoreGraphics (font-text), **private swiftinterfaces**
(SFSymbolsShared, CoreGlyphsLib — codepoint-worker only).

**Native status (2026-06-13, phases 1–2)**: symbol-pdf, font-text,
symbol-png → in-dylib, default-on, per-call spawn fallback; symbol-worker
→ in-dylib batch (`ad_render_symbol_pdf_batch`, the prerender default on
darwin); symbol-codepoint-worker → **stays spawned** (D-0003-1). Every
*darwin* render spawn is now consolidated into libAppleDocsCore except the
codepoint worker. The spawn scripts remain as the fallback (phase-3 kills
gated on a release cycle at default). **Linux** (phase 4): font-text now
shapes in-dylib via dlopen'd libharfbuzz (`hb-native` engine) — the
hb-view host binary is no longer required; symbols on Linux still serve
from prerendered snapshot SVGs.

Caching layers (unchanged by this RFC): `sf_symbol_renders` DB table
(sha-keyed params), pre-rendered snapshot SVGs (~273k files: 27
weight×scale variants per symbol across public+private scopes,
`resources/symbols/...`). Query-time flow checks DB → snapshot file →
live render fallback.

Linux font path: `hb-view --output-format=svg` (apple-fonts/
render.js:126-131, text via temp file for C-locale safety); darwin uses
CoreText first. Engine selection via `APPLE_DOCS_FONT_RENDERER`;
`<text>`-element SVG placeholder as the final fallback either way.

## 3. Hard criteria

| Metric | Gate |
| --- | --- |
| Warm query-time render (symbol PDF→SVG, font text SVG) | **≥ 5× faster than the spawn path p50** (eliminating ~200 ms JIT; measure both, record here) |
| Snapshot prerender throughput (symbols/s, full catalog shape) | **≥ the pooled-worker path** on the macOS build host |
| darwin output parity | **byte-clean fixture diffs** — same CoreText/CoreGraphics/AppKit calls, now in-process |
| Linux font-text parity *(DEFERRED phase 4)* | tolerance-based vs recorded hb-view goldens (different shaper build), plus structural gates (glyph count, advance monotonicity, bbox within ε); exact tolerances set by the deferred spike |
| Platform builds *(NOW — prevents bitrot)* | Linux dylib builds with **no AppKit/CoreText** (`#if canImport`) from phase 1 onward — symbol rendering stays darwin-only by nature (SF Symbols assets are macOS) |
| Bridge conduct | contract v0; no-trap exports; kill-switch module token `render`; absent dylib/symbols → spawn path serves (the scripts stay until the kill phase) |
| Memory | render-service RSS bounded across a full prerender (measured like the §3 RSS gates in RFC 0002) |

## 4. Architecture

New `ADRender` target in `swift/`, platform-split:

- **darwin**: symbol PDF render (the symbol-worker/symbol-pdf core),
  font-text via CoreText — direct ports of the script bodies behind
  `ad_render_*` exports; the EmbedExports singleton/mutex pattern hosts
  any cached state (loaded fonts, symbol catalogs).
- **both platforms**: the font shaper interface; on Linux backed by
  HarfBuzz + FreeType (per D-0003-2), emitting the same SVG contract
  hb-view produces today (black outlines, transparent background).
- JS dispatch: `src/resources/render-native.js` shim mirroring
  fusion-native conventions (announce-once, `_forceImpl`, per-call
  fallback to the spawn path — renders are stateless request/response,
  so fusion-style per-call fallback fits here, unlike the embedder).
- Codecs: requests are small (names, paths, sizes, colors — len-prefixed
  utf8 + u32/f64 fields); responses are binary payloads (PDF/PNG bytes,
  SVG utf8) — contract v0 handles multi-MB payloads (proven by the
  archive module).

## 5. Open decisions

| ID | Question | Leaning |
| --- | --- | --- |
| D-0003-1 | codepoint-worker in-dylib vs stays-spawned — it links PRIVATE swiftinterfaces (SFSymbolsShared/CoreGlyphsLib); baking private-framework linkage into the SHIPPED dylib raises distribution + OS-version fragility | **stays-spawned**: build-time only, already long-lived/amortized (<0.5 ms/symbol after warmup); revisit only if it ever blocks |
| D-0003-2 | Linux shaper binding: HarfBuzz+FreeType via runtime dlopen vs SwiftPM systemLibrary | **SETTLED dlopen (2026-06-13, §6 phase-4): HarfBuzz ALONE.** The libzstd dlopen pattern (zero build deps, absent → placeholder with one warning) — and the HB 7+ `hb_font_draw_glyph` draw API makes FreeType unnecessary (it yields outlines directly; no FT struct-mirroring). Spike GO: matches hb-view within tolerance (0–1.1% supersampled, identical layout) across Latin/RTL/combining/mono. |
| D-0003-3 | AppKit thread model in-dylib: the scripts own their processes' main threads; FFI calls arrive on Bun's JS thread. CoreText/CoreGraphics are thread-safe; `NSImage`-based PNG rasterization may not be | **SETTLED for symbol-pdf (2026-06-13, §6 phase-1 probe): SAFE.** `NSImage(systemSymbolName:)` + the private `vectorGlyph`/`drawInContext:` + CGContext-PDF path runs crash/hang-free in the dlopen'd dylib on Bun's thread, byte-identical to spawn, even under `Promise.all` concurrency — these are off-screen image/vector ops, not event-loop-bound, so the absent AppKit runloop doesn't matter. **CONCURRENCY settled SAFE (2026-06-13, §6 phase-2 Probe A):** the phase-1 verdict only covered SERIAL calls (Bun FFI is synchronous on one JS thread, so phase-1's "Promise.all" ran serially). The batch export drives `DispatchQueue.concurrentPerform` → genuinely concurrent `NSImage`/`vectorGlyph` across GCD threads; 400 public symbols are byte-identical to the serial single + spawn, crash-free. **PNG settled SAFE (2026-06-13, §6 phase-2 Probe B):** in-dylib `NSBitmapImageRep` rasterization (`ad_render_symbol_png`) is byte-identical to the spawn across 6 colour/weight/scale cases, no crash — symbol-png is now native-first too. Only the codepoint worker (D-0003-1) stays spawned. |
| D-0003-4 | FFI result buffers vs socketpair for large payloads | **FFI buffers** (contract v0; copy-then-free; archive proved multi-MB results) — socketpair only if prerender batching measures poorly. Phase-2 prerender chunks at 256 symbols/call → ~1 MB results, RSS bounded; no socketpair needed |

## 6. Phases (reordered 2026-06-12 — darwin first, Linux deferred)

1. **darwin exports + dispatch**: `ad_render_symbol_pdf`,
   `ad_render_font_text` (+`ad_render_symbol_png` pending D-0003-3);
   render-native.js behind `render`; byte-clean fixture gates; warm-path
   bench vs spawn (≥5× gate). darwin font-text keeps CoreText — no shaper
   dependency.
   **EXECUTED 2026-06-13.** Shipped the `ADRender` target
   (FontText.swift under `#if canImport(CoreText)`, SymbolPdf.swift under
   `#if canImport(AppKit)`) + `ad_render_font_text`/`ad_render_symbol_pdf`
   exports (ADCore/RenderExports.swift); render-native.js behind the
   `render` token (default-on); native-first in apple-fonts/render.js
   (`renderFontTextSvgCurves`) and apple-symbols/render.js
   (`renderSymbolToPdfBytes`), per-call null→spawn fallback intact.
   **D-0003-3 settled SAFE** for symbol-pdf by a standalone probe (6
   public symbols, sequential + `Promise.all` concurrency: byte-identical
   to spawn, no host crash/hang on Bun's runloop-less JS thread) — see §5.
   Parity (test/unit/native/render-parity.test.js, darwin-gated): native
   == spawn == committed goldens, byte-identical (symbol leg compares the
   post-processed SVG, not the non-deterministic PDF; font leg skips
   without corpus fonts so CI exercises the symbol leg). Bench
   (test/benchmarks/render-bench.js, warm p50): **symbol-pdf 1497×,
   font-text 163×** — ≥5× gate MET by three orders of magnitude (the
   ~200 ms `swift script.swift` JIT collapses to a warm in-dylib call).
   Linux builds the AppKit/CoreText-stripped dylib clean; its exports
   return `.invalidInput` → JS spawn fallback (hb-view path unchanged).
   `ad_render_symbol_png` stays spawned (separate untested NSBitmap case,
   D-0003-3). EXPECTED_ABI unchanged (1).
2. **Prerender switch**: sync.js pooled spawns → batched FFI calls;
   throughput + RSS gates on the full catalog; spawn path remains the
   fallback. (Improvement candidate D of RFC 0001 §10 folds in here.)
   **EXECUTED 2026-06-13.** `ad_render_symbol_pdf_batch`
   (ADCore/RenderExports.swift) renders a chunk in one FFI call via
   `DispatchQueue.concurrentPerform` (the generic batch helpers
   `renderIndexed`/`lenPrefixedPayload` lifted to ADBase/BatchResult.swift,
   shared with content; SymbolPdf.render now wraps each render in
   `autoreleasepool`). The prerender engine moved to
   apple-symbols/prerender-engine.js: `renderScopeBucketNative` chunks the
   queue (256/call), writes the hits, and funnels the rare nulls
   (bitmap-only / failures) to the **unchanged worker pool**, which
   classifies them exactly as before; non-darwin / native-off /
   whole-chunk-null degrade to the pool. **D-0003-3 concurrency settled
   SAFE** (Probe A): 400 public symbols rendered concurrently in-dylib are
   byte-identical to the serial single + spawn, crash-free — phase-1's
   "Promise.all" probe had only ever run serially (Bun FFI is synchronous
   on one JS thread), so this is the first real concurrent-AppKit proof.
   **symbol-png ported** (SymbolPng.swift, `ad_render_symbol_png`,
   native-first in `renderSymbolPng`): **D-0003-3 PNG case settled SAFE**
   (Probe B): 6 cases byte-identical to spawn, no crash. Gates
   (render-prerender-bench.js, 800×2 slice): **2.0× throughput** over the
   4–16 worker pool, **byte-identical** output (1600/1600), **RSS bounded**
   — 13.5k renders of 500 distinct symbols held 240 MB vs 588 MB for 4k
   distinct (RSS tracks the glyph cache, not render count → the
   per-render autoreleasepool works, no leak). **Prerequisite fix**:
   svg-emit.js used `Math.random()` for SVG mask ids, so ~40% of
   prerendered SVGs (the cut-out symbols) were never byte-reproducible
   run-to-run; now a deterministic content hash (fnv1a of the geometry) —
   distinct symbols still get distinct prefixes. EXPECTED_ABI unchanged
   (1); the batch + png exports are additive.
3. **darwin kills + records**: the one-shot spawn scripts deleted after a
   release cycle at render-native default; RFC 0001 §3/§7 updated;
   codepoint-worker disposition per D-0003-1. hb-view is NOT killed here.
4. **Linux shaper spike + hb-view kill**: dlopen bindings for
   harfbuzz/freetype; shape → glyph outlines → SVG paths; tolerance
   harness vs recorded hb-view goldens across a font/text/size matrix
   incl. RTL, combining marks, emoji fallback. Settles D-0003-2
   empirically, then drops the hb-view host-package requirement (docs,
   self-hosting Linux section).
   **EXECUTED 2026-06-13 (un-deferred by the operator; spike-first).**
   `ADRender/HarfBuzzShaper.swift` dlopens **libharfbuzz alone** — the
   HB 7+ `hb_font_draw_glyph` draw API yields glyph outlines, so FreeType
   isn't needed (one fewer dep than D-0003-2 assumed; FreeType
   struct-mirroring avoided). It runs the SAME HarfBuzz hb-view does
   (`hb_shape` → glyph ids/advances/offsets; `hb_font_draw_glyph` →
   cubic/quadratic path), so glyph selection + layout are identical; only
   the SVG serialisation differs. Exposed as `ad_render_font_text_shaped`
   (no AppKit/CoreText guard — the **first real Linux render code** in the
   dylib); wired as the `hb-native` engine in apple-fonts/render.js,
   ordered before `hb-view` and reachable **without** hb-view installed.
   **Spike (scripts/shaper-spike.mjs) verdict: GO** — across Latin, mixed,
   combining marks, mono, RTL Arabic, RTL Hebrew the trimmed raster dims
   match hb-view exactly and, at 3× supersample, the meaningful-diff
   (35%-fuzz, excludes anti-aliasing edges) is **0–1.1%** (the residual is
   thin-stroke sub-pixel rasterisation phase, converging to 0 with more
   supersampling — proven, not a geometry difference). Gate:
   shaper-parity.test.js (tolerance: dims ±ε + diff < 2%, lib/tool-gated;
   Linux CI installs libharfbuzz + hb-view + rsvg + ImageMagick + DejaVu).
   The `hb-view` host-package requirement is dropped (self-hosting.md):
   libharfbuzz.so.0 is near-ubiquitous, absent → hb-view spawn → placeholder.
   **Emoji** (COLR/sbix) stays out of scope — outline-only, as planned.
   EXPECTED_ABI unchanged (additive export).
   **Original revisit triggers** (now moot): Linux host friction with
   hb-view, or P7's single-binary requirement.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Shaper fidelity vs hb-view (ligatures, marks, fallback) | the deferred phase-4 spike is gate-first; hb-view goldens recorded BEFORE any kill; placeholder fallback unchanged |
| AppKit off-main-thread UB | D-0003-3 spike; CG-only rewrite preferred; worst case the affected script stays spawned |
| Private-framework drift (codepoint) | stays-spawned per D-0003-1 leaning; version-probed at spawn as today |
| Prerender at 273k-file scale through FFI | batched requests (names-in, frames-out per call); the archive module's at-scale lesson (one streaming pass, measured before flip) |
| Dylib size growth | render code is small (~1k LOC ported); no new bundled runtimes — dlopen'd system libs only |

---
*Maintenance*: decisions D-0003-* get dated entries; phase completions
update RFC 0001 §7 P3 with one line each.
