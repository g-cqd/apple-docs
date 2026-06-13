# RFC 0004 — content pipeline execution records (archive)

Detailed execution records for the Swift content pipeline, moved here so the
living [RFC 0004](../0004-content-pipeline.md) stays a concise status + the
phase-3 open question. Audit trail for phases 1–2 (parity + the perf round
that flipped `content` default-on) and the §6c static-build profile that
closed phase 4 NO-GO. Repo documentation; never built or indexed. Parent:
[RFC 0001 §7 P4](../0001-swift-native-transition.md).

---

## Phases 1-2 — EXECUTED 2026-06-12 (parity ✓, perf gate NOT met → opt-in)

Everything landed parity-complete and byte-gated; the performance gate
**failed honestly**, so the module shipped at the opt-in stage first
(D-0004-6, then flipped — see the perf round below).

- **Parity**: 96 doc cases + 33 page cases across all 12 source_types
  (committed goldens, generated FROM the JS reference) pass for BOTH
  implementations. Full-corpus A/B: **358,371 docs × doc-markdown, 358,371 ×
  plaintext, 352,542 raw-page replays — 0 byte mismatches** (301.8 s).
  JS-pinned Swift unit suites cover the JSON parser
  (ordered/dup-key/lone-surrogate/depth-64 semantics) and the renderer edge
  cases.
- **Lone-surrogate audit**: 363,603 raw files — **zero** true unpaired
  surrogate escapes (one double-escaped lookalike in an Apple Music API code
  sample). The parser's U+FFFD pin is semantics-by-construction.
- **Performance (arm64, local corpus)** — the opt-in-stage measurement: JS is
  microseconds-fast on every surface (doc-markdown 29,952/s, plaintext
  288,266/s, page-markdown 35,417/s, file-convert 6,518/s); native after a
  byte-level rewrite reached only 0.54×/0.33×/0.07×/0.44×. The fat-doc gap is
  parser + marshalling, not the FFI call.
- **The economics finding** (the P1 lesson, content edition): the "≈27 ms/
  page" pipeline number was IO/download-dominated, NOT render CPU — the
  conversion surfaces cost JS ~0.15-0.5 ms/page. Phases 3-4 were therefore
  gated on a static-build CPU profile before any further porting.

## Perf round — gates MET, `content` default-on (2026-06-12)

Same-day follow-up under §10's pure-performance category (parity suites
unchanged; goldens + a fresh full-corpus A/B every step). What moved the
needle, in profile order:

1. **Tape parser** (ADBase/JsonTape.swift — the D-0004-6 precondition): one
   pass → packed UInt64 records; escape-free strings are zero-copy spans;
   object lookup is a linear UTF-8 compare (kills the Hasher/Dictionary
   column). Correctness fallbacks (dup keys / span limits / invalid UTF-8)
   re-route through the eager parser and adopt onto the tape; safeJson keeps
   depth-64 → nil.
2. **Writer rendering**: all four renderers emit into one reusable [UInt8]
   with in-place ranged transforms — no intermediate Strings on the hot path.
3. **Per-page refs index**: a single Dictionary built per page (replacing
   per-node scans that went quadratic).
4. **Exclusivity**: tape build → struct builder, storage `let` (class-ivar
   `var` access was paying swift_beginAccess per byte).
5. **CMO**: `-cross-module-optimization` + `@inlinable` tape accessors.
6. **Parallel batches**: `concurrentPerform` in `ad_content_convert_pages` +
   the new `ad_content_doc_markdown_batch` / `ad_content_plaintext_batch`;
   JS packing rewrote to two-pass `encodeInto`.

**Measured (arm64, 2,000-doc + 500-page corpus)**: per-call doc-markdown
**2.04×** JS, parallel file-convert **2.65×**, batched doc-markdown **3.18×**,
batched plaintext **1.15×**. Per-call page-markdown (0.29×) and plaintext
(0.52×) still lose — but those shapes are TEST-SEAM only (production callers
use the batches), so every production-engaged surface is ≥ JS. **Parity
re-proven**: full-corpus A/B 0 byte mismatches (239 s).

**Stage decision (operator 2026-06-12)**: `content` joins the default-on
modules. The CI native matrix runs the content goldens against the dylib.

