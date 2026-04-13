# Gap Analysis: apple-docs vs All Competitors

## Detailed feature-by-feature comparison

This document identifies every capability present in any competing project that apple-docs currently lacks, ranked by impact and implementation effort.

---

## 1. Knowledge Source Gaps

### 1.1 Swift Evolution Proposals -- CRITICAL

**Who has it:** cupertino (~450 proposals), appledeepdoc (500+ proposals)
**What it is:** Markdown proposals from `swiftlang/swift-evolution` GitHub repo, each describing a language change with motivation, detailed design, and alternatives considered.
**Why it matters:** LLM agents need to understand *why* Swift APIs work the way they do. Evolution proposals explain design rationale behind `async/await`, `Sendable`, `@Observable`, etc.
**Implementation:** GitHub API to list `proposals/` directory, raw fetch of each `.md` file. Parse frontmatter for SE number, title, status, authors, Swift version. ~450 files, ~50MB.
**Effort:** Low (1-2 days). Simple HTTP fetches, no parsing complexity.

### 1.2 Official Sample Code -- CRITICAL

**Who has it:** cupertino (606 projects, 18K+ Swift files via mihaelamj/cupertino-sample-code mirror)
**What it is:** Apple's official sample code projects demonstrating framework usage. Full Xcode projects with README, Swift source, assets.
**Why it matters:** Agents answering "how do I use X?" need working code examples, not just API signatures. Sample code is the highest-value teaching material.
**Implementation:** Apple hosts sample code as downloadable archives. Cupertino maintains a GitHub mirror. Strategy: index README + Swift files, store in separate `samples.db` for isolation.
**Effort:** Medium (3-5 days). ZIP download + extraction + file indexing + separate database.

### 1.3 Swift.org Documentation -- HIGH

**Who has it:** cupertino (~501 documents)
**What it is:** Official Swift language guides at swift.org (Getting Started, Language Guide, API Design Guidelines, Migration Guides, Server-Side Swift, Package Manager docs).
**Why it matters:** Covers language-level topics that Apple Developer docs don't (compiler flags, package manifest format, server-side Swift patterns).
**Implementation:** HTML crawl of swift.org using Bun's HTMLRewriter. Static pages, no JS rendering needed. Extract content from `<main>` or `<article>` elements.
**Effort:** Low-Medium (2-3 days). Standard HTML scraping.

### 1.4 The Swift Programming Language Book -- HIGH

**Who has it:** cupertino
**What it is:** The official Swift book ("TSPL"), available as DocC content at github.com/swiftlang/swift-book.
**Why it matters:** Definitive language reference. Agents explaining Swift syntax, generics, concurrency patterns should cite this.
**Implementation:** The Swift book is in DocC format. We can either fetch from the GitHub repo's markdown source or from Apple's hosted version at `docs.swift.org/swift-book/`. The markdown source is easier.
**Effort:** Low (1-2 days). Clone repo, index markdown files.

### 1.5 Swift Package Catalog -- HIGH

**Who has it:** cupertino (9,699 packages from Swift Package Index)
**What it is:** Metadata about every registered Swift package: name, description, GitHub URL, stars, license, topics, platform support.
**Why it matters:** Agents recommending libraries need package metadata. "What's the best Swift JSON parser?" requires knowing what exists.
**Implementation:** Fetch `https://raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json` (10,674+ GitHub URLs), then batch GitHub API calls for metadata. Rate limit carefully (5K/hr without auth, 15K/hr with).
**Effort:** Medium (2-3 days). GitHub API rate limiting is the main challenge.

### 1.6 Apple Archive Legacy Guides -- MEDIUM

**Who has it:** cupertino (~75 guides)
**What it is:** Pre-2016 Apple documentation (Concurrency Programming Guide, Memory Management, etc.) at `developer.apple.com/library/archive/`.
**Why it matters:** Legacy guides still explain fundamental concepts (GCD, KVO, memory management) better than modern API docs. Many Objective-C patterns remain relevant.
**Implementation:** Fetch `book.json` TOC files per guide, then crawl static HTML pages. Content is in `<article id="contents">` elements.
**Effort:** Medium (2-3 days). HTML parsing with edge cases.

