# Architecture Review: apple-docs vs Competitors

## Deep comparison of design decisions, tradeoffs, and recommendations

---

## 1. Current apple-docs Architecture

### 1.1 Strengths

**Zero-dependency purity.** The entire project runs on Bun built-ins: `bun:sqlite` for storage, `HTMLRewriter` for HTML parsing, `Bun.CryptoHasher` for hashing, native `fetch()` for HTTP. Zero npm dependencies. This is a genuine competitive advantage:
- No supply chain attack surface
- No dependency rot
- No version conflicts
- Instant installation (no `npm install`)
- Deterministic builds

**Clean module separation.** The codebase is organized into clear layers:
```
apple/     -> parsing Apple's formats (API, extractor, normalizer, renderer, guidelines)
cli/       -> command-line interface (parser, help, formatter)
commands/  -> business logic per command
lib/       -> reusable utilities (logger, rate-limiter, semaphore, fuzzy, hash, yaml)
mcp/       -> MCP server (server, tools)
pipeline/  -> data processing (discover, download, convert, index-body, sync-guidelines)
storage/   -> persistence (database, files)
```

**Tiered search cascade.** The search strategy is more sophisticated than cupertino's:
1. FTS5 BM25 with tier classification (exact > prefix > contains > match)
2. Trigram substring matching (catches partial queries)
3. Levenshtein fuzzy matching (catches typos, distance <= 2)
4. Full-body content search (catches deep references)

Cupertino uses BM25 + 8 custom heuristics but lacks trigram and Levenshtein layers. apple-docs finds more results for imprecise queries.

**Resumable operations.** The `crawl_state` table, `activity` tracking, and per-root BFS queue enable stopping and resuming sync operations. This is critical for a process that takes hours.

**Prepared statements throughout.** Every database operation uses pre-compiled prepared statements via `_prepareStatements()`. No string concatenation SQL. This is both faster (query plan caching) and safer (injection prevention).

**WAL mode + aggressive pragmas.** The database opens with:
```sql
PRAGMA journal_mode = WAL       -- concurrent readers during writes
PRAGMA synchronous = NORMAL     -- good performance/safety balance
PRAGMA cache_size = -64000      -- 64MB page cache
PRAGMA temp_store = MEMORY      -- temp tables in RAM
PRAGMA busy_timeout = 5000      -- 5s retry on lock contention
```
This is production-grade SQLite configuration.

### 1.2 Weaknesses

**Single-source limitation.** The current architecture is deeply coupled to Apple's DocC JSON API. The `pages` table schema, the `roots` hierarchy, the `crawl_state` BFS queue -- all assume a single tree-structured documentation source. Adding Swift Evolution (flat list of proposals), WWDC transcripts (time-indexed media), or package catalogs (GitHub API-sourced) requires either:
- Shoehorning disparate data into the existing schema (poor)
- Creating separate tables per source (better but fragmented)
- Abstracting a common document model that spans all sources (best)

**No source abstraction layer.** There's no `Source` interface or base class. Each source type (Apple docs, HIG, App Store Guidelines) has bespoke handling scattered across pipeline modules. Adding a new source means touching `discover.js`, `download.js`, `convert.js`, and `sync.js`.

**Tightly coupled CLI/MCP formatting.** The `formatter.js` in `cli/` handles all output formatting. MCP tools in `tools.js` format responses differently. There's no shared rendering layer between CLI and MCP, leading to duplicated logic.

**No source type tracking.** The `pages` table has no `source` column. All pages are identified only by their root slug. This makes it impossible to filter "show me only Swift Evolution results" or "search HIG only" without knowing which root slugs map to which source types.

**Schema is page-centric, not document-centric.** The current schema models "pages in a framework hierarchy." This fits Apple docs perfectly but poorly accommodates:
- WWDC sessions (have year, track, duration, speakers -- none fit current columns)
- Swift Evolution proposals (have SE number, status, authors, Swift version)
- Package catalog (has stars, license, GitHub URL, topics)
- Sample code files (have project membership, file path, language)

### 1.3 Recommended Architecture Evolution

**Phase 1: Add `source` column and source registry.** Minimal invasive change:
```sql
ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docs';
```
Source types: `apple-docs`, `hig`, `app-store-guidelines`, `swift-evolution`, `swift-org`, `swift-book`, `apple-archive`, `packages`, `package-docs`, `samples`, `wwdc`.

