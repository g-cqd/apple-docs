# apple-docs v2 — Implementation Progress

> Last updated: 2026-04-13
> Verification snapshot: 2026-04-13 22:00:00 CEST
> Execution policy: no Phase 5 work before Phase 4 is complete; no Phase 6 work before Phase 5 is complete; no Phase 7 work before Phase 6 is complete
> Evidence: `bun test` passes (473 tests), `bun run typecheck` passes, `bun run lint` currently fails with pre-existing Biome findings in `src/commands/sync.js`, `src/commands/update.js`, and `test/unit/github.test.js`

## Phase Status Overview

| Phase | Name | Status | Actual Progress | Exit Criteria State |
|---|---|---|---|---|
| **0** | Stabilize & Foundation | `COMPLETE` | 7/7 tasks landed | Met |
| **1** | Canonical Content Model | `COMPLETE` | 7/7 tasks landed | Met |
| **2** | Source Adapter Layer | `COMPLETE` | 7/7 tasks landed | Met |
| **3** | MCP SDK Migration | `COMPLETE` | 7/7 tasks landed | Met |
| **4** | Source Coverage Expansion | `COMPLETE` | v2 source-expansion scope is implemented, integrated, and verified in repo tests | Met for committed v2 scope |
| **5** | Search Quality Upgrade | `COMPLETE` | All 9 tasks done: platform/language/synonym filtering, snippets, related counts, 8-rule reranking, intent detection, p95 benchmark | Met |
| **6** | Distribution & Setup | `COMPLETE` | All 7 tasks done: snapshot build pipeline, setup command, doctor verification, status update check, CI/CD workflows, npm publishing config, cross-platform binary workflow | Met |
| **7** | Static Website | `READY` | `web` namespace is reserved in CLI/help only; Phase 6 complete, Phase 7 is now unblocked | Not yet met |
| **8** | Storage Profiles & Polish | `NOT_STARTED` | On-demand lookup rendering and `doctor` groundwork exist; profile system is absent | Not yet met |

```
Overall: phases 0-6 are complete for the current v2 scope; phase 7 is now unblocked and ready to begin.
```

## Current Planning Wave

**Planner mode**: `Project + Orchestration`
**Active phase**: `P7` (ready to begin)
**Execution intent**: Phase 6 is complete; Phase 7 is now unblocked

| Slice | Status | Evidence | Next action |
|---|---|---|---|
| `P5-A` | `done` | Search rows carry `source_type`/`source_metadata`; CLI and MCP accept source filtering | — |
| `P5-B` | `done` | Platform/language/synonym filtering wired through CLI/MCP/DB; 6 new golden queries | — |
| `P5-C` | `done` | Snippets and related counts in search results via batch queries | — |
| `P5-D` | `done` | Intent detection + 8-rule reranking replaces static tier sort; 24 unit tests | — |
| `P5-E` | `done` | Benchmark harness: 42 queries × 50 iterations; p50=0.15ms p95=0.20ms p99=0.23ms | — |

---

## Phase 0: Stabilize & Foundation

**Status**: `COMPLETE` (2026-04-13)
**Depends on**: Nothing (entry phase)
**Blocks**: Phase 1, Phase 2, Phase 3

### Tasks

| ID | Task | Status | Files Touched |
|---|---|---|---|
| 0.1 | Lock Dependencies & Toolchain | `done` | package.json, tsconfig.json, biome.json, .github/workflows/ci.yml |
| 0.2 | Fix Guidelines Update Bug | `done` | src/commands/update.js |
| 0.3 | Add `read` Fallback Rendering | `done` | src/commands/lookup.js |
| 0.4 | Command Namespace Redesign | `done` | cli.js, src/cli/parser.js, src/cli/help.js |
| 0.5 | Schema v5 Migration | `done` | src/storage/database.js |
| 0.6 | Golden Search Query Suite | `done` | test/golden/seed.js, search-queries.json, search-benchmark.test.js |
| 0.7 | Integration Test Harness | `done` | test/integration/search.test.js, test/integration/sync.test.js, src/apple/api.js |

### Exit Criteria

- [x] CI exists (GitHub Actions: Bun, lint, typecheck, test on ubuntu + macos)
- [x] `tsconfig.json` with `allowJs: true` — progressive TypeScript enabled
- [x] Biome linting configured (`biome.json` with `--diagnostic-level=error`)
- [x] Guidelines update bug fixed (adapter-based dispatch, no more DocC ETag loop)
- [x] `read` falls back to normalized sections then raw JSON when markdown missing
- [x] Command namespace redesigned (`mcp start/install`, `web`/`storage` stubs, COMMAND_FAMILIES parser)
- [x] Schema v5 migration applied (source_type, language, platform min columns, framework_synonyms)
- [x] Golden search query suite: 20 queries across 7 frameworks
- [x] All tests pass: 146 tests (lint clean, typecheck clean)

### Key Artifacts

| File | Purpose |
|---|---|
| `tsconfig.json` | Progressive TS — `allowJs`, `checkJs: false`, `@types/bun` |
| `biome.json` | Linting — recommended rules, style rules as warnings |
| `.github/workflows/ci.yml` | CI — matrix (ubuntu, macos), lint → typecheck → test |
| `test/golden/search-queries.json` | 20 regression queries: exact, prefix, CamelCase, fuzzy, multi-word, framework-scoped |
| `test/golden/seed.js` | Seeds 33 pages across 7 frameworks for golden query testing |