### 1.7 WWDC Session Transcripts -- HIGH (OPPORTUNITY)

**Who has it:** kimsungwhee (bundled 2014-2025 video metadata), scrapple (transcripts)
**Who doesn't:** cupertino (explicitly absent)
**What it is:** 3,000+ WWDC session transcripts with talk metadata (year, track, speakers, topics, related frameworks).
**Why it matters:** WWDC talks explain *why* Apple designed APIs the way they did, announce deprecations, and demonstrate best practices. This is our blue ocean -- neither cupertino nor any major MCP server has full transcripts.
**Implementation:** ASCIIwwdc (github.com/ASCIIwwdc/asciiwwdc.com) has community-sourced transcripts. Apple also hosts transcripts on developer.apple.com (accessible via JSON API). Dual-source approach: ASCIIwwdc for historical, Apple for recent.
**Effort:** Medium (3-4 days). Two source parsers.

### 1.8 Package READMEs -- MEDIUM

**Who has it:** cupertino (36 priority packages + user-selected)
**What it is:** Full README content of important Swift packages (swift-algorithms, swift-nio, swift-collections, etc.).
**Why it matters:** Package metadata alone isn't enough. The README contains usage examples, installation instructions, and API overview.
**Implementation:** GitHub API raw content fetch for each selected package's README.md.
**Effort:** Low (1 day). Straightforward after package catalog exists.

### 1.9 Xcode Hidden Documentation -- LOW PRIORITY

**Who has it:** appledeepdoc
**What it is:** Content in Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/share/doc/ and similar paths.
**Why it matters:** Contains early documentation for unreleased features (e.g., Liquid Glass guides before public announcement).
**Implementation:** File system scanning on macOS, restricted to when Xcode is installed.
**Effort:** Low, but macOS-only and fragile across Xcode versions. Not recommended as a priority.

---

## 2. Search Engine Gaps

### 2.1 Platform Availability Filtering -- HIGH

**Who has it:** cupertino (min_ios, min_macos, min_tvos, min_watchos, min_visionos columns)
**Current state:** apple-docs stores platform data in `pages.platforms` as JSON string but doesn't expose it as filterable columns.
**Gap:** Users can't search "show me APIs available on iOS 17+" or "what's new in visionOS 2.0".
**Implementation:** Add denormalized columns (`min_ios`, `min_macos`, etc.) to pages table. Parse from existing platforms JSON during migration. Add SQL filter clauses.
**Effort:** Low-Medium (1-2 days). Schema migration + query modification.

### 2.2 Language Filtering (Swift/ObjC) -- MEDIUM

**Who has it:** cupertino
**Current state:** apple-docs doesn't track programming language per page.
**Gap:** Users can't filter to Swift-only or ObjC-only results.
**Implementation:** Extract language from DocC JSON (`metadata.modules[].relatedModules` or declaration language). Add `language` column.
**Effort:** Low (1 day).

### 2.3 Release Notes Penalty Heuristic -- MEDIUM

**Who has it:** cupertino (2.5x penalty on release notes)
**Current state:** apple-docs has no ranking heuristics beyond BM25 tiers.
**Gap:** Release notes rank too high for API searches because they mention many symbols.
**Implementation:** Detect `is_release_notes` from path patterns (`/releasenotes/`, title patterns). Apply score multiplier in ranking.
**Effort:** Low (< 1 day).

### 2.4 Framework Synonym Mapping -- MEDIUM

**Who has it:** cupertino (QuartzCore <-> CoreAnimation, etc.)
**Current state:** Not present in apple-docs.
**Gap:** Searching "CoreAnimation" won't find results under "QuartzCore" root.
**Implementation:** Lookup table of canonical <-> alias mappings. Expand framework filter queries to include synonyms.
**Effort:** Low (< 1 day).

### 2.5 Custom Ranking Heuristics -- MEDIUM

