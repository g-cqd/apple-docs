# apple-docs v2: Research & Implementation Overview

## Executive Summary

This research documents a comprehensive analysis of the Apple Developer Documentation tooling ecosystem as of April 2026, identifies every gap between apple-docs and its competitors, and provides a detailed implementation plan to make apple-docs the most complete, trustworthy, reliable, fast, efficient, and performant tool in the space.

**Key finding:** apple-docs already has the strongest architectural foundation (zero dependencies, cross-platform via Bun, fastest crawl speed via JSON API, most sophisticated search cascade). The gaps are in **source diversity** (3 sources vs cupertino's 8), **distribution** (no pre-built databases), and **output formats** (no web interface). All gaps are closable within a 25-35 day implementation effort.

---

## Research Documents

### [01-landscape-analysis.md](01-landscape-analysis.md)
Complete map of every known project providing programmatic or offline access to Apple Developer Documentation. Covers 15+ projects across 7 categories: MCP servers (7), offline archives (3), quality tools (1), doc converters (2), CLI toolkits (1), official Apple tools (3). Includes stars, tech stacks, key features, and relevance assessment for each.

### [02-gap-analysis.md](02-gap-analysis.md)
Feature-by-feature comparison identifying every capability present in any competitor that apple-docs lacks. 30+ gaps organized by category (knowledge sources, search engine, architecture/distribution, output formats, CLI/UX) with effort estimates and priority matrix (Must Have / Should Have / Nice to Have / Future).

### [03-architecture-review.md](03-architecture-review.md)
Deep technical comparison of apple-docs's architecture vs cupertino and OxADD1. Analyzes strengths (zero-dep, tiered search, resumable ops, prepared statements), weaknesses (single-source coupling, no source abstraction), and provides specific recommendations for architectural evolution. Includes Bun technology assessment.

### [04-implementation-plan.md](04-implementation-plan.md)
6-phase implementation roadmap with code examples:
- **Phase 0:** Namespace & schema foundation (2-3 days)
- **Phase 1:** Distribution & onboarding (3-4 days) -- `setup` command, npm, CI
- **Phase 2:** Text source expansion (5-7 days) -- Swift Evolution, Swift.org, Swift Book, Apple Archive, ranking heuristics
- **Phase 3:** Code sources (5-7 days) -- Sample code, package catalog, new MCP tools
- **Phase 4:** WWDC transcripts (3-4 days) -- Blue ocean, no competitor has this comprehensively
- **Phase 5:** Static website (7-10 days) -- Browsable web UI with search

### [05-static-website.md](05-static-website.md)
Complete design for serving apple-docs as a deployable static website. Covers dev server (Bun.serve()), static build, page rendering, client-side search (tiered index loading), CSS design (light/dark mode, responsive), deployment to GitHub Pages/Cloudflare/Vercel/Docker. Performance targets and search index size analysis.

### [06-markdown-generation.md](06-markdown-generation.md)
Investigation of on-the-fly markdown rendering vs persistent file storage. Benchmarks renderPage() performance (<1ms typical, <8ms worst case). Proposes user-configurable storage with JSON-only as default (saves ~1.8 GB). Details body indexing with on-the-fly rendering and disk space management commands.

### [07-command-namespace.md](07-command-namespace.md)
Resolves the `serve` semantic conflict. `serve` -> HTTP web server. `mcp start` -> MCP stdio server. Maintains backward compatibility with `apple-docs-mcp` binary. Full command taxonomy, implementation code, help text, and migration notes.

### [08-technical-deep-dives.md](08-technical-deep-dives.md)
Detailed technical specifications for key implementation areas: Apple's JSON API surface (all endpoints, DocC JSON structure, content node types), Swift Evolution proposal parsing, HTML-to-Markdown conversion strategies, WWDC transcript sources, Swift Package Index integration, client-side search optimization, and pre-built database distribution (size estimates, compression, tiers).

---

## Strategic Position

### Where apple-docs leads today

| Advantage | Description |
|-----------|-------------|
| **Cross-platform** | Bun runs on macOS, Linux, Windows. Cupertino requires macOS 15+ |
| **Crawl speed** | Direct JSON API (hours) vs WKWebView (12+ days) |
| **Search sophistication** | 4-tier cascade: FTS5 -> trigram -> Levenshtein -> body |
| **Zero dependencies** | No npm packages, no supply chain risk |
| **CamelCase expansion** | `NavigationStack` -> "navigation" + "stack" |
| **App Store Guidelines** | Only MCP server with parsed ASRG content |
| **Doctor command** | Self-healing corpus diagnostics |

### Where apple-docs must catch up

| Gap | Severity | Effort |
|-----|----------|--------|
| Pre-built database distribution | Critical | Medium |
| Swift Evolution proposals | Critical | Low |
| Sample code indexing | Critical | Medium |
| npm publishing | High | Low |
| Platform availability filtering | High | Low-Medium |
| Swift.org documentation | High | Low-Medium |
| Swift book | High | Low |
| WWDC transcripts | High (blue ocean) | Medium |
| Package catalog | High | Medium |
| Static website | High | High |
| Ranking heuristics | Medium | Low-Medium |

### Blue ocean opportunities (no competitor has these)

1. **WWDC transcripts in MCP** -- kimsungwhee has metadata, but no one has full searchable transcripts in an MCP server
2. **Deployable static website** -- only OxADD1 has basic HTML output; a proper static site with full search would be unique
3. **On-the-fly markdown rendering** -- no competitor offers configurable storage modes
4. **Cross-platform single-binary** -- Bun's `--compile` flag gives us standalone executables for all platforms

---

## Recommended Execution Order

1. **Phase 0 + 1 first** (5-7 days): Foundation + distribution. Users can't evaluate the tool without instant setup.
2. **Phase 2 next** (5-7 days): Source expansion is the biggest perceived gap vs cupertino.
3. **Phase 4 before Phase 3** (3-4 days): WWDC transcripts are a unique differentiator; sample code is table-stakes but harder.
4. **Phase 3 then 5** (12-17 days): Sample code + packages, then static website.

**Total: 25-35 days to feature-complete v2.**