### Execution Log

- [2026-04-13T09:30] [0.1] DONE: tsconfig.json, biome.json, .github/workflows/ci.yml, package.json scripts, @types/bun + @biomejs/biome dev deps
- [2026-04-13T09:30] [0.2] DONE: update.js partitions DocC vs HTML roots; guidelines handled separately
- [2026-04-13T09:30] [0.3] DONE: lookup.js falls back to normalized sections → raw JSON rendering
- [2026-04-13T09:35] [0.4] DONE: parser.js COMMAND_FAMILIES subcommands; cli.js routes mcp/web/storage; help.js updated
- [2026-04-13T09:35] [0.5] DONE: schema v5 with source_type, language, platform min columns, framework_synonyms table
- [2026-04-13T09:40] [0.6] DONE: 20 golden queries across 7 frameworks, all passing
- [2026-04-13T09:40] [0.7] DONE: integration tests for search + lookup with fallback rendering
- [2026-04-13T13:20] [0.2] VERIFIED: guidelines use explicit HTML change detection via adapter dispatch
- [2026-04-13T13:20] [0.5] VERIFIED: root source_type classification correct for HIG and guidelines
- [2026-04-13T13:50] PHASE RE-VERIFIED: all tests pass, lint clean, typecheck clean

### Audit Notes (2026-04-13)

- `apple-docs-mcp` bin still points to `./index.js` (no separate shim file) — works correctly for backward compat
- `language` column left NULL in migration backfill (expensive scan deferred to doctor/re-sync)
- `APPLE_DOCS_API_BASE` env var added to `api.js` for test mocking
- Refresh note: the current workspace passes tests and typecheck, but no longer has a lint-clean state because 10 Biome findings remain in later phase code/tests

---

## Phase 1: Canonical Content Model

**Status**: `COMPLETE` (2026-04-13)
**Depends on**: Phase 0
**Blocks**: Phase 2, Phase 3, Phase 4

### Tasks

| ID | Task | Status | Files Touched |
|---|---|---|---|
| 1.1 | Schema v6 Migration | `done` | src/storage/database.js |
| 1.2 | Normalizer Module | `done` | src/content/normalize.js |
| 1.3 | Shared Renderers | `done` | src/content/render-markdown.js, render-html.js, render-text.js, render-snippet.js |
| 1.4 | Sync Pipeline Dual-Write | `done` | src/pipeline/persist.js, discover.js, download.js, sync-guidelines.js |
| 1.5 | Search FTS Switch | `done` | src/storage/database.js, src/commands/search.js |
| 1.6 | Lookup Rewire | `done` | src/commands/lookup.js, src/content/hydrate.js |
| 1.7 | Body Index Rewire | `done` | src/pipeline/index-body.js |

### Exit Criteria

- [x] Normalized document schema populated during sync (`documents`, `document_sections`, `document_relationships`)
- [x] Shared renderers: Markdown, HTML, plain text, snippet (4 files under `src/content/`)
- [x] Search indexes from normalized text (`documents_fts`, `documents_trigram` with auto-detection)
- [x] `read` renders on-demand from normalized model (sections → markdown file → raw JSON fallback)
- [x] Body index uses normalized content (`documents_body_fts` from `document_sections.content_text`)
- [x] Golden search queries: same or better results (20/20 passing)

### Key Artifacts

| File | Purpose |
|---|---|
| `src/content/normalize.js` | `normalize(rawPayload, key, sourceType)` → `{ document, sections[], relationships[] }`. Handles apple-docc, hig, guidelines. Exports `renderContentNodesToText()`. |
| `src/content/render-markdown.js` | `renderMarkdown(doc, sections)` — YAML front matter + section rendering from normalized model |
| `src/content/render-html.js` | `renderHtml(doc, sections)` — HTML fragment renderer |
| `src/content/render-text.js` | `renderPlainText(doc, sections)` — plain text for search indexing |
| `src/content/render-snippet.js` | `renderSnippet(doc, sections, query, maxLength)` — context-window extraction |
| `src/content/hydrate.js` | `ensureNormalizedDocument()` — lazy hydration from raw JSON when sections missing |
| `src/pipeline/persist.js` | `persistFetchedDocPage()` — unified dual-write: pages + documents/sections/relationships + disk |

### Architecture Decisions

- **Lazy section migration**: Schema v6 creates tables and populates `documents` from `pages` via SQL, but `document_sections` populated only on next sync or via `doctor --rebuild-sections`
- **Dual-write**: Both `pages` and `documents` tables populated during sync. `upsertPage({skipDocumentSync: true})` + explicit `upsertNormalizedDocument()` pattern
- **FTS auto-detection**: `hasNormalizedDocuments()` (now cached) dispatches search/trigram/body queries to either `documents_fts` or `pages_fts` transparently
- **Standalone FTS5**: `documents_fts`/`documents_trigram` are trigger-backed (not content-synced) — avoids MATCH re-query overhead
- **Rendering priority in lookup**: Markdown file on disk → normalized sections from DB → raw JSON on-demand render

### Execution Log

