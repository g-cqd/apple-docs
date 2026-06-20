# Native-stack feature gaps — ADHTML, ADBuilder, ADServe (+ ADWrite schema)

**Status:** assessment / handover to the package task forces
**Author:** apple-docs migration (D3 crawl + web build)
**Date:** 2026-06-20
**Companion:** `rfcs/adserve-http-client-requirements.md` (D2.5 — the HTTP client, already specced)

## Context

The native crawl vertical is complete and gated end-to-end:
`URL → SourceRegistry/adapter → ADHTML parse → NormalizedPage → ADBuilderPipeline persist → ADDB rows → embeddings`.
Built this pass: the ADHTML byte-level HTML tokenizer (`HTMLTape`, ~1–2.8 GB/s, 2 allocations, fuzz-hardened),
tree construction (`HTMLNode`), HTML→Markdown/plain-text + `HTMLDocument.extract`, the `SwiftOrgAdapter`,
the persist boundary, and the `CrawlDriver` (bounded-concurrency, embedding-folding).

The remaining work — **D3a (web static build)**, the rest of the **D3b adapters** (guidelines, apple-archive),
and **incremental re-crawl** — is blocked or hand-rolled around features the three foundation packages do
not yet provide. This document lists each gap **explicitly**, says **why** the consumer needs it, and proposes
**how it should be laid out** (module / type / signatures). Nothing here is a workaround request — these are
capabilities the foundations should own so consumers stop re-deriving them.

Priority key: **P0** blocks D3a/D3b now · **P1** needed before Sunset · **P2** quality/perf.

---

## 1. ADHTML

ADHTML is consumed two ways now: the **parser** (`ADHTMLCore.Parse`, new this pass) and the **generation DSL**
(`HTMLElement`/`@HTMLBuilder`/`render()`). Both have gaps for the web build.

### 1.1 — Markdown → HTML renderer (P0) — *the single biggest blocker for D3a*

**Today:** `ADHTMLMarkdown` is a stub — literally `public enum ADHTMLMarkdown {}` with a comment "Placeholder
this pass." swift-markdown is wired as a gated dependency but nothing renders.

**Why:** the crawl stores section bodies as **Markdown** (DocC→Markdown and HTML→Markdown both land in
`document_sections.content_text`). The web build's entire job is Markdown → HTML. Every doc page needs this;
there is no native path today (the JS used a `markdownToHtml`).

