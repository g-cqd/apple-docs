# RFC 0004 — Swift content pipeline (RFC 0001 P4)

- **Status: MAIN LINE DONE** (2026-06-12/13). Phases 1–2 → `content`
  default-on (byte-proven at 358k-doc scale; every perf gate met after the
  perf round). **Phases 3–4 closed NO-GO** by the static-build CPU profile
  (the build is IO-bound, render ~6%). **Phase 3 (crawl-time normalize)** is
  the one remaining, independently-gated question.
- **Detailed execution records**: [`records.md`](0004-content-pipeline/records.md)
  (phases 1–2, the perf round, the static-build profile, D-0004-6/7/8).
- Carries RFC 0001 §7 P4. Repo documentation; not built or indexed.

## 1. Motivation

Content conversion looked like the dominant remaining hot path (≈27 ms/page
× ~358k pages). The static-build profile corrected that: the build is 84%
filesystem IO + 6.5% SQLite; the render surfaces are ~6% (mostly shiki
WASM). The conversion *renderers* are µs-fast — so the live win was the
opt-in→default flip (phases 1–2) and the IO parallelism already shipped, not
a deeper render port.

## 2. Inventory (surveyed 2026-06-12)

Four conversion surfaces share a DocC-JSON walk core (NOT a markdown
parser — D-0004-4):

| # | Surface | Native status |
| --- | --- | --- |
| 1 | Doc markdown + plaintext (leaf renderers) | → `ad_content_doc_markdown` / `ad_content_plaintext` (+ batches), default-on |
| 2 | Crawl markdown (`renderPage`) | → `ad_content_page_markdown` + `ad_content_convert_pages`, default-on |
| 3 | Normalize (docc/refs/metadata) | **JS — phase 3, gated** (crawl-time; contentHash-stability risk) |
| 4 | HTML + highlight (shiki) | **JS — phase 4 NO-GO** (render ~6% of an IO-bound build) |

Storage/IO stays JS in every phase (file IO, DB, caches, sync orchestration).
The one input-side markdown parser (`render-html/markdown.js`, 220 LOC of
regexes) would be ported byte-exactly in phase 4 — a conformant CommonMark
engine would *break* parity (D-0004-4).

## 3. Hard criteria (gates)

| Surface / phase | Gate | Result |
| --- | --- | --- |
| Phases 1-2 markdown/plaintext | **byte-identical** to JS (goldens + full-corpus A/B) | **0 byte mismatches** across 358,371 docs × 2 + 352,542 raw-page replays |
| Phase 2 throughput | convert native ≥ JS | batched 2–3.2×; per-call doc-markdown 2.04× (per-call page/plaintext are test-seam only) |
| Phase 4 HTML | static-build byte-diff + web-build ≥ JS | **NO-GO** — render is ~6% of an IO-bound build (records) |
| Phase 3 normalize | identical contentHash every row | gated separately (crawl-throughput, not static-build) |
| Bridge conduct | contract v0; no-trap; `content` token; absent dylib → JS serves | met (dispatch inside the existing renderers — call sites untouched) |

## 4. Architecture

`ADContent` target (depends ADBase + ADEmbed — reuses `CaseFolding.lowercase`
+ `UnicodeTables.jsWhitespace` for JS `toLowerCase`/`trim` semantics);
exports in ADCore/ContentExports.swift. The **tape JSON parser**
(ADBase/JsonTape.swift) is the substrate — one pass → packed UInt64 records,
zero-copy spans for escape-free strings, linear UTF-8 key compare; the eager
`JsonValue` parser is the correctness fallback (dup keys / span limits /
invalid UTF-8 / safeJson depth-64 → nil). All four renderers emit into one
reusable `[UInt8]` (no intermediate Strings). JS dispatch
`src/content/content-native.js` (announce-once, `_forceImpl`, per-call
fallback) lives INSIDE `renderMarkdown`/`renderPlainText`/`renderPage`. The
port reproduces JS string semantics exactly (fixture-pinned: `/\n{3,}/`
collapse, `trim()`, stable section sort by (sortOrder, originalIndex), etc.).

## 5. Decisions (settled — detail in records.md)

| ID | Question | Decision |
| --- | --- | --- |
| D-0004-1 | JSON without Foundation | hand-rolled ordered, dup-key-aware parser in ADBase; unpaired `\uD8xx` → U+FFFD; safeJson wrapper (error/depth>64 → nil) |
| D-0004-2 | Phase-3 serialization (ECMA number canonicalization) | **open** — settled by the phase-3 spike under contentHash stability (binary-rows-out fallback keeps JSON.stringify in JS) |
| D-0004-3 | Highlight engine (non-Swift) | **moot while phase 4 is shelved** (leaning: in-house TextMate engine, if ever) |
| D-0004-4 | swift-markdown/cmark adoption | **NO** — output is hand-assembled; the input regex parser ports byte-exactly |
| D-0004-6 | Dispatch shape + rollout | the tape-parser precondition was met → flip executed; production uses the batches |
| D-0004-7 | JSC kernels (darwin-only) | **SKIPPED** — native cleared the gates; recorded as a P7 option |
| D-0004-8 | Phase 4 (render-html + highlight) | **NO-GO by measurement** (records) — shelved unless P6/P7 changes the FFI/IO calculus |

## 6. Phases

1–2. **Leaf + crawl renderers** — **DONE** (default-on, byte-proven; perf
   round 2–3.2× batched; records.md). Folds in nothing else.
4. **HTML + highlight** — **NO-GO** (records.md, static-build profile; D-0004-8).
5. **Kills** — JS converters deleted per surface after a release cycle at
   content-native default (RFC 0002 Stage-C pattern). Held on the gate (like
   P3 phase 3).

### Phase 3 — normalize (OPEN, independently gated)

`normalizeDocC + refs + metadata` is a **crawl-time** cost (the static build
reads already-normalized `document_sections`), so the static-build profile's IO-bound finding
doesn't bear on it. Its own gate is a crawl-throughput profile + the
**contentHash-stability** risk (D-0004-2: ECMA number canonicalization,
`new URL()` used-subset) — measured on its own evidence before any work
starts. Deferred, not decided.

## 7. Risks

Phases 1–2 risks retired (records.md). Live: phase 3's contentHash-stability
risk (D-0004-2) — any byte drift in `content_json` churns the whole corpus,
so the binary-rows-out fallback (keep `JSON.stringify` in JS) is the safety
valve, gated before any normalize port.

---
*Maintenance*: phase-3 completion (if pursued) updates RFC 0001 §3/§7. Full
history in [`records.md`](0004-content-pipeline/records.md) + git.
