# RFC 0004 — Swift content pipeline (RFC 0001 P4)

- **Status**: Active (living document) — carries RFC 0001 §7 P4 the way
  RFC 0002/0003 carried P2/P3.
- **Audience**: maintainers. Lives in `rfcs/` deliberately: repo
  documentation, not product documentation; not built or indexed by the
  docs site.

## 1. Motivation

Content conversion is the dominant remaining hot path (evidence in
rfcs/README.md, measured 2026-06-12): ≈27 ms/page × ~358k pages of
JS CPU per full build — pipeline-bench p50 18.1 ms/page including IO,
full static builds measured in hours — while query latency sits ~99%
inside SQLite where ports win nothing.

**Survey corrections to RFC 0001 §7 P4's sketch** (this RFC supersedes
it):

- The hot path **never parses markdown to render docs** — it is a
  custom DocC-JSON walker (~1,640 LOC of string assembly).
  **swift-markdown / swift-cmark are NOT adopted** (D-0004-4): the one
  real markdown parser in the stack (`src/content/render-html/
  markdown.js`, 220 LOC of regexes, used for swift-book/WWDC/evolution
  sources and HTML-source abstracts) must be ported **byte-exactly** in
  phase 4 — a conformant CommonMark engine would *break* parity.
- Syntax highlighting measures 0.15 ms/call (p50, recorded bench) —
  **not** the bottleneck. The shiki kill waits for phase 4; phases 1-3
  don't touch it (the markdown and plaintext surfaces have no
  highlighting at all).
- Phases 1-2 require **zero new SwiftPM dependencies** — the package's
  zero-deps / no-Foundation-in-shipped-targets posture survives at
  least until phase 4's highlight engine decision.

## 2. Inventory (surveyed 2026-06-12)

Four conversion surfaces share the DocC-walk core:

