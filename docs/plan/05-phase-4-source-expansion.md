# Phase 4: Source Coverage Expansion

> **Goal**: Catch and surpass the strongest competitor (cupertino: 8 sources) on breadth. Add 7 new knowledge sources via the adapter layer built in Phase 2.
> **Status**: `HISTORICAL PLAN`
> **Live status**: See `docs/plan/PROGRESS.md` — the package catalog is now landed in-tree, and the temporary WWDC/sample MCP wrappers described here were later consolidated into the core `search_docs` / `read_doc` surface in Phase 9-B.

## Source Priority Order

| # | Source | Documents | Effort | Strategic Value | Rationale |
|---|---|---|---|---|---|
| 1 | Swift Evolution | ~450 proposals | Low | High | Language design rationale; closes biggest gap vs cupertino |
| 2 | Swift.org docs | ~500 pages | Low | High | Language-level topics Apple docs omit (concurrency, macros) |
| 3 | Swift Book | ~100 chapters | Low | High | Definitive language reference |
| 4 | Apple Archive | ~75 legacy guides | Low | Medium | Historical but still referenced; easy win |
| 5 | WWDC Transcripts | ~3,000+ sessions | Medium | **Critical** | **Blue ocean — no competitor has this** |
| 6 | Sample Code | 606 projects / 18K+ files | High | High | Highest-value teaching material |
| 7 | Package Catalog | 9,699+ packages | Medium | Medium | Library discovery; defer if time-constrained |

**After Phase 4**: apple-docs will have **11+ sources** vs cupertino's 8, with the unique advantage of WWDC transcripts.

## Exit Criteria

- [ ] All 7 sources implemented as adapters and registered
- [ ] `sync --sources swift-evolution` works for each source independently
- [ ] Each source produces valid normalized documents
- [ ] Search returns results from all sources with source_type metadata
- [ ] New MCP tools: `search_wwdc`, `search_samples`, `read_sample_file`
- [ ] Golden search queries updated to cover new sources
- [ ] Total corpus: ~365,000+ documents

---

## 4.1 — Swift Evolution Adapter

**File to create**: `src/sources/swift-evolution.js`

**Data source**: `github.com/swiftlang/swift-evolution/tree/main/proposals/`
- ~450 Markdown files (SE-0001.md through SE-NNNN.md)
- Each file has a structured header: `# Title`, `* Proposal: [SE-NNNN]`, `* Status: ...`, `* Authors: ...`

**Discovery**:
```js
async discover(ctx) {
  // Fetch GitHub API: repos/swiftlang/swift-evolution/contents/proposals
  // Or: fetch raw file listing from GitHub
  // Return array of proposal file keys: ['SE-0001', 'SE-0002', ...]
}
```

**Fetch**:
```js
async fetch(key, ctx) {
  // Fetch raw Markdown: raw.githubusercontent.com/swiftlang/swift-evolution/main/proposals/{key}.md
  // Rate limit: GitHub API 5K/hr with token, 60/hr without
  // Return { key, payload: markdownString, etag }
}
```

**Normalize**:
- Parse header to extract: SE number, title, status (Implemented/Accepted/Rejected/...), Swift version, authors, review manager
- Store in `source_metadata`: `{ se_number, status, swift_version, authors, review_manager }`
- Body: full Markdown content as discussion section
- Kind: `'proposal'`

**Check**: ETag on GitHub raw content URL, or Last-Modified header.

**Estimated corpus size**: ~450 documents, ~50 MB raw content.

---

## 4.2 — Swift.org Documentation Adapter

**File to create**: `src/sources/swift-org.js`

**Data source**: `swift.org/documentation/` and related pages
- Static HTML pages covering: Getting Started, Language Guide, Server-Side Swift, Concurrency, Macros, Package Manager, Contributing, etc.
- ~500 pages estimated

**Discovery**:
```js
async discover(ctx) {
  // Fetch swift.org/documentation/ and parse links
  // Also: swift.org/getting-started/, swift.org/server/, etc.
  // Build list of page URLs to crawl
}
```

**Fetch**:
```js
async fetch(key, ctx) {
  // Fetch HTML page from swift.org/{key}
  // Use HTMLRewriter to extract main content area
  // Strip navigation, footer, scripts
  // Return { key, payload: { html, title, description } }
}
```

**Normalize**:
- Convert extracted HTML to normalized sections
- Title from `<h1>` or `<title>`
- Abstract from meta description
- Content sections from `<article>` or main content div
- Kind: `'article'`