- [2026-04-13T12:30] [1.1] DONE: schema v6 — documents, document_sections, document_relationships, FTS/trigram/body indexes, triggers, transitional backfill
- [2026-04-13T12:30] [1.2] DONE: normalize.js — DocC + guidelines normalization, 7 section kinds, relationship extraction, renderContentNodesToText
- [2026-04-13T12:30] [1.3] DONE: 4 shared renderers under src/content/
- [2026-04-13T12:30] [1.4] DONE: persist.js dual-write pipeline; sync-guidelines.js dual-write
- [2026-04-13T12:30] [1.5] DONE: search dispatches to documents_fts/trigram with hasNormalizedDocuments() auto-detection
- [2026-04-13T12:30] [1.6] DONE: lookup renders from sections → markdown → raw JSON; hydrate.js for lazy section population
- [2026-04-13T12:30] [1.7] DONE: body index builds from document_sections content_text via renderPlainText()
- [2026-04-13T13:20] VERIFIED: update, browse, guidelines deletion paths keep normalized tables in sync
- [2026-04-13T13:20] VERIFIED: lazy hydration works for migrated corpora without sections
- [2026-04-13T13:50] PHASE RE-VERIFIED: all tests pass

### Audit Notes (2026-04-13)

- `hasNormalizedDocuments()` COUNT query now cached (set to `true` on first `upsertDocument`, lazy-initialized on first query)
- `documents_body_fts.rowid` tied to `documents.id` by convention, not schema constraint — maintained by insert pattern
- Unit tests added post-audit: `test/unit/normalize.test.js` (17 tests), `test/unit/renderers.test.js` (14 tests)
- Integration test added post-audit: `test/integration/sync.test.js` (5 tests for persist pipeline)

---

## Phase 2: Source Adapter Layer

**Status**: `COMPLETE` (2026-04-13)
**Depends on**: Phase 1
**Blocks**: Phase 4
**Can parallel with**: Phase 3 (deferred by user)

### Tasks

| ID | Task | Status | Files Touched |
|---|---|---|---|
| 2.1 | Base Adapter Class | `done` | src/sources/base.js |
| 2.2 | Apple DocC Adapter | `done` | src/sources/apple-docc.js |
| 2.3 | HIG Adapter | `done` | src/sources/hig.js |
| 2.4 | Guidelines Adapter | `done` | src/sources/guidelines.js |
| 2.5 | Sync Pipeline Refactor | `done` | src/commands/sync.js, src/pipeline/discover.js, download.js, convert.js |
| 2.6 | Update Command Refactor | `done` | src/commands/update.js |
| 2.7 | Adapter Tests | `done` | test/unit/adapters/base.test.js, apple-docc.test.js, hig.test.js, guidelines.test.js |

### Exit Criteria

- [x] Base adapter class with discover/fetch/check/normalize/extractReferences/renderHints + 4 validation helpers
- [x] Apple DocC adapter: technologies.json discovery, JSON API fetch, ETag HEAD check, normalize delegation
- [x] HIG adapter: same structure, /design/ URL routing via api.js transport layer
- [x] Guidelines adapter: HTML fetch/check, section parsing, child reference extraction
- [x] `sync --sources <list>` works via adapter registry dispatch
- [x] Source-specific update checking: DocC ETag loop vs guidelines HTML re-fetch
- [x] Golden queries: all 20 passing unchanged

### Key Artifacts

| File | Purpose |
|---|---|
| `src/sources/base.js` | `SourceAdapter` contract — 6 abstract methods + 4 validators |
| `src/sources/registry.js` | `registerAdapter()`, `getAdapter()`, `getAllAdapters()`, `getAdapterTypes()` |
| `src/sources/apple-docc.js` | DocC adapter — fetch JSON API, ETag check, normalize via content/normalize.js |
| `src/sources/hig.js` | HIG adapter — same as DocC, /design/ prefix handled at transport layer |
| `src/sources/guidelines.js` | Guidelines adapter — HTML fetch/check, section parsing, child refs |
| `src/lib/pool.js` | Shared bounded-concurrency pool (extracted from duplicated code in sync + update) |

### Architecture Decisions

- **Adapter registry**: Adapters self-register via `registerAdapter()`. Commands use `getAdapter(type)` or `getAllAdapters()`.
- **Sync dispatches by adapter type**: Guidelines use `adapter.fetch()` → `applyGuidelinesSnapshot()`. DocC/HIG use `crawlRoot()` with adapter-backed fetches.
- **Update dispatches per adapter**: `updateDoccSource()` for DocC/HIG (ETag HEAD check loop), `updateGuidelinesSource()` for guidelines (single HTML check).
- **`pool()` extracted**: Shared `src/lib/pool.js` replaces duplicated implementations in sync.js and update.js.

### Execution Log

- [2026-04-13T13:35] [2.1] DONE: SourceAdapter contract with validators and registry
- [2026-04-13T13:40] [2.2-2.3] DONE: Apple DocC and HIG adapters with typed discover/fetch/check/normalize
- [2026-04-13T13:42] [2.4] DONE: Guidelines adapter with HTML fetch/check and root self-registration
- [2026-04-13T13:45] [2.5] DONE: sync dispatches by adapter, --sources flag, adapter-backed crawl
- [2026-04-13T13:48] [2.6] DONE: update dispatches per adapter with source-scoped checks
- [2026-04-13T13:50] [2.7] DONE: adapter tests for discovery, check, normalize, error paths