| # | Surface | Code | LOC | Callers |
| --- | --- | --- | --- | --- |
| 1 | Doc markdown + plaintext (leaf renderers) | src/content/render-markdown.js, src/content/normalize/render-content.js, src/pipeline/index-body.js `renderPlainText` | ~330 | MCP read_doc fallback (lookup.js:85-101), web `.md` route, page-builder (`includeFrontMatter`/`includeTitle` opts), FTS body indexing, snippets (render-snippet.js) |
| 2 | Crawl markdown | src/apple/renderer.js `renderPage` (+ `relativePath`) | 327 | pipeline/convert.js `convertAll`, pipeline/persist.js, commands/consolidate.js |
| 3 | Normalize | src/content/normalize/{docc,refs,metadata}.js | ~700 | persist (crawl), lookup re-normalize at read time, hydrate |
| 4 | HTML + highlight | src/content/render-html{,.js}/* + highlight.js (shiki) + render-html/markdown.js | ~1,200 | web static build (~346k pages via web/build/document-pages.js), dynamic serve fallback |

Shared helpers dragged by 1-2: `normalizeIdentifier`
(src/apple/normalizer.js — regex strip + full-Unicode lowercase),
`toFrontMatter` (src/lib/yaml.js — quoting rules), `safeJson`
(src/content/safe-json.js — parse-or-null with a **depth-64 freeze
limit**: depth >64 throws inside the wrapper → null → fallback
rendering; a Swift parser that *succeeds* there would diverge).

Storage/IO that **stays JS in every phase**: file IO + atomic writes,
DB reads/writes, `stableStringify`, the LRU caches (safeJson's cache is
perf-only; the markdown LRU keys on path), sync orchestration and
concurrency pools.

Measured numbers (recorded baselines): pipeline-bench p50 18.1 ms /
p95 27.0 ms per page (download+convert+IO, 25-page fixture);
highlight p50 0.15 ms/call; max `content_json` observed 804 KB
(contract v0 maxInputBytes is 1 GB — ample).

## 3. Hard criteria

| Surface / phase | Gate |
| --- | --- |
| Phases 1-2 markdown/plaintext | **byte-identical** to the JS implementation: committed golden corpus (all source_types) passes for BOTH implementations, plus a full-corpus A/B replay (≈358k docs; doc-markdown + plaintext from DB rows, page-markdown from document_raw) with **0 byte mismatches** (embed's 831k-chunk precedent) |
| Phase 2 throughput | convert-only bench (pages/s) native ≥ JS; numbers recorded here |
| Phase 3 normalize | corpus replay produces **identical contentHash for every row** (sha256(stableStringify) — any byte drift churns the whole corpus); zero re-upsert churn |
| Phase 4 HTML | sampled static-build byte-diff clean; web-build benchmark ≥ JS (RFC 0001 P4 gate) |
| Bridge conduct | contract v0; no-trap exports; kill-switch token `content`; absent dylib/symbols → JS serves identically (dispatch inside the existing modules — call sites untouched) |
| Memory | RSS bounded across a full-corpus conversion pass (measured like RFC 0002 §3) |

## 4. Architecture

- **`ADContent` target** in `swift/` (depends on `ADBase` + `ADEmbed` —
  reusing `CaseFolding.lowercase`, the JS `toLowerCase` mirror, for
  `normalizeIdentifier`, and `UnicodeTables.jsWhitespace` for JS
  `trim()` semantics incl. U+FEFF). Exports live in
  `ADCore/ContentExports.swift`.
- **Ordered JSON parser in `ADBase`** (D-0004-1) — shipped targets have
  no Foundation; the parser is the module's substrate.
- **FFI shapes (phases 1-2)**: text-in/text-out, contract v0.
  `ad_content_doc_markdown` (u32 flags for
  includeFrontMatter/includeTitle + nullable document fields + sections
  as {kind, heading, contentText, contentJson, sortOrder});
  `ad_content_page_markdown` (canonical path + raw DocC JSON bytes);
  `ad_content_plaintext` (document + sections). Responses are UTF-8
  payloads.
- **JS dispatch**: `src/content/content-native.js` on the
  fusion-native pattern (announce-once, `_forceImpl` seam, per-call
  fallback). The native attempt lives INSIDE `renderMarkdown` /
  `renderPlainText` / `renderPage`, so every caller — MCP, web, sync,
  consolidate, tests — is untouched.
- **JS-semantics contract** the port must reproduce (fixture-pinned):
  `/\n{3,}/` collapse + JS `trim()` + trailing `\n` finishers;
  `normalizeParagraphs` `/\n{2,}/` splits; `humanize`'s ASCII-`\b\w`
  capitalization; yaml.js quoting regexes; template-literal `String()`
  coercions; `'#'.repeat(level ?? 2)`; `isActive !== false`; table cell
  `\n→space`; **stable section sort** — JS `Array.sort` is stable and
  (document_id, sort_order) duplicates exist in production, so Swift
  sorts by (sortOrder, originalIndex); reference-map lookups are plain
  gets on the ordered map.

## 5. Open decisions

| ID | Question | State |
| --- | --- | --- |
| D-0004-1 | JSON parsing without Foundation | **Decided**: hand-rolled parser in ADBase — ordered, duplicate-key-aware (JSON.parse semantics: last value wins at the FIRST key position), unpaired `\uD8xx` escapes decode to U+FFFD (incidence pinned by the phase-1 audit; Swift String cannot hold lone surrogates), plus a `safeJson`-equivalent wrapper: parse error → nil, depth >64 → nil (mirroring the freeze-limit throw) |
| D-0004-2 | Phase-3 serialization: `content_json` is `JSON.stringify` over trees REBUILT in JS (spread-clones) — porting normalize means reproducing ECMA number canonicalization (`1.0→1`, `1e2→100`, shortest-round-trip dtoa) and insertion-order keys, or emitting binary rows and letting JS stringify | **Open** — settled by the phase-3 spike under the contentHash-stability gate |
| D-0004-3 | Highlight engine for non-Swift languages (carries RFC 0001 §9 D2) | **Leaning (operator, 2026-06-12): in-house TextMate-style engine** for the ~13 grammars — maximal fidelity; alternatives recorded: tree-sitter (system lib, §9 exception), reduced language set, swift-syntax-for-Swift + plain rest. Phase-4 spike decides on measurements |
| D-0004-4 | swift-markdown / swift-cmark adoption | **Decided: NO** — corrects RFC 0001 §7 P4. Output markdown is hand-assembled; the input-side parser (render-html/markdown.js) is ported as the same regex engine, byte-exactly |
| D-0004-5 | Phase-4 session state: the static build consults a ~358k-entry `knownKeys` set per token, and link emission needs SHA-1 (safe-path safeWebSegment) | embed-init-style session export (init once, render many); settled at phase-4 design. The sync-FFI render budget replaces `renderWithTimeout` (a JS watchdog cannot interrupt a sync native call — the shiki-pin incident's protection moves INSIDE Swift) |

## 6. Phases

1. **Leaf renderers** — `ad_content_doc_markdown` +
   `ad_content_plaintext`; ADBase JSON parser; goldens harvested across
   ALL source_types (apple-docc, design/hig, swift-book,
   swift-evolution, wwdc, sample-code, swift-org, apple-archive,
   app-store-review); lone-surrogate audit of document_raw; kill-switch
   token `content`; parity tests for both implementations.
2. **Crawl markdown** — `ad_content_page_markdown` (renderPage +
   relativePath); full-corpus A/B replay from document_raw; convert
   bench (pages/s) ≥ JS. Phases 1-2 ship together in this RFC's first
   execution slice (operator decision 2026-06-12).
3. **Normalize** — normalizeDocC + refs + metadata; the serialization
   dragon (D-0004-2); the WHATWG-URL used-subset
   (link-resolver.js:151 `new URL()` reached from refs.js) ported
   against recorded fixtures; gate = corpus-wide contentHash stability.
4. **HTML + highlight** — render-html/* + the markdown.js regex parser
   (byte-exact) + the D2 engine per D-0004-3 + knownKeys session init +
   in-Swift render budget; sampled static-build byte-diff + web-build
   bench ≥ JS. *Kills*: `shiki` (after a release cycle at native
   default).
5. **Kills + records** — JS converters deleted per surface after a
   release cycle at content-native default (RFC 0002 Stage-C pattern);
   RFC 0001 §3/§7 updated.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| ECMA number canonicalization (phase 3) | binary-rows-out fallback keeps `JSON.stringify` in JS; decision gated by contentHash stability (D-0004-2) |
| Lone surrogates: Bun's two lossy paths (utf8 write → U+FFFD; sqlite bind → mangled pairs) | phase-1 audit pins incidence + semantics; parser decodes unpaired escapes to U+FFFD; DB inputs arrive as already-materialized UTF-8 |
| `safeJson` depth-64 / parse-failure fallbacks | wrapper reproduces nil-on-depth>64 and nil-on-error; fixture cases for both |
| Sort instability on duplicate sort_orders | explicit (sortOrder, originalIndex) comparator; production duplicates verified to exist |
| Old dylib + new JS (3 new symbols) | loader's whole-native fallback on missing symbols is established behavior; code+dylib ship together |
| Sync FFI blocks the event loop on big batches | build paths are CLI (blocking fine); query paths send single-doc requests; phase-4 budgets live in Swift |
| Fixture corpus misses a source_type's quirks | harvest samples EVERY source_type + the full-corpus A/B is the real gate |

---
*Maintenance*: decisions D-0004-* get dated entries; phase completions
update RFC 0001 §7 P4 with one line each; measured numbers land in a
record subsection per phase.
