# apple-docs v2 — Consolidated Implementation Plan

> **Goal**: Transform apple-docs into the most complete, reliable, cross-platform on-device Apple knowledge base — surpassing every competitor in source breadth, search quality, distribution, and output formats.

## Strategic Position

| Dimension | Current State | Target State |
|---|---|---|
| **Sources** | 3 (Apple DocC, HIG, App Store Review) | 11+ (+ Swift Evolution, Swift.org, Swift Book, Apple Archive, WWDC, Sample Code, Packages) |
| **Documents** | ~330K pages | ~365K+ documents across all sources |
| **Search** | FTS5 + trigram + Levenshtein + body | + platform/source/language filters, aliases, snippets, reranking |
| **MCP** | Custom JSON-RPC | Official TypeScript SDK with typed tools and resources |
| **Distribution** | Manual `sync` (hours) | `setup` command (<60s), pre-built snapshots, npm, binaries |
| **Output** | CLI + MCP | + deployable static website with client-side search |
| **Storage** | Mandatory JSON + Markdown | Configurable profiles (raw-only / balanced / prebuilt) |
| **Platform** | Bun/JS (cross-platform) | Same — permanent advantage over macOS-only competitors |

## Competitive Moat

1. **Cross-platform** — Bun runtime vs cupertino's macOS-only WKWebView
2. **Zero dependencies** — No npm packages, no supply chain risk
3. **WWDC transcripts** — Blue ocean; no competitor has comprehensive coverage
4. **Static website** — Deployable docs with search; unique among MCP-capable tools
5. **Direct JSON API** — Simpler and faster than browser-based crawling
6. **Tiered search** — Most sophisticated offline search cascade in the ecosystem

## Decision Register

Disagreements between the two research efforts, resolved here:

| # | Topic | Research 1 | Research 2 | Resolution | Rationale |
|---|---|---|---|---|---|
| D-01 | MCP approach | Keep custom JSON-RPC | Migrate to official SDK | **Official SDK** | Future-proof; typed tools; transport evolution; contract tests |
| D-02 | Phase sequencing | Flat (namespace → distribution → sources → WWDC → website) | Deep (stabilize → model → adapters → MCP → sources → search → dist → web) | **Research 2's sequencing** | Normalize before expanding avoids rebuilding |
| D-03 | Source expansion timing | Jump to sources in Phase 2 | Build adapter layer first (Phase 3) | **Adapter layer first** | Each new source becomes a plugin, not a one-off pipeline |
| D-04 | Command namespace | `serve` for HTTP | `web serve/build/deploy` | **`web` namespace** | Cleaner separation; `serve` is ambiguous with MCP |
| D-05 | TypeScript | Stay pure JS | Progressive TS migration | **Progressive TS** | Type safety for normalized model; `allowJs` preserves existing code |
| D-06 | Markdown storage | Optional via `--with-markdown` flag | Storage profiles (raw-only/balanced/prebuilt) | **Storage profiles** | More granular control; explicit user intent |

## Phase Overview

```
Phase 0: Stabilize & Foundation ──────────────────── [Guardrails, namespace, schema v5]
    │
Phase 1: Canonical Content Model ─────────────────── [Normalized docs, shared renderers]
    │
    ├── Phase 2: Source Adapter Layer ─────────────── [Base contract, refactor existing 3 sources]
    │       │
    │       └── Phase 4: Source Expansion ─────────── [7 new sources, WWDC blue ocean]
    │               │
    │               └── Phase 5: Search Quality ──── [Filters, aliases, snippets, reranking]
    │
    └── Phase 3: MCP SDK Migration ───────────────── [Official SDK, typed tools, compat shim]
            │                                            ↕ (can parallel with Phase 2)
            └─────────────────────────────────────────┐
                                                      │
Phase 6: Distribution & Setup ────────────────────── [Snapshots, CI/CD, npm, setup command]
    │
Phase 7: Static Website ─────────────────────────── [web build/serve/deploy, client search]
    │
Phase 8: Storage Profiles & Polish ───────────────── [Profiles, GC, benchmarks, hardening]
                                                      ↕ (can parallel with Phase 7)

Phase 9-A: Advanced Web Search Page ─────────────── [Full-page search, faceted filters, URL state]
    ↕ (can parallel with Phase 9-B)
Phase 9-B: CLI / MCP Consolidation ──────────────── [Merge 3 MCP wrappers, add flags to core tools]

Phase 10-A: Collection Type Filters ─────────────── [Filter chips on home/framework/doc pages by type]
    ↕ (can parallel with Phase 10-B)
Phase 10-B: Page Section Navigation (TOC) ──────── [In-page TOC sidebar, section anchors, scroll tracking]
```

## Parallelization Opportunities