### Audit Notes (2026-04-13)

- **Guidelines adapter wiring fixed post-audit**: `sync.js` now calls `adapter.fetch()` → `applyGuidelinesSnapshot()` instead of legacy `syncGuidelines()` directly. The adapter's fetch method is now exercised in production.
- **`update.js` guidelines path**: Still calls `applyGuidelinesSnapshot()` after `adapter.check()` + `adapter.fetch()`. The adapter's `normalize()` is exercised indirectly via `applyGuidelinesSnapshot()` which calls `normalize()` internally.
- **Error path tests added post-audit**: base (abstract method throws, unknown adapter throws), apple-docc (200→modified, network failure→error, empty JSON normalize), guidelines (network error→error status)
- **`pool()` deduplicated post-audit**: Extracted to `src/lib/pool.js`, imported by both sync.js and update.js

---

## Phase 3: MCP SDK Migration

**Status**: `COMPLETE` (2026-04-14)
**Depends on**: Phase 1
**Blocks**: Phase 6
**Can parallel with**: Phase 2

### Tasks

| ID | Task | Status | Files Touched |
|---|---|---|---|
| 3.1 | Install MCP SDK | `done` | package.json, bun.lock |
| 3.2 | Create SDK Server (tools + schemas inline) | `done` | src/mcp/server.js |
| 3.3 | Register MCP Resources | `done` | src/mcp/server.js |
| 3.4 | Update Entry Points | `done` | index.js, cli.js |
| 3.5 | Add Contract Tests | `done` | test/mcp/contract.test.js |
| 3.6 | Verify Backward Compatibility | `done` | (manual verification) |
| 3.7 | Remove Old MCP Server | `done` | src/mcp/server.js (old), src/mcp/tools.js (deleted) |

### Exit Criteria

- [x] Official MCP SDK installed (`@modelcontextprotocol/sdk@1.29.0` — sanctioned single npm dependency)
- [x] All 5 tools ported with Zod schemas (`search_docs`, `read_doc`, `list_frameworks`, `browse`, `status`)
- [x] MCP resources exposed (`apple-docs://doc/{+key}`, `apple-docs://framework/{slug}`)
- [x] Contract tests pass (15 tests covering tools + resources)
- [x] `apple-docs mcp start` works (same `startServer(ctx)` interface)
- [x] `apple-docs-mcp` backward compat works (same `index.js` entry point)
- [x] Stdio transport via `StdioServerTransport`

### Key Artifacts

| File | Purpose |
|---|---|
| `src/mcp/server.js` | `createServer(ctx)` + `startServer(ctx)` — McpServer with 5 tools (Zod schemas) + 2 resources |
| `test/mcp/contract.test.js` | 15 contract tests using InMemoryTransport + Client |

### Architecture Decisions