**The P7 corollary**: the surviving per-call losses are pure BOUNDARY tax
(encode + copy + re-parse across the FFI), not render speed. When P5/P7 put
storage + the binary in Swift, sections are born in Swift memory, the tax
disappears, and these renderers inherit batched-or-better economics — this
round's code IS the P7 renderer, already byte-proven at corpus scale.

## Static-build CPU profile — phase 4 gate fired NO-GO (2026-06-13)

The profile that gated phases 3-4 (D-0004-6) ran. **Verdict: NO-GO on phase
4.** RFC 0004 §1 suspected the "hours-long build" headline was
IO/template-bound, not render-CPU-bound; the measurement confirms it.

**Method**: `bun --cpu-prof` over a real `web build --full --workers 1
--concurrency 1` (single-thread forces all render into the profiled process)
on a representative subset — `swiftui` (9k pages) + `wwdc` (2.9k) +
`swift-evolution` (558) + `swift-book` (43) = **12,509 pages**, fresh out dir
+ `--full`. 241 s, 169,146 samples. Self-time bucketed by `callFrame.url` via
`scripts/profile-cpuprofile.mjs` (native frames attributed by name).

**Attribution (self-time)**:

| bucket | % | what it is |
| --- | --- | --- |
| **io-fs** | **84.3** | `writeSync` 81.7 + `write`/`mkdirSync` — writing ~25k files (12.5k `index.html` + 12.5k brotli `.br`) |
| **sqlite** | **6.5** | bun:sqlite `all`/`run` — section fetch + per-framework query + render-index upsert |
| **highlight** | **4.2** | shiki's oniguruma WASM (the entire highlight cost) |
| native/runtime | 2.6 | bun internals |
| regex-exec | 1.1 | markdown.js's regexes |
| template / render-html / markdown-parser(JS) | 0.8 | templates + the tree walk + JS frames |

**The phase-4 surfaces** (render-html + markdown.js + highlight + its
regexes) total **~6%** of build self-time — and **~4.2 of that is shiki's
oniguruma WASM**, which a Swift port would have to REPLACE with an in-house
TextMate engine (D-0004-3) for marginal gain. The render-html tree walk +
markdown.js JS that phase 4 would actually port byte-for-byte are **~1.5%
combined**. Porting them cannot meaningfully move build wall-time.

**The real lever is IO, already parallelized.** The 84% `writeSync` dominance
is a single-thread artifact; in production the build fans out (`--workers N`
+ async `Bun.write`). The "hours" are 346k file writes, addressed by
parallelism (done) — not by a renderer port.

**Phase 3 (normalize) is untouched by this gate**: normalize runs at crawl/
persist time, NOT at static-build time. Its payoff is a separate
crawl-throughput question — deferred, not decided here.

**Reusable artifact**: `scripts/profile-cpuprofile.mjs` buckets any V8
`.cpuprofile` for future CPU-perf measurement.

## Decision detail (D-0004-6/7/8)

- **D-0004-6** — dispatch shape + rollout: the arena (tape) parser
  precondition was met and the flip executed; per-call shapes are TEST-SEAM,
  production uses the batches.
- **D-0004-7** — JSC kernels (bundle the JS renderers into JavaScriptCore
  in-dylib, darwin-only): **SKIPPED** — native cleared every gate first.
  Remains a recorded option for the P7 story, requiring a dual-JSC-in-process
  probe (Bun statically embeds its own JSC) + a §2/§9 decision.
- **D-0004-8** — phase 4 (render-html + highlight): **NO-GO by measurement**
  (§6c). Shelved unless a future need re-opens it (e.g. P6/P7 serving HTML
  in-process where the FFI/IO calculus differs). D-0004-3 (highlight engine)
  is moot while phase 4 is shelved.

## Risks (phases 1-2 retired)

| Risk | Outcome |
| --- | --- |
| Lone surrogates (Bun's lossy utf8/sqlite paths) | phase-1 audit: zero true unpaired escapes in 363k files; parser decodes to U+FFFD by construction |
| `safeJson` depth-64 / parse-failure fallbacks | wrapper reproduces nil-on-depth>64 + nil-on-error; fixture-covered |
| Sort instability on duplicate sort_orders | explicit (sortOrder, originalIndex) comparator; production dups verified |
| Old dylib + new JS symbols | loader whole-native fallback on missing symbols; code+dylib ship together |
| ECMA number canonicalization (phase 3) | binary-rows-out fallback keeps JSON.stringify in JS — gated by contentHash stability (D-0004-2), still open |