**Proposed layout** — `ADHTMLMarkdown` (gated `ADHTML_MARKDOWN`, already exists), built on swift-markdown's
`Document` AST, emitting ADHTML nodes (so escaping + the byte sink are reused; we own the renderer per the
target's own doc comment):

```swift
public enum ADHTMLMarkdown {
    /// CommonMark + GFM (tables, strikethrough, task lists) → an ADHTML fragment. Inline HTML in the
    /// source is parsed (not passed through raw) unless `allowRawHTML` is set. Links pass through
    /// `linkResolver`; fenced code blocks pass through `highlighter` (see §1.3) when present.
    public static func render(
        _ markdown: String,
        linkResolver: (@Sendable (String) -> String?)? = nil,
        highlighter: (any CodeHighlighter)? = nil,
        allowRawHTML: Bool = false
    ) -> some HTML

    /// Direct-to-bytes for the static-file / server path (no intermediate String).
    public static func renderBytes(_ markdown: String, /* … */) -> [UInt8]
}
```

Acceptance: round-trips the `test/fixtures/content-parity` corpus to structure-equivalent HTML; GFM tables +
code fences supported; emits via the existing `ByteSink` (no `Bun.escapeHTML` equivalent needed).

### 1.2 — Full HTML5 document render with DOCTYPE (P0)

**Today:** `html { … }.render()` emits `<html>…</html>` but there is **no `<!DOCTYPE html>`** in the generation
path (DOCTYPE only exists in the *parser*). The web build must emit standards-mode pages.

**Proposed layout** — a document wrapper that prepends the doctype and is itself `HTML`:

```swift
/// An HTML5 document: renders `<!DOCTYPE html>\n<html …>…</html>`.
public struct HTMLDocument: HTML {
    public init(lang: String? = nil, @HTMLBuilder _ content: () -> some HTML)
}
// equivalently, a convenience on the html element:
extension HTMLElement where Tag == Tags.Html { public consuming func renderDocument() -> String }
```

### 1.3 — Syntax highlighting (P1)

**Today:** none. The JS web build highlights code blocks into dual-theme (`github-light`/`github-dark`)
span classes (swift-syntax for Swift; a hand-rolled tokenizer for objc/json/shell/c/…), behind an 8 KB
size guard + an `APPLE_DOCS_NO_HIGHLIGHT` killswitch.

**Why:** code blocks are the bulk of developer-doc value; unhighlighted code is a visible regression. §1.1's
`highlighter` parameter needs a conformer to pass.

**Proposed layout** — a new gated module `ADHTMLHighlight` (swift-syntax is already in ADHTML's graph for the
macro target, so no new dependency for the Swift path):

```swift
public protocol CodeHighlighter: Sendable {
    /// Highlight `code` into spans carrying dual-theme classes; returns nil to fall back to a plain
    /// `<pre><code>` (the size guard / unknown-language path).
    func highlight(_ code: String, language: String?) -> (any HTML)?
}

public enum SyntaxHighlight {
    public static let swift: any CodeHighlighter        // swift-syntax classifier
    public static func generic(maxBytes: Int = 8 << 10) -> any CodeHighlighter  // small multi-lang tokenizer
}
```

### 1.4 — Parser: full named-character-reference table (P1)

**Today:** `HTMLTape` / `HTMLTokenizer` ship ~30 common named entities (`amp`, `lt`, `mdash`, …). The full
WHATWG table is ~2,200 entries with a longest-match rule (and the legacy no-semicolon forms).

**Why:** Apple HTML uses the long tail (`&hellip;`, `&rsquo;`, math/greek in some archive pages). Missing
entries pass through literally → wrong text in the index + the rendered page.

**Proposed layout:** generate `Parse/Generated/NamedCharacterReferences.swift` from the WHATWG JSON (a codegen
step like `ADHTMLCodegen`), and switch the decoder to the maximal-munch match the spec mandates. Keep it a
`static let [String: String]` (or a perfect-hash byte trie for the hot path).

### 1.5 — Parser: CDATA + `<script>` data-escape sub-states (P2)

**Today:** `<![CDATA[…]]>` is treated as a bogus comment; the `<script>` escaped/double-escaped sub-states
(`<!--` … `<script>` inside script data) are not modeled (raw-text stops at the first `</script`).

**Why:** rare in DocC output but present in foreign/embedded SVG and some archive pages; affects fidelity, not
safety (the fuzz gate proves no crash).

**Proposed layout:** add the `cdataSection` + `scriptDataEscaped*` states to the tape scanner; gate behind the
existing differential test (materialize == reference) so parity is enforced as states are added.

### 1.6 — Parser: zero-alloc tape cursor (P2)

**Today:** consumers either `materialize()` (a `String` per token) or `token(at:)` (also materializes). Tree
construction allocates a full `[HTMLToken]`/`HTMLNode` tree.

**Why:** the tape's whole point is zero per-node allocation; the *consumption* side throws that away. Extraction
(`HTMLDocument.extract`) and tree construction would benefit from walking ranges without building Strings until
a value is actually read.

**Proposed layout:**

```swift
extension HTMLTape {
    public struct Cursor: ~Escapable {           // borrows the tape
        public var kind: TokenKind { get }
        public func name(into: inout [UInt8])     // lowercased name bytes, no String
        public func forEachAttribute(_ body: (_ name: Span<UInt8>, _ value: Span<UInt8>) -> Void)
        public mutating func advance() -> Bool
    }
    public func cursor() -> Cursor
}
```

---

## 2. ADBuilder

The crawl seams (`HTTPClient`, `RateLimiter`, `RetryPolicy`, `SourceAdapter`, `CrawlPipeline`, `CrawlDriver`)
are in place. The gaps are the source-specific + web-build subsystems.

### 2.1 — Archive unpack (P0 for apple-archive)

**Today:** `ADArchive` writes tar.zst + has zstd/gzip-decompress, but there is no **zip** (and the apple-archive
source ships zip bundles) and no consumer-facing "download → unpack to dir."

**Why:** the apple-archive adapter's `fetch` is "download a `.zip`, unpack, walk the HTML files." Can't be
written without unzip.

**Proposed layout** — in ADBuilder (over `ADArchive` + `Foundation.Process unzip` fallback), or promoted into
`ADArchive`:

```swift
public enum ArchiveUnpack {
    public static func unzip(_ data: [UInt8], into directory: URL) throws -> [URL]   // entry file URLs
    public static func untar(_ data: [UInt8], into directory: URL) throws -> [URL]
}
```

### 2.2 — Cross-source link resolver (P1)

**Today:** `SwiftOrgAdapter` ships a minimal relative→absolute resolver; the JS `link-resolver.js` is a 312-line
RULES table mapping every external URL pattern to a corpus key (`developer.apple.com/documentation/<fw>/<rest>`,
`/design/…`, `/library/archive/…`, `/videos/play/wwdc…`, `docs.swift.org/swift-book/…`, …) plus a `knownKeys`
gate.

**Why:** without it, cross-doc links in rendered Markdown stay external instead of internalizing to
`/docs/<key>` — the corpus loses its hyperlink graph.

**Proposed layout** — `ADBuilder/Sources/LinkResolver.swift`:

```swift
public struct LinkResolver: Sendable {
    public init(sourceURL: String, knownKeys: Set<String>)
    /// Returns a rewritten in-corpus path, the original (external), or nil (drop the wrapper).
    public func resolve(_ href: String) -> String?
}
```

A data-driven `RULES: [(test, map)]` so adding a source is one entry, not an adapter edit.

### 2.3 — Entry-point registry (P1)

**Today:** none. The JS `entry-points.js` lets an adapter register a page under cross-source `parents`, which
swift-org/apple-archive then surface as a "Related Documentation" topics section (`applyArchiveCrossLinks`).

**Proposed layout:**

```swift
public actor EntryPointRegistry {
    public func register(_ entryPoint: EntryPoint)                 // EntryPoint already exists in SourceAdapter
    public func entryPoints(forParent key: String) -> [EntryPoint]
}
```

Threaded through `SourceContext` so adapters read/write it during `discover`/`normalize`.

### 2.4 — Web build subsystem (P0 — this is D3a)

**Today:** nothing. The JS `src/web/` is `build.js` (401 L orchestrator) + `templates*` (head/SEO/OG/JSON-LD,
search/symbols/fonts/not-found) + `highlight.js` + an asset bundler.

**Proposed layout** — `ADBuilder/Web/`, depending on §1.1–§1.3:
- `PageShell.swift` — `head(meta:)` (SEO/OG/Twitter/JSON-LD via the generation DSL) + the body chrome.
- `DocPage.swift` — `NormalizedDocument` + sections → a full `HTMLDocument` (Markdown bodies via §1.1).
- `BuildSite.swift` — the orchestrator (dirs → assets → landing/doc pages → framework lists → search
  artifacts + sitemaps → manifest → atomic swap → link audit), reading from ADStorage.
- `Sitemap.swift` — gzip sitemaps (needs `ADArchive` gzip, which exists).
- Asset bundling stays a `bun build` subprocess behind a seam for now (a pure-Swift JS bundler is out of scope).

### 2.5 — Incremental-check state (P1) — *also a schema gap, see §4*

**Today:** `CrawlDriver` always fetches. The HEAD-skip (`adapter.check(previousState:)`) needs the previous
validator (ETag) per key — but `crawl_state` has no place to store it (§4).

**Proposed layout (ADBuilder side):** once §4 lands, `CrawlDriver.crawl` reads the stored validator, calls
`check`, and skips fetch on `unchanged` — adding `Stats.skipped`. A `CrawlState` read/write helper (over the
new column) belongs next to `CrawlPipeline`.

---

## 3. ADServe

### 3.1 — Native HTTP client (P0 — already specced in the D2.5 RFC)

**Today:** ADServe is server-only; the crawler runs on the interim `URLSessionHTTPClient`. The full requirements
(conditional GET, streamed body, per-request deadline, cancellation, connection pool, redirect policy, gzip,
rate-limit seam, typed transport faults) are in `rfcs/adserve-http-client-requirements.md`, with the exact
`HTTPClient` protocol ADBuilder codes against. This is the swap target — restating here only for completeness.

**Proposed layout:** `ADServeClient` (NIO, reusing ADServe's NIOSSL) conforming to `ADBuilder.HTTPClient`
verbatim, so the swap is zero call-site changes.

### 3.2 — Static-site serving (P2 — for serving the D3a output)

**Today:** ADServe serves dynamic routes; there is no efficient static-file handler (range requests, ETag from
file mtime/size, precompressed `.gz`/`.zst` negotiation, immutable-asset cache headers).

**Why:** the D3a build emits a static site that should be servable directly by `ad-server` (not only by an
external CDN), closing the loop for local/preview serving.

**Proposed layout:** an `ADServeStatic` handler — `staticFiles(root:options:)` with conditional GET, byte-range,
and content-encoding negotiation, mounted as a fallthrough route.

---

## 4. ADWrite / ADDB schema — `crawl_state` validators (P1)

**Today:** `crawl_state(path, status, root_slug, depth, error)` has **no ETag / Last-Modified / content-hash
column**, so the native crawl cannot persist the per-key validator the incremental HEAD-skip (§2.5) needs.
`documents.content_hash` exists but only enables a *post-fetch* skip (saves the write, not the request).

**Proposed layout:** add nullable `etag TEXT`, `last_modified TEXT`, `last_checked TEXT` to `crawl_state` (a
forward-only `AppleDocsSchema` migration), and `CrawlPersist` read/write helpers:

```swift
extension CrawlPersist {
    public static func crawlValidator(_ db: Database, path: String) throws -> (etag: String?, lastModified: String?)?
    public static func setCrawlValidator(_ db: Database, path: String, etag: String?, lastModified: String?, now: String) throws
}
```

This is the single change that unlocks request-skipping incremental re-crawls (the main efficiency win).

---

## Summary (build order)

| # | Feature | Pkg | Pri | Unblocks |
|---|---|---|---|---|
| 1.1 | Markdown → HTML renderer | ADHTML | P0 | D3a doc pages |
| 1.2 | DOCTYPE document render | ADHTML | P0 | D3a pages |
| 2.4 | Web build subsystem | ADBuilder | P0 | D3a |
| 2.1 | Archive unzip | ADBuilder | P0 | apple-archive adapter |
| 3.1 | Native HTTP client | ADServe | P0 | production crawl (specced) |
| 1.3 | Syntax highlighting | ADHTML | P1 | D3a code blocks |
| 1.4 | Full entity table | ADHTML | P1 | parse fidelity |
| 2.2 | Link resolver RULES | ADBuilder | P1 | corpus link graph |
| 2.3 | Entry-point registry | ADBuilder | P1 | cross-source topics |
| 4 | crawl_state validators | ADWrite | P1 | incremental re-crawl |
| 1.5 | CDATA / script-escape | ADHTML | P2 | parse fidelity |
| 1.6 | Zero-alloc tape cursor | ADHTML | P2 | extraction perf |
| 3.2 | Static-site serving | ADServe | P2 | local preview of D3a |

---

# Counter-assessment (self-review, verified)

The assessment above was written fast and **under-verified**. On review — checking the actual schema, the JS
pipeline, and swift-markdown — several findings are overstated, mis-categorized, or simply wrong. Corrections,
strongest first.

## C1. §4 is wrong — no schema gap exists (verified)

I claimed `crawl_state` needs new validator columns. Both halves are false:
- **The columns already exist.** `AppleDocsSchema` defines `etag`, `last_modified`, `content_hash` on the
  **`pages`** table (not `crawl_state`), and the JS `persist.js` writes them there via `upsertPageFromDocument`.
- **The real gap is much smaller.** Native `CrawlPersist.persistNormalized(_:rootId:path:_:hashes:now:)` takes
  no `etag` — so it writes a `pages` row with the validator left NULL, even though `FetchResult` already carries
  `etag`/`lastModified`. The fix is a **parameter addition** (thread the validator into the existing column),
  plus a `CrawlPersist.pageValidator(path:)` read for the driver's check. **No migration.** Incremental re-crawl
  is materially closer than §4 implied. I prescribed a schema change without reading the schema.

## C2. The doc conflates two different things

It lists "foundation gaps" and "ADBuilder's own unbuilt work" under one banner. They are not the same question.
The user asked what **ADHTML / ADBuilder / ADServe lack** — but most of the ADBuilder items are not gaps in a
*dependency*; they are features **ADBuilder owes itself**:
- §2.2 link-resolver RULES, §2.3 entry-point registry, §2.4 the whole web-build subsystem, §2.5 the driver's
  incremental wiring — **all ADBuilder's own code to write.** Nothing is missing *from a foundation* there.
- The genuine cross-package asks are only: a Markdown renderer (ADHTML), zip (ADArchive), the NIO client
  (ADServe), and the persist-`etag` thread (ADWrite, per C1). Everything else is "I haven't built it yet,"
  which is a backlog item, not a gap.

## C3. Almost nothing is actually P0/blocking

I stamped five P0s. Under scrutiny the crawl **runs today** and D3a can proceed without any of them:
- **§1.2 DOCTYPE (P0 → non-issue).** "Generation can't emit a doctype" is true but irrelevant — the consumer
  prepends the 15-byte string `"<!DOCTYPE html>\n"`. Asking ADHTML for an `HTMLDocument` type for a string
  concat is gold-plating, not a gap.
- **§1.1 Markdown renderer (P0 → P1, "biggest blocker" retracted).** swift-markdown is AST-only (no HTML
  renderer — confirmed), so *someone* writes the visitor. But ADBuilder can write a `MarkupWalker`→HTML pass
  itself in an afternoon; it is not *blocked* on ADHTML. The right call is still "this belongs in ADHTML"
  (per ADHTMLMarkdown's own stated intent, for reuse) — but as an ownership/reuse argument, not a blocker.
- **§3.1 NIO client (P0 → P1).** The interim `URLSessionHTTPClient` is functional and the crawl gates pass on
  it. The NIO client is a production-quality upgrade (pooling, NIOSSL reuse, streaming), not a blocker.
- **§2.4 web build / §2.1 unzip (P0 → P1).** These are real work, but the web build is *ADBuilder's own* (C2)
  and unzip has a trivial `Process("unzip")` interim. Neither blocks today.

Honest verdict: there are **no true P0 dependency blockers**. The path to D3a is ADBuilder-local code.

## C4. Misplaced ownership

- **§1.3 highlighting** — I put it in ADHTML, but the dual-theme `github-light/dark` classes, the 8 KB guard,
  and the killswitch are **apple-docs conventions**. The Swift-classifier core could be shared, but the feature
  belongs in **ADBuilder/Web** (or its own package), not ADHTML. Reclassify.

## C5. Speculative / premature — should be dropped, not listed

- **§1.6 zero-alloc tape cursor.** The tape is zero-alloc on the *tokenize* step; consumption (tree/extract)
  allocating is fine because a page is parsed **once** and is dwarfed by network + embedding cost. Optimizing
  it is premature; drop from the ask list.
- **§3.2 static-site serving.** Any static server / CDN serves the D3a output. "ad-server could serve it" is a
  convenience, not a need. Drop to "maybe later."
- **§1.4 full entity table (P1 → P2).** The shipped ~30 common entities cover Apple/DocC HTML; the 2,200-entry
  long tail (greek/math) is rare in this corpus. Fidelity nice-to-have, not P1.

## Revised, honest ask list

What I'd actually request of the foundations (everything else is ADBuilder's backlog or non-issues):

| Real ask | Pkg | Pri | Interim that unblocks today |
|---|---|---|---|
| Markdown → HTML renderer (own the visitor) | ADHTML | P1 | ADBuilder-local `MarkupWalker`→HTML |
| Thread `etag`/`lastModified` through `persistNormalized` (columns exist) | ADWrite | P1 | — (small, enables incremental) |
| `zip` unpack | ADArchive | P1 | `Process("unzip")` |
| NIO `HTTPClient` (D2.5) | ADServe | P1 | `URLSessionHTTPClient` (works) |
| Full entity table; CDATA states | ADHTML | P2 | common subset covers the corpus |

Everything in §2.x and the §1.2/1.3/1.6/3.2 rows is either ADBuilder's own work or a non-issue. The corrected
bottom line: **D3a is not blocked on the foundations** — it is blocked on writing ADBuilder/Web (plus an
afternoon's Markdown visitor), and the highest-leverage *foundation* change is the trivial ADWrite `etag`
thread that turns on incremental re-crawl.