| Window | Parallel Tracks | Why Safe |
|---|---|---|
| After Phase 1 | Phase 2 (adapters) ‖ Phase 3 (MCP SDK) | Adapters touch pipeline/storage; MCP touches protocol layer — disjoint |
| After Phase 4 | Phase 5 (search) ‖ Phase 6 (distribution) | Search improves ranking; distribution packages artifacts — independent |
| After Phase 6 | Phase 7 (website) ‖ Phase 8 (storage) | Website reads from model; storage controls materialization — orthogonal. **Confirmed**: all Phase 8 tasks have no hard dependencies on Phase 7 outputs |
| After Phase 8 | Phase 9-A (web search) ‖ Phase 9-B (MCP consolidation) | 9-A touches web templates/routes/CSS/JS; 9-B touches MCP server/commands/CLI — disjoint file sets |
| After Phase 9 | Phase 10-A (collection filters) ‖ Phase 10-B (page TOC) | 10-A touches listing templates/collection-filters.js/CSS chips; 10-B touches document template/render-html.js/page-toc.js/CSS sidebar — disjoint functions, shared files need merge care |

## Constraints & Principles

- **C-01**: Zero npm dependencies — Bun built-ins only (bun:sqlite, HTMLRewriter, Bun.markdown, Bun.serve)
- **C-02**: Backward compatibility — existing `apple-docs-mcp` configurations must keep working
- **C-03**: Offline-first — all search and rendering works without network after sync
- **C-04**: Source payloads are canonical truth — raw JSON/HTML is always retained
- **C-05**: Markdown and HTML are materializations, not required primitives
- **C-06**: Progressive TypeScript — `allowJs`, migrate hot modules first, never block on full migration
- **C-07**: Deterministic search — no runtime model API dependencies (no OpenAI, no embeddings as primary)

## Non-Goals

- **NG-01**: Semantic/embedding search as primary — future consideration, not v2 scope
- **NG-02**: TUI interface — low ROI vs CLI + MCP + web
- **NG-03**: React/SPA frontend — static HTML with vanilla JS; no build toolchain
- **NG-04**: Xcode hidden docs — macOS-only, low priority
- **NG-05**: Package ecosystem as priority — defer after Apple-first sources
- **NG-06**: Dash docset generation — future consideration

## Success Criteria

apple-docs v2 is "more complete than concurrent projects" when ALL of these hold:

1. Broader meaningful source coverage than cupertino (11 sources vs their 8)
2. Verified offline local corpus with integrity checking
3. Official MCP SDK with typed tools and resources
4. Reproducible snapshot distribution with checksums
5. Fully static deployable website with client-side dynamic search
6. Storage profiles without mandatory Markdown duplication
7. Better cross-platform story than any Swift/macOS-only competitor
8. Search quality competitive with or better than cupertino's ranking heuristics

## Progress Tracking

Live progress is tracked in **[PROGRESS.md](./PROGRESS.md)** — phase status, task completion, exit criteria checklists, execution logs, and metrics.

## File Index

| File | Phase | Contents |
|---|---|---|
| [PROGRESS.md](./PROGRESS.md) | All | Live progress tracker with per-phase status and execution logs |
| [01-phase-0-stabilize.md](./01-phase-0-stabilize.md) | 0 | Foundation hardening, namespace, schema v5 |
| [02-phase-1-content-model.md](./02-phase-1-content-model.md) | 1 | Canonical normalized document model |
| [03-phase-2-source-adapters.md](./03-phase-2-source-adapters.md) | 2 | Source adapter layer and existing source refactor |
| [04-phase-3-mcp-upgrade.md](./04-phase-3-mcp-upgrade.md) | 3 | Official MCP SDK migration |
| [05-phase-4-source-expansion.md](./05-phase-4-source-expansion.md) | 4 | 7 new knowledge sources |
| [06-phase-5-search-quality.md](./06-phase-5-search-quality.md) | 5 | Search ranking, filters, snippets |
| [07-phase-6-distribution.md](./07-phase-6-distribution.md) | 6 | Artifact distribution, CI/CD, setup command |
| [08-phase-7-static-website.md](./08-phase-7-static-website.md) | 7 | Static site generation with client-side search |
| [09-phase-8-storage-polish.md](./09-phase-8-storage-polish.md) | 8 | Storage profiles, hardening, benchmarks |
| [10-technical-specs.md](./10-technical-specs.md) | All | Schema DDL, adapter interface, search ranking, rendering specs |
| [11-phase-9a-web-search.md](./11-phase-9a-web-search.md) | 9-A | Advanced web search page with faceted filters |
| [12-phase-9b-cli-mcp-consolidation.md](./12-phase-9b-cli-mcp-consolidation.md) | 9-B | CLI and MCP command consolidation |
| [13-phase-10a-collection-filters.md](./13-phase-10a-collection-filters.md) | 10-A | Collection type filter chips (home, framework, doc pages) |
| [14-phase-10b-page-toc.md](./14-phase-10b-page-toc.md) | 10-B | Page section navigation / table of contents sidebar |