---

## 4.3 — The Swift Programming Language Book Adapter

**File to create**: `src/sources/swift-book.js`

**Data source**: `docs.swift.org/swift-book/` or GitHub `swiftlang/swift-book/`
- ~100 chapters in Markdown
- Structured as: Welcome, Language Guide, Language Reference, Revision History

**Discovery**:
```js
async discover(ctx) {
  // Fetch SUMMARY.md or table of contents from GitHub
  // Or scrape docs.swift.org/swift-book/ for chapter links
  // Return chapter keys
}
```

**Fetch**: Fetch raw Markdown from GitHub repo.

**Normalize**:
- Chapter title, section headings
- Code examples extracted as separate sections
- Kind: `'book-chapter'`
- Source metadata: `{ book: 'swift-programming-language', chapter_number, section }`

---

## 4.4 — Apple Archive (Legacy Guides) Adapter

**File to create**: `src/sources/apple-archive.js`

**Data source**: `developer.apple.com/library/archive/`
- ~75 legacy technical guides (Cocoa Fundamentals, Memory Management, etc.)
- Structured as book.json TOC + HTML pages

**Discovery**:
```js
async discover(ctx) {
  // Known list of archive guide root URLs (curated)
  // Each guide has a book.json with table of contents
  // Fetch book.json, extract all chapter/section URLs
}
```

**Fetch**: Fetch HTML pages, extract content with HTMLRewriter.

**Normalize**:
- Strip navigation chrome
- Convert HTML to normalized sections
- Mark as `is_archived = true` in source_metadata
- Kind: `'archive-guide'`

**Note**: These pages are stable/frozen, so update checking can be minimal (monthly or manual).

---

## 4.5 — WWDC Transcripts Adapter (Blue Ocean)

**File to create**: `src/sources/wwdc.js`

This is the **highest strategic value** source. No competitor has comprehensive WWDC transcript coverage.

**Data sources** (dual):

1. **Apple Official (2020+)**: `developer.apple.com/tutorials/data/videos/play/wwdc{year}/{id}.json`
   - Structured JSON with session metadata, description, and sometimes transcript
   - Session list: `developer.apple.com/tutorials/data/videos/wwdc{year}.json`

2. **ASCIIwwdc (2012-2020)**: `github.com/ASCIIwwdc/asciiwwdc-content/`
   - Community-maintained plain text transcripts
   - Organized by year/session-id

**Discovery**:
```js
async discover(ctx) {
  const keys = [];

  // Apple official: iterate years 2020-current
  for (const year of range(2020, currentYear)) {
    const index = await fetch(`https://developer.apple.com/tutorials/data/videos/wwdc${year}.json`);
    for (const session of index.sessions) {
      keys.push(`wwdc${year}/${session.id}`);
    }
  }

  // ASCIIwwdc: iterate years 2012-2020
  // Fetch directory listing from GitHub
  for (const year of range(2012, 2020)) {
    const sessions = await fetchGitHubDir(`ASCIIwwdc/asciiwwdc-content/${year}`);
    for (const session of sessions) {
      keys.push(`wwdc${year}/${session.name}`);
    }
  }

  return { keys };
}
```

**Fetch**:
```js
async fetch(key, ctx) {
  const [yearStr, sessionId] = key.split('/');
  const year = parseInt(yearStr.replace('wwdc', ''));

  if (year >= 2020) {
    // Apple official JSON
    const url = `https://developer.apple.com/tutorials/data/videos/play/${key}.json`;
    return { key, payload: await fetchJson(url), source: 'apple' };
  } else {
    // ASCIIwwdc plain text
    const url = `https://raw.githubusercontent.com/ASCIIwwdc/asciiwwdc-content/master/${year}/${sessionId}.txt`;
    return { key, payload: { transcript: await fetchText(url), year, sessionId }, source: 'asciiwwdc' };
  }
}
```

**Normalize**:
- Title: session title
- Abstract: session description
- Kind: `'wwdc-session'`
- Source metadata: `{ year, session_id, track, duration, speakers, frameworks_mentioned }`
- Content sections:
  - `'description'`: session description
  - `'transcript'`: full transcript text (for body search)
  - `'topics'`: extracted topic keywords

**New MCP Tool**: `search_wwdc`
```js
{
  name: 'search_wwdc',
  description: 'Search WWDC session transcripts by topic, year, or framework',
  inputSchema: {
    properties: {
      query: { type: 'string' },
      year: { type: 'number', description: 'Filter by WWDC year' },
      track: { type: 'string', description: 'Filter by track (e.g., SwiftUI, UIKit)' },
      limit: { type: 'number', default: 10 }
    },
    required: ['query']
  }
}
```

**Estimated corpus**: ~3,000+ sessions, ~500 MB transcripts.

---

## 4.6 — Sample Code Adapter

**File to create**: `src/sources/sample-code.js`

**Data source**: Apple's sample code archives
- 606 sample code projects
- 18,000+ Swift source files
- Available via Apple's developer download system

**Discovery**:
```js
async discover(ctx) {
  // Apple's sample code listing (JSON API or scrape)
  // Each sample has: title, description, frameworks, download URL
  // Return sample project keys
}
```

**Fetch**:
```js
async fetch(key, ctx) {
  // Download sample code archive (ZIP)
  // Extract to temporary directory
  // Parse project structure: Package.swift or .xcodeproj
  // Index all .swift files
  // Return { key, payload: { metadata, files: [{ path, content }] } }
}
```

**Storage strategy**: Separate database `samples.db` to avoid bloating the main search index. Main `documents` table gets a metadata entry per sample project; individual files are stored in `samples.db`.

**Normalize**:
- Project-level document: title, description, frameworks used, platform requirements
- File-level entries in samples DB: path, content, language
- Kind: `'sample-project'`

**New MCP Tools**:
```js
// search_samples — search sample code projects
{ name: 'search_samples', inputSchema: { properties: { query, framework, limit } } }