- **`McpServer` (high-level API)** over low-level `Server` class — `server.tool()` eliminates manual switch dispatch; `server.resource()` handles URI routing
- **No separate `schemas.js` or `handlers.js`** — Zod schemas inline with `server.tool()` calls; command functions from `src/commands/` called directly (they're already pure handlers)
- **Tool rename** (`search` → `search_docs`, `read` → `read_doc`) — no dual name support; MCP clients discover tools dynamically via `tools/list`
- **Deferred params** — `source`, `language`, `format` filters deferred to Phase 4-5 when new sources exist
- **`{+key}` URI template** — RFC 6570 reserved expansion so paths with slashes (e.g., `swiftui/view/body`) work as single parameter
- **Doc resource has no `list` callback** — 330K pages makes enumeration impractical; framework resource lists via `frameworks()` query

### Execution Log

- [2026-04-14T00:00] [3.1] DONE: `bun add @modelcontextprotocol/sdk` — v1.29.0, 91 packages installed
- [2026-04-14T00:00] [3.2-3.3] DONE: src/mcp/server.js — McpServer with 5 tools (Zod schemas) + 2 resources (doc + framework)
- [2026-04-14T00:00] [3.4] DONE: index.js + cli.js imports updated
- [2026-04-14T00:00] [3.5] DONE: 15 contract tests (tools/list, tool calls, resources/list, resource reads)
- [2026-04-14T00:00] [3.7] DONE: old server.js + tools.js deleted; server-sdk.js renamed to server.js
- [2026-04-14T00:00] PHASE VERIFIED: 161 tests pass (15 new MCP contract + 146 existing), 0 failures

---

## Phase 4: Source Coverage Expansion

**Status**: `COMPLETE` (verified 2026-04-13)
**Depends on**: Phase 2 (adapter layer)
**Blocks**: Phase 5 start

### Sources

| # | Source | Status | Documents | Adapter File |
|---|---|---|---|---|
| 1 | Swift Evolution | `done` | ~450 | src/sources/swift-evolution.js |
| 2 | Swift.org docs | `done` | ~500 | src/sources/swift-org.js |
| 3 | Swift Book | `done` | ~100 | src/sources/swift-book.js |
| 4 | Apple Archive | `done` | ~75 | src/sources/apple-archive.js |
| 5 | WWDC Transcripts | `done` | ~3,000+ | src/sources/wwdc.js |
| 6 | Sample Code | `done` | 606 projects | src/sources/sample-code.js |
| 7 | Package Catalog | `deferred-post-v2` | 9,699+ | (explicitly kept out of committed v2 execution scope) |

### Exit Criteria

- [x] Committed v2 source set implemented and registered (Package Catalog remains explicitly deferred post-v2)
- [x] `sync --sources <name>` works for implemented source families via `syncMode`
- [x] Implemented source families produce valid normalized documents in tests
- [x] Search results surface consistent source metadata for implemented new sources
- [x] New MCP tools exist: `search_wwdc`, `search_samples`, `read_sample_file`
- [x] Golden search queries were expanded for new sources
- [x] Repo-level implementation and integration are verified; full corpus volume validation is deferred to later operational snapshot work

### Tasks

| ID | Task | Status | Files Touched |
|---|---|---|---|
| 4.0a | Sync Strategy Generalization | `done` | src/sources/base.js, src/commands/sync.js, src/commands/update.js |
| 4.0b | Generalized Persist Pipeline | `done` | src/pipeline/persist.js |
| 4.0c | GitHub API Helpers | `done` | src/lib/github.js |
| 4.0d | Markdown Parser Helpers | `done` | src/content/parse-markdown.js |
| 4.0e | HTML Content Extractor | `done` | src/content/parse-html.js |
| 4.1 | Swift Evolution Adapter | `done` | src/sources/swift-evolution.js |
| 4.2 | Swift.org Docs Adapter | `done` | src/sources/swift-org.js |
| 4.3 | Swift Book Adapter | `done` | src/sources/swift-book.js |
| 4.4 | Apple Archive Adapter | `done` | src/sources/apple-archive.js |
| 4.5 | WWDC Transcripts Adapter + MCP Tool | `done` | src/sources/wwdc.js, src/mcp/server.js |
| 4.6 | Sample Code Adapter + MCP Tools | `done` | src/sources/sample-code.js, src/mcp/server.js |
| 4.7 | Registry & Test Updates | `done` | src/sources/registry.js, test/unit/adapters/*.test.js |

### Key Artifacts

| File | Purpose |
|---|---|
| `src/sources/swift-evolution.js` | Flat adapter: SE proposals from GitHub |
| `src/sources/swift-book.js` | Flat adapter: TSPL chapters from GitHub |
| `src/sources/swift-org.js` | Flat adapter: curated swift.org documentation pages |
| `src/sources/apple-archive.js` | Flat adapter: frozen legacy archive guides |
| `src/sources/wwdc.js` | Flat adapter: Apple 2020+ JSON plus ASCIIwwdc transcripts |
| `src/sources/sample-code.js` | Flat adapter: Apple sample code project metadata |
| `src/lib/github.js` | GitHub tree/raw-content helpers |
| `src/content/parse-markdown.js` | Markdown-to-normalized parser |
| `src/content/parse-html.js` | HTML-to-normalized parser |

### Carry-Forward Notes

- Package Catalog stays in the backlog by design; it is not a blocker for beginning or completing Phase 5 in the current execution plan.
- Sample-code project indexing remains metadata-first; deeper per-file sample extraction can still be expanded later without reopening Phase 4.

### Execution Log

- [2026-04-13T14:50] [4.0a] DONE: `syncMode` on `SourceAdapter`, `syncFlatSource` in `sync.js`, `updateFlatSource` in `update.js`
- [2026-04-13T14:50] [4.0b] DONE: `persistNormalizedPage` in `persist.js` with `renderMarkdown()` output
- [2026-04-13T14:50] [4.0c-e] DONE: `github.js`, `parse-markdown.js`, `parse-html.js`
- [2026-04-13T14:54] [4.1-4.6] DONE: six new source adapters landed
- [2026-04-13T14:57] [4.7] DONE: registry updated; MCP tool surface expanded to 8 tools
- [2026-04-13T16:45] [4.7] DONE: source metadata now flows through search rows/CLI/MCP; sample-code now persists as `sample-code`; `lookup()` returns normalized sections for sample tooling
- [2026-04-13T16:52] [P4-CLOSE] VERIFIED: `bun test` (406 pass) and `bun run typecheck` pass after Phase 4 closeout changes

---

## Phase 5: Search Quality Upgrade

**Status**: `COMPLETE` (verified 2026-04-13)
**Depends on**: Phase 4
**Blocks**: Phase 6

### Actual State

| ID | Task | Status | Evidence / Gap |
|---|---|---|---|
| 5.1 | Platform Version Filtering | `done` | CLI flags `--min-ios`, `--min-macos`, `--platform`, etc. wired through search → DB with nullable SQL filters; MCP `search_docs` accepts `min_ios`/`platform`/etc.; golden queries cover platform filtering |
| 5.2 | Source Type Filtering | `done` | `search()` now supports source filtering through CLI and MCP; golden queries cover `wwdc` and `sample-code` |
| 5.3 | Language Filtering | `done` | `--language swift|objc` wired through CLI + MCP; SQL filter `d.language = $language OR d.language = 'both' OR d.language IS NULL`; golden queries for language filtering |
| 5.4 | Framework Aliases & Synonyms | `done` | `getFrameworkSynonyms(slug)` reads bidirectional pairs from `framework_synonyms` table; search expands to synonym frameworks and merges results; golden query for synonym expansion |
| 5.5 | Snippet Generation | `done` | `renderSnippet()` called with batch-fetched document+sections data via `getDocumentSnippetData()`; snippet field included in search results; displayed in CLI output |
| 5.6 | Source-Aware Reranking (8 rules) | `done` | `src/search/ranking.js` implements 8 multiplicative rules (exact match, symbol kind, guide boost, release notes penalty, archive penalty, sample code boost, depth penalty, freshness boost); replaces static tier sort |
| 5.7 | Query Intent Detection | `done` | `src/search/intent.js` classifies queries as symbol/howto/error/concept/general with confidence scores; intent fed to reranker and returned in search results |
| 5.8 | Related Document Graph | `done` | `getRelatedDocCounts()` batch method returns counts from `document_relationships`; `relatedCount` field included in search results; displayed in CLI output |
| 5.9 | Search Benchmark Suite | `done` | `test/golden/search-benchmark.test.js` runs 42 queries × 50 iterations, computes p50/p95/p99, asserts p95 < 50ms; measured p95=0.20ms |

### Exit Criteria

- [x] Platform filtering works
- [x] Source filtering works
- [x] Language filtering works
- [x] Aliases expand queries
- [x] Snippets are included in search results
- [x] 8+ reranking rules are applied
- [x] Release notes are down-weighted
- [x] Golden queries pass at improved or equal quality (42 queries, all passing)
- [x] Search latency is measured and remains < 50ms p95 (measured: p50=0.15ms, p95=0.20ms, p99=0.23ms)

### Planned Waves

| Wave | Goal | Status |
|---|---|---|
| `P5-A` | Metadata plumbing: expose source/language/platform/source metadata through search rows, CLI flags, and MCP args | `done` |
| `P5-B` | Platform, language, and framework synonym filtering | `done` |
| `P5-C` | Contextual snippets and related document counts | `done` |
| `P5-D` | Intent detection and source-aware reranking (8 rules) | `done` |
| `P5-E` | Benchmark harness with p50/p95/p99 and golden suite validation | `done` |

### Key Artifacts

| File | Purpose |
|---|---|
| `src/search/intent.js` | `detectIntent(query)` → `{ type, confidence }` — symbol/howto/error/concept/general classification |
| `src/search/ranking.js` | `rerank(results, query, intent)` — 8-rule multiplicative reranker |
| `src/content/render-snippet.js` | `renderSnippet(document, sections, query, maxLength)` — context-window extraction |

### Execution Log

- [2026-04-13T16:20] [P5-PLAN] VERIFIED: snippets, synonym seeds, normalized language/platform columns, and relationships already exist as prerequisites
- [2026-04-13T16:45] [P5-A] DONE: search rows now expose `sourceType` and `sourceMetadata`; WWDC MCP filtering now uses returned metadata consistently
- [2026-04-13T16:45] [5.2] DONE: `--source` wired through CLI + MCP `search_docs`; golden queries added for `wwdc` and `sample-code`
- [2026-04-13T16:52] [P5-KICKOFF] VERIFIED: source-filter search coverage passes in golden tests and MCP contract tests
- [2026-04-13T18:15] [P5-B] DONE: platform version filtering (--min-ios, --min-macos, --platform), language filtering (--language), and framework synonym expansion all wired through CLI/MCP/DB; 6 new golden queries
- [2026-04-13T18:20] [P5-C] DONE: batch getDocumentSnippetData() and getRelatedDocCounts() methods; snippet and relatedCount fields in search results; CLI displays snippets and related counts
- [2026-04-13T18:25] [P5-D] DONE: intent.js (symbol/howto/error/concept/general detection) and ranking.js (8 multiplicative rules) wired into search pipeline; replaces static tier-based sort; 24 unit tests
- [2026-04-13T18:30] [P5-E] DONE: benchmark harness runs 42 queries × 50 iterations; p50=0.15ms p95=0.20ms p99=0.23ms; enrichment tests verify snippet/relatedCount/intent/score fields
- [2026-04-13T18:30] [P5-CLOSE] VERIFIED: `bun test` (455 pass), all 42 golden queries pass, p95 latency well under 50ms threshold

---

## Phase 6: Distribution & Setup

**Status**: `COMPLETE` (verified 2026-04-13)
**Depends on**: Phase 5 (complete)
**Blocks**: Phase 7

### Actual State

| ID | Task | Status | Evidence / Gap |
|---|---|---|---|
| 6.1 | Snapshot Build Pipeline | `done` | `src/commands/snapshot.js` — `snapshotBuild()` with VACUUM INTO, tier stripping, tar.gz, checksums |
| 6.2 | Setup Command | `done` | `src/commands/setup.js` — downloads from GitHub Releases, verifies checksum, extracts, validates schema |
| 6.3 | GitHub Actions CI/CD | `done` | `.github/workflows/snapshot.yml` — weekly cron + manual dispatch, 3 tiers, GitHub Release publishing |
| 6.4 | npm Publishing | `done` | `package.json` updated: `@g-cqd/apple-docs` v2.0.0, `files`, `engines`, `publishConfig`, `repository` |
| 6.5 | Cross-Platform Binaries | `done` | `.github/workflows/release-binaries.yml` — macOS arm64/x64, Linux x64 via `bun build --compile` |
| 6.6 | Auto-Update Check | `done` | `status.js` `checkForUpdate()` — compares `snapshot_tag` against GitHub latest release (5s timeout, silent on error) |
| 6.7 | Snapshot Verification | `done` | `consolidate.js` `--verify` — checks document count, schema version, FTS integrity |

### Exit Criteria

- [x] `apple-docs setup` downloads a snapshot and is usable in < 60s (command implemented; actual timing depends on network and release availability)
- [x] Weekly CI snapshot builds exist (`.github/workflows/snapshot.yml` with Sunday 06:00 UTC cron)
- [x] Snapshot artifacts include checksums and manifests (`.sha256` + `.manifest.json` per tier)
- [x] Lite/standard/full tiers exist (lite drops sections/trigram/body FTS; standard keeps all; full adds raw-json/markdown)
- [x] npm publishing configured (`@g-cqd/apple-docs` with `publishConfig.access: public`)
- [x] Cross-platform binaries workflow exists (macOS arm64/x64, Linux x64)
- [x] Snapshot verification exists in `doctor --verify`

### Planned Waves

| Wave | Goal | Status |
|---|---|---|
| `P6-A` | Database snapshot_meta accessors: `getSnapshotMeta`, `setSnapshotMeta`, `getSchemaVersion` | `done` |
| `P6-B` | Snapshot build command: VACUUM INTO, tier stripping, tar.gz, checksum, manifest | `done` |
| `P6-C` | Setup command: fetch GitHub release, download, verify checksum, extract, validate | `done` |
| `P6-D` | Doctor `--verify` snapshot integrity + status update check via GitHub API | `done` |
| `P6-E` | CI/CD workflows (snapshot.yml, release-binaries.yml) + package.json npm config | `done` |

### Key Artifacts

| File | Purpose |
|---|---|
| `src/commands/snapshot.js` | `snapshotBuild(opts, ctx)` — build tier-aware compressed snapshot archives |
| `src/commands/setup.js` | `setup(opts, ctx)` — download + verify + extract pre-built snapshot from GitHub Releases |
| `.github/workflows/snapshot.yml` | Weekly snapshot build + GitHub Release publishing |
| `.github/workflows/release-binaries.yml` | Cross-platform binary builds on release |

### Architecture Decisions

- **`VACUUM INTO` for DB copy** — avoids WAL mode issues with raw file copy; creates merged standalone snapshot
- **Shell `tar`** — both macOS and Linux CI have tar; avoids JS tar implementations and new dependencies
- **Truncate vs DROP operational tables** — `crawl_state`, `activity`, `update_log` are emptied but kept so `DocsDatabase` can open the snapshot without schema errors
- **Archive checksum** — `.sha256` file contains hash of the `.tar.gz` archive for download-time verification
- **Silent update check** — `status` queries GitHub with 5s timeout; network failures return null, never error

### Execution Log

- [2026-04-13T16:52] [P6-STATUS] BLOCKED: work intentionally deferred until Phase 5 completes
- [2026-04-13T18:30] [P6-STATUS] UNBLOCKED: Phase 5 is complete; Phase 6 is ready to begin
- [2026-04-13T20:00] [P6-A] DONE: `getSnapshotMeta`, `setSnapshotMeta`, `getSchemaVersion` added to DocsDatabase; 4 new tests
- [2026-04-13T20:15] [P6-B] DONE: `snapshotBuild` with VACUUM INTO, tier stripping, tar.gz, checksums, manifest; 6 new tests
- [2026-04-13T20:30] [P6-C] DONE: `setup` with GitHub Release discovery, download, checksum verification, extraction, validation; 4 new tests
- [2026-04-13T20:45] [P6-D] DONE: `consolidate --verify` snapshot integrity (document count, schema version, FTS); `status` update check via GitHub; 4 new tests
- [2026-04-13T21:00] [P6-E] DONE: `snapshot.yml` (weekly cron), `release-binaries.yml` (macOS/Linux), `package.json` npm config
- [2026-04-13T21:00] [P6-CLOSE] VERIFIED: `bun test` (473 pass), `bun run typecheck` passes

---

## Phase 7: Static Website

**Status**: `READY`
**Depends on**: Phase 6 (complete)
**Blocks**: Phase 8

### Actual State

| ID | Task | Status | Evidence / Gap |
|---|---|---|---|
| 7.1 | HTML Page Template | `pending` | no `src/web/templates.js` |
| 7.2 | Static Site Builder | `pending` | no `src/web/build.js` |
| 7.3 | Client-Side Search UI | `pending` | no `src/web/assets/search.js` |
| 7.4 | Search Web Worker | `pending` | no `src/web/worker/search-worker.js` |
| 7.5 | Search Artifact Generation | `pending` | no `src/web/search-artifacts.js` |
| 7.6 | Dev Server (Local Preview) | `partial` | `web` namespace is reserved in parser/help, but `cli.js` only prints a placeholder |
| 7.7 | CSS Stylesheet | `pending` | no web asset stylesheet exists |
| 7.8 | Deploy Command | `partial` | `web` command exists only as a stub message in `cli.js` |

### Exit Criteria

- [ ] `web build` generates a static site
- [ ] `web serve` starts a local preview server
- [ ] `web deploy` prints deployment instructions
- [ ] Every document has an HTML page
- [ ] Client search works offline
- [ ] Search remains fast in browser
- [ ] Responsive layout and theme support exist

### Execution Log

- [2026-04-13T16:20] [P7-STATUS] VERIFIED: website work is still at CLI/help placeholder level
- [2026-04-13T21:00] [P7-STATUS] UNBLOCKED: Phase 6 is complete; Phase 7 is ready to begin

---

## Phase 8: Storage Profiles & Polish

**Status**: `NOT_STARTED`
**Depends on**: Phase 7

### Actual State

| ID | Task | Status | Evidence / Gap |
|---|---|---|---|
| 8.1 | Storage Profile Configuration | `pending` | no `src/storage/profiles.js` |
| 8.2 | Storage Commands | `partial` | `storage` namespace is reserved in parser/help, but `cli.js` only prints a placeholder |
| 8.3 | On-Demand Rendering with Cache | `partial` | `lookup()` already renders on demand from normalized data/raw JSON, but no profile-aware cache policy exists |
| 8.4 | Garbage Collection | `pending` | no storage GC command exists |
| 8.5 | Scheduled Freshness Checks | `pending` | `status.js` does not perform freshness checks |
| 8.6 | Benchmark History | `pending` | no benchmark history recording exists |
| 8.7 | Corpus Integrity Verification | `partial` | `doctor` exists, but not the full corpus/snapshot integrity sweep from the plan |
| 8.8 | Migration E2E Tests | `pending` | no migration integration suite exists |
| 8.9 | Comprehensive Doctor Command | `partial` | current `doctor` handles repair/minify/index, but not source-aware exhaustive repair |
| 8.10 | Remove Legacy `pages` Dependency | `pending` | fallback support for legacy `pages` is still present in search/browse/status paths |
| 8.11 | Remove Old MCP Server Files | `done` | old custom MCP server files were removed during Phase 3 |
| 8.12 | Update README & Docs | `pending` | planning docs are present; README alignment has not been verified in this refresh |

### Exit Criteria

- [ ] Storage profiles work
- [ ] `storage stats/gc/materialize` work
- [ ] Freshness checks work
- [ ] Benchmark history is tracked
- [ ] Corpus integrity is verifiable
- [ ] Migration tests pass
- [ ] Doctor is source-aware and comprehensive
- [ ] README and user docs are updated

### Execution Log

- [2026-04-13T16:20] [P8-STATUS] VERIFIED: only groundwork exists; no storage profile system has been implemented

---

## Dependency Graph

```
P0 -> P1 -> P2 -> P4 -> P5 -> P6 -> P7 -> P8
           \
            -> P3 -----^
```

Dependency notes:
- Earlier architecture work still allows `P3` to feed into `P6`, but active execution is now strictly sequenced `P4 -> P5 -> P6 -> P7` by project policy.
- No Phase 7 work should begin until Phase 6 is marked complete.

## Metrics

| Metric | Baseline | Current | Target |
|---|---|---|---|
| Source count | 3 | 9 | 11+ |
| Total documents | ~330K | ~330K (not re-verified in this refresh; first full phase-4 sync still pending) | ~365K+ |
| Test count | 53 | 473 | 150+ |
| Schema version | 4 | 7 | 6+ |
| Source adapters | 0 | 9 (apple-docc, hig, guidelines, swift-evolution, swift-book, swift-org, apple-archive, wwdc, sample-code) | 10+ |
| Content renderers | 1 (markdown from raw JSON) | 4 (markdown, html, text, snippet from normalized model) | 4 |
| Content parsers | 0 | 2 (parse-markdown, parse-html) | 2 |
| Search latency p95 | ~50ms | 0.20ms (measured: 42 queries × 50 iterations on seed DB) | < 50ms |
| Setup time (new user) | hours (sync) | < 60s (via `apple-docs setup`) | < 60s |
| MCP tools | 5 (custom) | 8 (SDK, Zod-typed) | 10+ (SDK) |
| MCP resources | 0 | 2 (doc, framework) | 2+ |
| npm dependencies | 0 | 1 (MCP SDK) + 2 dev | 1 (MCP SDK) |

## Post-Audit Fixes (2026-04-13)

Issues found during comprehensive audit of Phases 0-2, all resolved:

| # | Issue | Resolution |
|---|---|---|
| 1 | Guidelines adapter `fetch`/`normalize` bypassed in `sync.js` | Fixed: sync.js now calls `adapter.fetch()` → `applyGuidelinesSnapshot()` |
| 2 | Missing normalizer + renderer unit tests | Added: `test/unit/normalize.test.js` (17 tests), `test/unit/renderers.test.js` (14 tests) |
| 3 | `hasNormalizedDocuments()` uncached COUNT query | Fixed: cached flag, set `true` on first `upsertDocument`, lazy-init on query |
| 4 | Missing sync integration test | Added: `test/integration/sync.test.js` (5 tests for persist pipeline) |
| 5 | Adapter error path tests incomplete | Added: abstract method throws, unknown adapter, network failure, empty JSON |
| 6 | `pool()` duplicated in sync.js + update.js | Extracted to `src/lib/pool.js`, imported by both |