**Phase 2: Source plugin pattern.** Define a minimal source interface:
```javascript
// src/sources/base.js
export class Source {
  name        // 'swift-evolution'
  displayName // 'Swift Evolution Proposals'
  
  async discover(ctx) { }  // Returns list of items to fetch
  async fetch(item, ctx) { }  // Fetches one item
  async transform(raw) { }  // Raw -> { metadata, markdown }
}
```

Each source implements this interface. The sync pipeline iterates registered sources. This enables:
- `apple-docs sync --sources swift-evolution,wwdc` (selective sync)
- `apple-docs search --source swift-evolution` (source filtering)
- Easy addition of new sources without touching pipeline code

**Phase 3: Extended metadata.** Add a `metadata_json` TEXT column to `pages` for source-specific data that doesn't fit the common schema:
```sql
ALTER TABLE pages ADD COLUMN metadata_json TEXT;
-- For Swift Evolution: {"se_number": "0401", "status": "implemented", "swift_version": "6.0"}
-- For WWDC: {"year": 2025, "track": "SwiftUI", "duration": 1823, "speakers": ["Josh"]}
-- For packages: {"stars": 4500, "license": "MIT", "topics": ["networking", "async"]}
```

---

## 2. Cupertino Architecture Comparison

### 2.1 What cupertino does better

**Source abstraction.** Cupertino has a clear three-phase pipeline (`fetch -> save -> serve`) with per-source crawlers. Each source type (Apple docs, Swift Evolution, HIG, etc.) has its own crawler class with standardized output format.

**Pre-built distribution.** The `cupertino setup` command downloads pre-built databases from GitHub Releases. This is the single most impactful UX feature we lack.

**Schema maturity.** At schema version 10 with proper migrations, cupertino has iterated more on its data model. Denormalized availability columns (`min_ios REAL`, `min_macos REAL`, etc.) enable efficient SQL filtering without JSON parsing at query time.

**Structured logging.** Uses `os.log` with 8 categories. apple-docs has JSON logging to stderr which is functional but less structured.

**Test coverage.** 698 tests in 73 suites with 100% pass rate. apple-docs has ~142 tests across 5 suites -- adequate but not comparable.

### 2.2 What apple-docs does better

**Cross-platform.** Bun runs on Linux, macOS, and Windows. Cupertino requires macOS 15+ (WKWebView). This is a permanent, architectural constraint that cupertino cannot overcome without a full rewrite.

**Crawl speed.** apple-docs fetches Apple's JSON API directly (HTTP). Cupertino uses WKWebView to render pages (headless browser). Direct HTTP is 10-50x faster for bulk operations.

**Search sophistication.** apple-docs has a 4-tier search cascade (FTS5 -> trigram -> Levenshtein -> body). Cupertino has BM25 + heuristics but no fuzzy/trigram layers.

**Zero dependencies.** apple-docs has zero npm dependencies. Cupertino depends on swift-argument-parser and swift-syntax (reasonable), but its 15-package monorepo is significantly more complex to build and maintain.

**Custom MCP vs SDK.** Cupertino built a custom MCP implementation from scratch. apple-docs implements the protocol directly (clean, simple). Both avoid external MCP SDK dependencies, but apple-docs's implementation is simpler and easier to update.

**CamelCase expansion.** apple-docs splits `NavigationStack` -> "navigation" + "stack" for FTS5 queries. Cupertino acknowledges this as a missing feature.

### 2.3 Architecture lessons from cupertino

1. **Separate databases for separate concerns.** Cupertino uses `search.db` for documentation and `samples.db` for code. This prevents sample code (which is voluminous) from bloating the main search index. apple-docs should adopt this pattern.

2. **Denormalize for performance.** Storing `min_ios`, `min_macos` etc. as separate columns (not JSON) enables SQL `WHERE` clauses. apple-docs should add these during migration.

3. **Activity-based locking is good.** Both projects track running operations to prevent concurrent syncs. apple-docs's approach (PID-based liveness check) is actually superior to cupertino's.

4. **Pre-built DB is not optional.** This must be priority #1 for apple-docs.

---

## 3. OxADD1 Architecture Comparison

### 3.1 What OxADD1 does well

**Multi-format output pipeline.** The numbered script approach (`01_discover`, `02_download`, `03_json_to_markdown`, `04_markdown_to_pdf`, `05_markdown_to_html`) cleanly separates concerns. Each step is independently runnable.