**Who has it:** cupertino (8 heuristics: core-type boost, URL depth, title pattern, modern-over-deprecated, nested-type penalty, query pattern boost, kind inference, release notes penalty)
**Current state:** apple-docs uses BM25 + tier classification + CamelCase expansion + trigram + fuzzy + body search. No custom scoring heuristics.
**Gap:** Our tiered approach is actually more sophisticated in some ways (trigram, Levenshtein, body search cascade), but we lack post-BM25 reranking.
**Implementation:** Add `applyHeuristics()` post-processing step to search results.
**Effort:** Low-Medium (1-2 days).

### 2.6 Snippet Generation -- LOW

**Who has it:** cupertino (FTS5 `snippet()` function)
**Current state:** apple-docs returns full abstract but no highlighted snippets from matched content.
**Gap:** Search results could show matched context with highlighted terms.
**Implementation:** Use FTS5 `snippet()` auxiliary function in search queries.
**Effort:** Low (< 1 day).

### 2.7 Teaser Results from Other Sources -- LOW

**Who has it:** cupertino
**Current state:** apple-docs searches only within the unified corpus.
**Gap:** When searching in one source, showing "also found 3 results in Swift Evolution" helps users discover relevant cross-references.
**Implementation:** After primary search, run lightweight count queries against other source types.
**Effort:** Low (< 1 day). But requires multi-source indexing first.

### 2.8 Semantic/Vector Search -- FUTURE

**Who has it:** bbssppllvv (OpenAI embeddings)
**Current state:** apple-docs is purely keyword-based.
**Gap:** Natural language queries ("how to handle background refresh in SwiftUI") don't work well with keyword search.
**Implementation:** Generate embeddings at index time, store in SQLite or separate vector store. Requires embedding model (local or API).
**Effort:** High (1-2 weeks). Optional enhancement, not priority.

---

## 3. Architecture & Distribution Gaps

### 3.1 Pre-built Database Distribution -- CRITICAL

**Who has it:** cupertino (`cupertino setup` downloads ~320MB from GitHub Releases), bbssppllvv (auto-downloads 260MB on install)
**Current state:** Every apple-docs user must run `sync` for hours before using the tool.
**Gap:** This is the single biggest UX barrier. Users expect instant setup.
**Implementation:** Build and publish `apple-docs.db` + optional `samples.db` to GitHub Releases. `apple-docs setup` command downloads and extracts. Automate with GitHub Actions.
**Effort:** Medium (2-3 days for setup command + CI pipeline).

### 3.2 npm Publishing -- HIGH

**Who has it:** kimsungwhee (`npx -y @kimsungwhee/apple-docs-mcp`), several others
**Current state:** apple-docs installs via `bun link` only.
**Gap:** npm is where developers discover tools. `npx` install is the fastest path to trying a tool.
**Implementation:** Publish to npm. Handle `bun` vs `node` runtime detection. Potentially use `bunx` as primary install.
**Effort:** Low (1 day). Mostly packaging and README updates.

### 3.3 Single-Binary Compilation -- MEDIUM

**Who has it:** cupertino (signed/notarized universal binary)
**Current state:** apple-docs requires Bun runtime.
**Gap:** Some users don't have/want Bun installed.
**Implementation:** `bun build --compile` produces standalone executables. Cross-compile for macOS arm64/x64, Linux x64/arm64.
**Effort:** Low (1 day). Bun handles the heavy lifting.

### 3.4 Docker Image -- MEDIUM

**Who has it:** Implied by cross-platform projects
**Current state:** No Docker support.
**Gap:** Server/CI deployments need containerized execution.
**Implementation:** `FROM oven/bun:latest`, COPY source, embed pre-built databases.
**Effort:** Low (< 1 day).

### 3.5 GitHub Actions CI -- MEDIUM

**Who has it:** cupertino (698 tests, 73 suites), OxADD1
**Current state:** apple-docs has unit tests but no CI.
**Gap:** No automated testing on push/PR. No cross-platform validation.
**Implementation:** Standard GitHub Actions workflow with Bun setup, test, lint, build across macOS/Linux/Windows.
**Effort:** Low (< 1 day).