// read_sample_file — read a specific file from a sample project
{ name: 'read_sample_file', inputSchema: { properties: { sample_key, file_path } } }
```

**Estimated corpus**: 606 projects, ~500 MB source code.

---

## 4.7 — Package Catalog Adapter (Deferred)

**File to create**: `src/sources/packages.js`

**Data source**: Swift Package Index
- Master list: `SwiftPackageIndex/PackageList/main/packages.json` (10,674+ GitHub URLs)
- GitHub API for metadata: stars, license, topics, description, README

**This source is lowest priority** and can be deferred to after v2 launch. Reasons:
- GitHub API rate limits (5K/hr with token) make full crawl slow (~2.1 hours)
- Package READMEs are highly variable in quality
- Other sources provide more direct Apple-ecosystem value

**If implemented**:
- Discovery: fetch package list
- Fetch: GitHub API for metadata + README per package
- Normalize: package name, description, stars, license, topics, README content
- Kind: `'package'`
- Rate limiting: respect 5K/hr, batch overnight

---

## Search Integration

After adding all sources, the search system should:

1. **Default**: Search across all sources, weighted by relevance
2. **Filter**: `search --source wwdc "concurrency"` — search only WWDC
3. **Blend**: Results from different sources are interleaved by relevance score
4. **Label**: Each result shows its source type in output

The `documents` table `source_type` column enables all filtering. The FTS5 index covers all sources uniformly.

## Files Changed Summary

| File | Action |
|---|---|
| `src/sources/swift-evolution.js` | Create |
| `src/sources/swift-org.js` | Create |
| `src/sources/swift-book.js` | Create |
| `src/sources/apple-archive.js` | Create |
| `src/sources/wwdc.js` | Create |
| `src/sources/sample-code.js` | Create |
| `src/sources/packages.js` | Create (deferred) |
| `src/sources/registry.js` | Modify (register new adapters) |
| `src/mcp/schemas.js` | Modify (add search_wwdc, search_samples, read_sample_file) |
| `src/mcp/handlers.js` | Modify (add new tool handlers) |
| `test/unit/adapters/*.test.js` | Create (per new adapter) |
| `test/golden/search-queries.json` | Update (add source-specific queries) |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Apple changes JSON API structure | Low | High | Adapter encapsulation isolates breakage to one source |
| GitHub rate limits block Swift Evolution/Package crawl | Medium | Medium | Token-based auth; respect limits; cache aggressively |
| ASCIIwwdc repo goes stale or offline | Low | Medium | Fork/mirror the content; it's community-maintained |
| Sample code download is slow/large | High | Medium | Separate database; incremental download; skip if user doesn't need |
| Total corpus size exceeds practical limits | Low | Medium | Storage profiles (Phase 8) let users choose what to index |