**HTML static site with search.** Their `05_markdown_to_html.py` generates a browsable website with Apple-style design and per-framework client-side JavaScript search. This is directly relevant to our static website goal.

**Changelog generation.** The update system generates Markdown changelogs per update cycle. Useful for tracking what changed in Apple's docs.

### 3.2 What OxADD1 does poorly

**No search engine.** Pure archive with no FTS5, no indexing, no query capabilities.

**Limited framework coverage.** Only 10 default frameworks (vs our 307+).

**Minimal testing.** Built in one day, 9 commits. Multiple bug-fix commits suggest insufficient testing.

**Python dependency weight.** 8 pip packages (aiohttp, requests, beautifulsoup4, html2text, markdown, playwright, tqdm, PyYAML) vs our zero.

---

## 4. Technology Assessment: Why Bun is the Right Choice

### 4.1 Bun Built-in Advantages

| Feature | Bun Built-in | Alternative (npm) | Advantage |
|---------|-------------|-------------------|-----------|
| SQLite | `bun:sqlite` (3-6x faster than better-sqlite3) | `better-sqlite3` | Zero-dep, WASM-optimized |
| HTML parsing | `HTMLRewriter` (Cloudflare's lol-html in Rust) | `cheerio`, `jsdom` | Streaming, low memory |
| Markdown parsing | `Bun.markdown` (Zig-based, SIMD-accelerated) | `marked`, `remark` | Native speed |
| Hashing | `Bun.CryptoHasher` | `crypto` (Node) | Optimized for Bun runtime |
| File globbing | `Bun.Glob` | `glob`, `fast-glob` | Native pattern matching |
| Shell commands | `Bun.$` (Shell) | `execa`, `shelljs` | Cross-platform, template literals |
| HTTP server | `Bun.serve()` | `express`, `hono` | Native, fast startup |
| Compilation | `bun build --compile` | `pkg`, `nexe` | Cross-platform, single binary |

### 4.2 Where We Must Add Dependencies

For the expanded feature set, some dependencies become justified:

**Justified additions:**
- None strictly required for core functionality

**Potentially useful but avoidable:**
- `@modelcontextprotocol/sdk` -- Could adopt for Streamable HTTP transport, but our custom stdio implementation works fine and is lighter
- `commander` / `yargs` -- Our custom `parser.js` is adequate for current commands but may strain as we add more subcommands and options

**Recommendation:** Maintain zero-dependency philosophy for core. If we add the static website feature, Bun's built-in `Bun.serve()` and `Bun.markdown` cover the needs without external packages.

---

## 5. Data Flow Architecture Comparison

### 5.1 Current apple-docs flow

```
Apple JSON API
     |
     v
discover.js (BFS crawl, find all pages)
     |
     v
download.js (fetch JSON, save to raw-json/)
     |
     v
convert.js (JSON -> Markdown, save to markdown/)
     |
     v
index-body.js (Markdown -> FTS5 body index)
     |
     v
SQLite DB (metadata + FTS5 indexes)
```

**Observations:**
- Linear pipeline, each step depends on previous
- Raw JSON and Markdown are persisted to disk (redundant with DB in some cases)
- Body index is optional and separate from main index
- No source abstraction -- pipeline is Apple-docs-specific

### 5.2 Proposed multi-source flow

```
Source Registry
  |-- AppleDocsSource (JSON API)
  |-- SwiftEvolutionSource (GitHub API)
  |-- SwiftOrgSource (HTML crawl)
  |-- SwiftBookSource (GitHub raw)
  |-- WWDCSource (ASCIIwwdc + Apple)
  |-- PackageCatalogSource (SwiftPackageIndex + GitHub)
  |-- SampleCodeSource (Git clone + file index)
  |-- AppleArchiveSource (HTML crawl)
  |
  v (each source implements: discover -> fetch -> transform)
  |
  v
Unified Pipeline
  |-- discover(source) -> items[]
  |-- fetch(item) -> raw data
  |-- transform(raw) -> { metadata, markdown, source_metadata }
  |-- store(doc) -> SQLite insert + optional file write
  |-- index(doc) -> FTS5 insert
  |
  v
SQLite DB (unified schema with source_type column)
  + Optional: raw-json/ (Apple docs only, for re-rendering)
  + Optional: markdown/ (all sources)
  + Optional: samples.db (sample code files)
```

### 5.3 File Storage Strategy

**Current:** Stores both `raw-json/{path}.json` and `markdown/{path}.md` for every page.

**Recommended evolution (see [06-markdown-generation.md](06-markdown-generation.md)):**
- Default: JSON-only storage + on-the-fly markdown rendering
- Flag `--with-markdown`: Also persist markdown files
- Flag `--json-only`: Only keep JSON (smallest footprint)
- Flag `--markdown-only`: Only keep markdown (delete JSON after conversion)

---

## 6. Concurrency & Performance Comparison

### 6.1 apple-docs

- **Rate limiter:** Token bucket (configurable req/sec, burst capacity)
- **Concurrency:** Counting semaphore (configurable max in-flight)
- **Queue:** Database-backed BFS queue (survives process restart)
- **Batching:** Pulls `batchSize` items from queue, processes with semaphore

### 6.2 cupertino

- **Rate limiter:** Configurable delays per source
- **Concurrency:** Swift `TaskGroup` with bounded parallelism
- **Queue:** In-memory with file-based checkpoint
- **Resource management:** WKWebView recycling (recreates every N pages to prevent memory bloat)

### 6.3 Observations

apple-docs's concurrency model is simpler and more robust:
- Database-backed queue > file-based checkpoint (survives any crash)
- Token bucket > fixed delays (adapts to burst capacity)
- Semaphore > TaskGroup (same concept, different language)

Cupertino's WKWebView recycling is a workaround for memory leaks in headless browser mode. apple-docs doesn't need this because it uses simple HTTP.

---

## 7. MCP Protocol Implementation Comparison

### 7.1 apple-docs

```javascript
// Custom JSON-RPC 2.0 over stdio
// Handles: initialize, tools/list, tools/call, notifications/initialized
// ~100 lines of code
// 5 tools: search, read, list_frameworks, browse, status
```

**Pros:** Simple, zero-dependency, easy to understand
**Cons:** No Streamable HTTP transport, no resource providers, no prompts

### 7.2 cupertino

```swift
// Custom MCP framework from scratch
// Full JSON-RPC 2.0 with protocol version negotiation
// 7 tools: search_docs, search_hig, list_frameworks, read_document,
//          search_samples, list_samples, read_sample, read_sample_file
// Also has resource providers (URI-based document access)
```

**Pros:** Comprehensive, includes resource providers
**Cons:** Custom implementation must track protocol changes manually, Swift-only

### 7.3 Recommendation

Keep our custom stdio implementation (it works, it's simple, it's zero-dep). As we add sources, add tools incrementally:
- `search` (enhance with `--source` filter)
- `read` (works across all sources)
- `list_frameworks` (rename to `list_roots` or keep)
- `browse` (works for tree-structured sources)
- `status` (enhance with per-source stats)
- NEW: `search_samples` (sample code specific)
- NEW: `read_sample_file` (read individual source files)
- NEW: `list_samples` (list sample projects)

If Streamable HTTP transport becomes necessary (for remote/cloud deployment), evaluate the official MCP SDK at that point. For stdio-only (local CLI/editor), our implementation is sufficient.

---

## 8. Summary Recommendations

### Keep (architectural strengths)

1. Zero-dependency approach with Bun built-ins
2. Database-backed BFS queue for resumable crawling
3. WAL mode + prepared statements + aggressive pragmas
4. Tiered search cascade (FTS5 -> trigram -> Levenshtein -> body)
5. CamelCase expansion for search queries
6. Activity locking with PID-based liveness checks
7. Custom MCP stdio implementation (simple, works)

### Add (close gaps)

1. Source plugin pattern for multi-source support
2. `source_type` column on roots table
3. Denormalized platform availability columns
4. Pre-built database distribution (`setup` command)
5. Extended metadata column for source-specific data
6. Custom ranking heuristics (8 rules from cupertino)
7. npm publishing and single-binary compilation
8. GitHub Actions CI

### Change (architectural improvements)

1. Rename MCP startup verb (not `serve` -- reserve for static website)
2. Add `--source` filter to all search/query tools
3. Create separate `samples.db` for sample code (don't bloat main DB)
4. Make markdown file persistence optional (default to on-the-fly rendering)
5. Add shared rendering layer between CLI and MCP (reduce duplication)

### Avoid (not worth the complexity)

1. External MCP SDK (our implementation is simpler and sufficient)
2. npm CLI framework like commander (our parser is adequate)
3. WKWebView / headless browser (JSON API is better)
4. Vector embeddings (premature without clear use case validation)
5. TypeScript migration (JS is fine, zero build step advantage)