### 3.6 Integration Testing / Mock AI Agent -- LOW

**Who has it:** cupertino (MockAIAgent executable)
**Current state:** apple-docs has unit tests only.
**Gap:** No end-to-end MCP protocol testing.
**Implementation:** Write integration tests that spawn MCP server and send JSON-RPC messages.
**Effort:** Medium (2-3 days).

---

## 4. Output Format Gaps

### 4.1 Static Website Generation -- NEW FEATURE

**Who has it:** OxADD1 (basic HTML with Apple-style design and JS search)
**Current state:** apple-docs outputs to terminal or MCP only.
**Gap:** No browsable web interface for the documentation.
**Implementation:** See [05-static-website.md](05-static-website.md) for full design.
**Effort:** High (1-2 weeks).

### 4.2 PDF Generation -- LOW PRIORITY

**Who has it:** OxADD1 (per-framework PDFs via pandoc+xelatex)
**Current state:** Not available.
**Gap:** Some users want printable/offline-readable PDFs.
**Implementation:** Use `Bun.markdown` for HTML generation, then headless browser for PDF. Or pipe through pandoc.
**Effort:** Medium, but low priority.

### 4.3 Dash Docset Generation -- LOW PRIORITY

**Who has it:** No competing project, but Dash is the gold standard
**Current state:** Not available.
**Gap:** Dash users can't import apple-docs data.
**Implementation:** Generate Dash-compatible docsets (SQLite index + HTML files in specific directory structure).
**Effort:** Medium.

---

## 5. CLI / UX Gaps

### 5.1 `setup` Command for Instant Onboarding -- CRITICAL

See 3.1 above. Users need `apple-docs setup` -> working tool in < 1 minute.

### 5.2 TUI Interface -- LOW

**Who has it:** cupertino (`cupertino-tui`)
**Gap:** Interactive terminal browsing.
**Assessment:** Nice-to-have but low priority. CLI + MCP covers primary use cases.

### 5.3 Command Namespace Redesign for `serve` vs MCP -- MEDIUM

**Current state:** MCP server starts with `bun run index.js` or as `apple-docs-mcp` binary. The CLI uses `sync`, `search`, `read`, etc. There is no explicit `serve` command.
**Desired state:** `apple-docs serve` should start the static website server. MCP should use a different verb.
**Implementation:** See [07-command-namespace.md](07-command-namespace.md) for full design.
**Effort:** Low (refactoring only).

---

## 6. Priority Matrix

### Must Have (blocks competitive parity)

| Gap | Effort | Impact |
|-----|--------|--------|
| Pre-built database distribution | Medium | Critical |
| Swift Evolution proposals source | Low | Critical |
| Sample code indexing | Medium | Critical |
| npm publishing | Low | High |
| Platform availability filtering | Low-Medium | High |
| Command namespace redesign | Low | Medium |

### Should Have (significant value add)

| Gap | Effort | Impact |
|-----|--------|--------|
| Swift.org documentation source | Low-Medium | High |
| Swift book source | Low | High |
| WWDC transcripts source (blue ocean) | Medium | High |
| Package catalog source | Medium | High |
| Static website generation | High | High |
| Custom ranking heuristics | Low-Medium | Medium |
| Single-binary compilation | Low | Medium |
| GitHub Actions CI | Low | Medium |

### Nice to Have (differentiators)

| Gap | Effort | Impact |
|-----|--------|--------|
| Apple Archive legacy guides | Medium | Medium |
| Package READMEs | Low | Medium |
| Framework synonym mapping | Low | Medium |
| Language filtering | Low | Medium |
| Snippet generation | Low | Low |
| Teaser results | Low | Low |
| Docker image | Low | Medium |
| On-the-fly markdown generation | Medium | Medium |

### Future (long-term differentiation)

| Gap | Effort | Impact |
|-----|--------|--------|
| Semantic/vector search | High | High |
| Dash docset generation | Medium | Low |
| PDF generation | Medium | Low |
| Xcode hidden docs | Low | Low |
| Integration testing framework | Medium | Medium |
