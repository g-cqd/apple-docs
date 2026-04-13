# Implementation Plan: apple-docs v2

## Phased roadmap to surpass all competitors

This plan is ordered by impact and dependency chain. Each phase builds on the previous. Estimated effort assumes one developer working full-time.

---

## Phase 0: Namespace & Schema Foundation (2-3 days)

**Goal:** Prepare the project for multi-source support without breaking existing functionality.

### 0.1 Command Namespace Redesign

**Current state:**
- `apple-docs-mcp` binary -> starts MCP stdio server
- CLI commands: `sync`, `search`, `read`, `browse`, `frameworks`, `update`, `index`, `doctor`, `status`

**New namespace:**
```
apple-docs mcp start          # Start MCP stdio server (was: apple-docs-mcp)
apple-docs mcp install         # Print setup instructions for Claude/Codex/Cursor
apple-docs serve               # Start static website server (NEW)
apple-docs serve --build       # Build static site to dist/ (NEW)
apple-docs setup               # Download pre-built databases (NEW)
apple-docs sync [--sources X]  # Sync sources (enhanced)
apple-docs search <query>      # Search (enhanced with --source)
apple-docs read <path>         # Read document
apple-docs browse <framework>  # Browse tree
apple-docs frameworks          # List roots
apple-docs update              # Incremental update
apple-docs index               # Build body search
apple-docs doctor              # Health check
apple-docs status              # Corpus stats
apple-docs export [--format X] # Export to markdown/json/html (NEW)
```

**Bin entries in package.json:**
```json
{
  "bin": {
    "apple-docs": "./cli.js",
    "apple-docs-mcp": "./mcp-entry.js"
  }
}
```
The `apple-docs-mcp` entry point is preserved for backward compatibility (existing MCP configurations), but `apple-docs mcp start` becomes the documented approach.

**Implementation:**
- Add `mcp` subcommand to `cli.js` that delegates to MCP server startup
- Create `mcp-entry.js` shim: `import('./src/mcp/server.js').then(m => m.startServer(ctx))`
- Reserve `serve` for static website (Phase 5)
- Add `setup` stub (Phase 1)

### 0.2 Schema Migration v5: Multi-Source Support

```sql
-- Migration v5: Add source_type to roots, denormalize platforms, add metadata
ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docs';

-- Denormalized platform availability for SQL filtering
ALTER TABLE pages ADD COLUMN min_ios TEXT;
ALTER TABLE pages ADD COLUMN min_macos TEXT;
ALTER TABLE pages ADD COLUMN min_tvos TEXT;
ALTER TABLE pages ADD COLUMN min_watchos TEXT;
ALTER TABLE pages ADD COLUMN min_visionos TEXT;
ALTER TABLE pages ADD COLUMN language TEXT;
ALTER TABLE pages ADD COLUMN is_release_notes INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN url_depth INTEGER;
ALTER TABLE pages ADD COLUMN doc_kind TEXT;
ALTER TABLE pages ADD COLUMN source_metadata TEXT; -- JSON for source-specific data

-- Backfill platform columns from existing JSON platforms column
-- (done in JS migration code, parsing the JSON string)

-- Backfill url_depth from path
-- UPDATE pages SET url_depth = length(path) - length(replace(path, '/', ''));

-- Backfill is_release_notes from path patterns
-- UPDATE pages SET is_release_notes = 1 WHERE path LIKE '%releasenotes%' OR path LIKE '%release-notes%';

-- Framework synonyms table
CREATE TABLE IF NOT EXISTS framework_synonyms (
  canonical TEXT NOT NULL,
  alias     TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO framework_synonyms (canonical, alias) VALUES
  ('CoreAnimation', 'QuartzCore'),
  ('CoreGraphics', 'Quartz2D'),
  ('CoreNFC', 'nfc'),
  ('CoreLocation', 'location'),
  ('CoreData', 'coredata'),
  ('CoreML', 'coreml'),
  ('ARKit', 'arkit'),
  ('RealityKit', 'realitykit'),
  ('MapKit', 'mapkit');
```

### 0.3 Source Plugin Interface

```javascript
// src/sources/base.js
export class Source {
  /** @type {string} */ name
  /** @type {string} */ displayName
  /** @type {string} */ sourceType  // matches roots.source_type

  /** Discover items to fetch. Returns array of { id, url, priority } */
  async discover(ctx) { throw new Error('Not implemented') }

  /** Fetch one item. Returns raw data (JSON, HTML, Markdown string) */
  async fetch(item, ctx) { throw new Error('Not implemented') }

  /** Transform raw data to { metadata, markdown, sourceMetadata } */
  transform(raw) { throw new Error('Not implemented') }

  /** Optional: custom sync logic (default: discover -> fetch -> transform -> store) */
  async sync(ctx, options) {
    const items = await this.discover(ctx)
    for (const item of items) {
      const raw = await this.fetch(item, ctx)
      if (!raw) continue
      const doc = this.transform(raw)
      this.store(doc, ctx)
    }
  }
}
```

**Refactor existing code:**
- Extract `AppleDocsSource` from current `discover.js` + `download.js` + `convert.js`
- Extract `HIGSource` from current design-root handling in `discover.js`
- Extract `AppStoreGuidelinesSource` from `sync-guidelines.js`
- Register sources in `src/sources/index.js`

---

## Phase 1: Distribution & Onboarding (3-4 days)

**Goal:** Users can get a working apple-docs in under 60 seconds.

### 1.1 `setup` Command

```javascript
// src/commands/setup.js
export async function setup(options, ctx) {
  const { logger, dataDir } = ctx

  // 1. Check for existing database
  if (existsSync(join(dataDir, 'apple-docs.db'))) {
    if (!options.force) {
      logger.info('Database already exists. Use --force to overwrite.')
      return { status: 'exists' }
    }
  }

  // 2. Find latest release
  const release = await fetch(
    'https://api.github.com/repos/g-cqd/apple-docs-data/releases/latest'
  ).then(r => r.json())

  const asset = release.assets.find(a => a.name.endsWith('.tar.gz'))
  if (!asset) throw new Error('No database asset found in latest release')

  // 3. Download with progress
  logger.info(`Downloading ${asset.name} (${formatBytes(asset.size)})...`)
  const response = await fetch(asset.browser_download_url)

  // 4. Extract to data directory
  const proc = Bun.spawn(['tar', 'xzf', '-', '-C', dataDir], {
    stdin: response.body,
  })
  await proc.exited

  logger.info('Setup complete. Run: apple-docs search "SwiftUI View"')
  return { status: 'ok', version: release.tag_name }
}
```

### 1.2 Database Build & Publish CI

```yaml
# .github/workflows/build-database.yml
name: Build Database
on:
  workflow_dispatch:
  schedule:
    - cron: '0 4 * * 0'  # Weekly Sunday 4am UTC

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 360  # 6 hours
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - name: Sync all sources
        run: bun run cli.js sync --full --concurrency 10 --rate 10

      - name: Build body index
        run: bun run cli.js index --full

      - name: Package database
        run: |
          cd ~/.apple-docs
          tar -czf apple-docs-db-$(date +%Y%m%d).tar.gz apple-docs.db

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: db-$(date +%Y%m%d)
          files: ~/.apple-docs/apple-docs-db-*.tar.gz
```

### 1.3 npm Publishing

Update `package.json`:
```json
{
  "name": "@g-cqd/apple-docs",
  "version": "2.0.0",
  "description": "Apple Developer Documentation search, MCP server, and static site generator",
  "type": "module",
  "bin": {
    "apple-docs": "./cli.js",
    "apple-docs-mcp": "./mcp-entry.js"
  },
  "files": ["src/", "cli.js", "index.js", "mcp-entry.js", "README.md"],
  "scripts": {
    "test": "bun test",
    "start": "bun run index.js",
    "build": "bun build --compile --minify cli.js --outfile dist/apple-docs",
    "build:all": "bun run build:macos-arm64 && bun run build:macos-x64 && bun run build:linux-x64 && bun run build:linux-arm64",
    "build:macos-arm64": "bun build --compile --target=bun-darwin-arm64 cli.js --outfile dist/apple-docs-macos-arm64",
    "build:macos-x64": "bun build --compile --target=bun-darwin-x64 cli.js --outfile dist/apple-docs-macos-x64",
    "build:linux-x64": "bun build --compile --target=bun-linux-x64 cli.js --outfile dist/apple-docs-linux-x64",
    "build:linux-arm64": "bun build --compile --target=bun-linux-arm64 cli.js --outfile dist/apple-docs-linux-arm64"
  },
  "keywords": ["apple", "documentation", "mcp", "search", "swift", "swiftui"],
  "repository": "g-cqd/apple-docs",
  "license": "MIT"
}
```

### 1.4 GitHub Actions CI

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun test
```

---

## Phase 2: Source Expansion -- Text Sources (5-7 days)

**Goal:** Add all text-based documentation sources, reaching parity with cupertino's breadth.

### 2.1 Swift Evolution Proposals

```javascript
// src/sources/swift-evolution.js
export class SwiftEvolutionSource extends Source {
  name = 'swift-evolution'
  displayName = 'Swift Evolution Proposals'
  sourceType = 'swift-evolution'

  async discover(ctx) {
    const files = await fetch(
      'https://api.github.com/repos/swiftlang/swift-evolution/contents/proposals',
      { headers: githubHeaders() }
    ).then(r => r.json())
    return files
      .filter(f => f.name.endsWith('.md'))
      .map(f => ({ id: f.name.replace('.md', ''), url: f.download_url }))
  }

  async fetch(item, ctx) {
    await ctx.rateLimiter.acquire()
    return await fetch(item.url).then(r => r.text())
  }

  transform(raw) {
    const { seNumber, title, status, authors, swiftVersion } = parseProposalHeader(raw)
    return {
      metadata: {
        title: `SE-${seNumber}: ${title}`,
        path: `swift-evolution/${seNumber.toLowerCase()}`,
        role: 'article',
        roleHeading: 'Swift Evolution Proposal',
        docKind: 'proposal',
      },
      markdown: raw,
      sourceMetadata: { se_number: seNumber, status, authors, swift_version: swiftVersion },
    }
  }
}
```

### 2.2 Swift.org Documentation

```javascript
// src/sources/swift-org.js
export class SwiftOrgSource extends Source {
  name = 'swift-org'
  displayName = 'Swift.org Documentation'
  sourceType = 'swift-org'

  // Seed URLs for swift.org documentation pages
  static PAGES = [
    '/about/', '/getting-started/', '/documentation/',
    '/documentation/api-design-guidelines/',
    '/documentation/server/', '/documentation/articles/',
    '/install/', '/packages/', '/migration-guide/',
    // ... comprehensive list
  ]

  async discover() {
    return SwiftOrgSource.PAGES.map(path => ({
      id: path, url: `https://swift.org${path}`
    }))
  }

  async fetch(item, ctx) {
    await ctx.rateLimiter.acquire()
    const html = await fetch(item.url).then(r => r.text())
    return { html, url: item.url }
  }

  transform({ html, url }) {
    // Use HTMLRewriter to extract main content
    const content = extractMainContent(html) // <main> or <article> element
    const title = extractTitle(html) // <h1> or <title>
    const markdown = htmlToMarkdown(content)
    return {
      metadata: { title, path: `swift-org${new URL(url).pathname}`, role: 'article' },
      markdown,
    }
  }
}
```

### 2.3 Swift Programming Language Book

```javascript
// src/sources/swift-book.js
export class SwiftBookSource extends Source {
  name = 'swift-book'
  displayName = 'The Swift Programming Language'
  sourceType = 'swift-book'

  async discover() {
    // Fetch TSPL from docs.swift.org or GitHub repo
    const chapters = await fetch(
      'https://api.github.com/repos/swiftlang/swift-book/contents/TSPL.docc',
      { headers: githubHeaders() }
    ).then(r => r.json())
    return chapters
      .filter(f => f.name.endsWith('.md'))
      .map(f => ({ id: f.name.replace('.md', ''), url: f.download_url }))
  }
}
```

### 2.4 Apple Archive Legacy Guides

```javascript
// src/sources/apple-archive.js
export class AppleArchiveSource extends Source {
  name = 'apple-archive'
  displayName = 'Apple Archive (Legacy Guides)'
  sourceType = 'apple-archive'

  // Legacy guides with book.json TOC files
  static GUIDES = [
    'ConcurrencyProgrammingGuide',
    'MemoryMgmt',
    'ThreadingProgrammingGuide',
    'KeyValueObserving',
    'KeyValueCoding',
    // ... ~75 guides
  ]

  async discover() {
    const items = []
    for (const guide of AppleArchiveSource.GUIDES) {
      const tocUrl = `https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/${guide}/book.json`
      try {
        const toc = await fetch(tocUrl).then(r => r.json())
        for (const page of extractPages(toc)) {
          items.push({ id: `${guide}/${page.path}`, url: page.url, guide })
        }
      } catch { /* guide may not exist */ }
    }
    return items
  }
}
```

### 2.5 Enhanced Search with Source Filtering

Update search command and MCP tool:
```javascript
// Enhanced search in src/commands/search.js
export async function search(params, ctx) {
  const { query, framework, kind, source, limit, fuzzy, noDeep, noEager } = params

  // Build FTS query with source filter
  let results = ctx.db.searchPages(ftsQuery, query, {
    framework, kind, source, limit: limit ?? 20,
  })

  // Apply ranking heuristics (new)
  results = applyHeuristics(results, query)

  // ... rest of cascade (trigram, fuzzy, body)
}
```

### 2.6 Ranking Heuristics

```javascript
// src/lib/ranking.js
export function applyHeuristics(results, query) {
  return results.map(r => {
    let boost = 1.0

    // 1. Core types over extensions
    if (!r.title?.includes('+') && !r.title?.includes('Extension')) boost *= 1.2

    // 2. URL depth: shallower = more important
    const depth = r.url_depth ?? (r.path?.split('/').length ?? 3)
    boost *= Math.max(0.6, 1.0 - (depth - 2) * 0.05)

    // 3. Exact title match
    if (r.title?.toLowerCase() === query.toLowerCase()) boost *= 3.0

    // 4. Release notes penalty
    if (r.is_release_notes) boost *= 0.4

    // 5. Archive penalty (prefer modern)
    if (r.root_slug?.includes('archive')) boost *= 0.7

    // 6. Nested type penalty
    if ((r.path?.split('/').length ?? 0) > 5) boost *= 0.85

    // 7. Query pattern boost
    const ql = query.toLowerCase()
    if (ql.includes('protocol') && r.doc_kind === 'protocol') boost *= 1.5
    if (ql.includes('struct') && r.doc_kind === 'structure') boost *= 1.5
    if (ql.includes('class') && r.doc_kind === 'class') boost *= 1.5

    return { ...r, _boost: boost }
  }).sort((a, b) => {
    // Sort by tier first, then by boosted rank
    if (a.tier !== b.tier) return (a.tier ?? 99) - (b.tier ?? 99)
    return (b._boost * Math.abs(b.rank ?? 0)) - (a._boost * Math.abs(a.rank ?? 0))
  })
}
```

---

## Phase 3: Code Sources (5-7 days)

**Goal:** Add sample code and package catalog. These are the highest-value additions after text sources.

### 3.1 Sample Code Indexing

**Strategy:** Use Apple's sample code listing from developer.apple.com, download ZIP archives, extract Swift files, index in separate database.

```javascript
// src/sources/sample-code.js
export class SampleCodeSource extends Source {
  name = 'samples'
  displayName = 'Apple Sample Code'
  sourceType = 'samples'

  async discover(ctx) {
    // Apple lists sample code at:
    // https://developer.apple.com/tutorials/data/documentation/technologies.json
    // under each framework's sampleCode section
    // Alternative: scrape https://developer.apple.com/sample-code/
    const tech = await fetch(TECHNOLOGIES_URL).then(r => r.json())
    const samples = extractSampleCodeLinks(tech)
    return samples
  }
}
```

**Separate database (`samples.db`):**
```sql
CREATE TABLE sample_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  frameworks TEXT,     -- JSON array
  platforms TEXT,      -- JSON array
  download_url TEXT,
  readme TEXT,
  crawled_at TEXT NOT NULL
);

CREATE TABLE sample_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES sample_projects(id),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  content TEXT NOT NULL,
  line_count INTEGER,
  UNIQUE(project_id, file_path)
);

CREATE VIRTUAL TABLE samples_fts USING fts5(
  title, file_name, content,
  tokenize = 'porter unicode61'
);
```

### 3.2 Package Catalog

```javascript
// src/sources/packages.js
export class PackageCatalogSource extends Source {
  name = 'packages'
  displayName = 'Swift Package Catalog'
  sourceType = 'packages'

  async discover() {
    const urls = await fetch(
      'https://raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json'
    ).then(r => r.json())
    return urls.map(url => ({
      id: extractOwnerRepo(url),
      url,
    }))
  }

  async fetch(item, ctx) {
    await ctx.rateLimiter.acquire()
    const repo = await fetch(
      `https://api.github.com/repos/${item.id}`,
      { headers: githubHeaders() }
    ).then(r => r.json())
    return repo
  }

  transform(repo) {
    return {
      metadata: {
        title: repo.name,
        path: `packages/${repo.full_name.toLowerCase()}`,
        role: 'article',
        docKind: 'package',
      },
      markdown: [
        `# ${repo.name}`,
        repo.description || '',
        `Stars: ${repo.stargazers_count} | License: ${repo.license?.spdx_id || 'Unknown'}`,
        `Topics: ${(repo.topics || []).join(', ')}`,
        `URL: ${repo.html_url}`,
      ].join('\n\n'),
      sourceMetadata: {
        stars: repo.stargazers_count,
        license: repo.license?.spdx_id,
        topics: repo.topics,
        language: repo.language,
      },
    }
  }
}
```

### 3.3 New MCP Tools for Samples

```javascript
// Added to src/mcp/tools.js
{
  name: 'search_samples',
  description: 'Search Apple sample code projects and files',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      framework: { type: 'string', description: 'Filter by framework' },
      fileType: { type: 'string', description: 'Filter by file extension (e.g., swift, metal)' },
      limit: { type: 'number', description: 'Max results', default: 10 },
    },
    required: ['query'],
  },
},
{
  name: 'read_sample_file',
  description: 'Read the contents of a specific file from an Apple sample code project',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug' },
      file: { type: 'string', description: 'File path within project' },
    },
    required: ['project', 'file'],
  },
},
```

---

## Phase 4: WWDC Transcripts (3-4 days)

**Goal:** Add the one source that NO major competitor has comprehensively.

### 4.1 WWDC Source

```javascript
// src/sources/wwdc.js
export class WWDCSource extends Source {
  name = 'wwdc'
  displayName = 'WWDC Session Transcripts'
  sourceType = 'wwdc'

  async discover() {
    // Source 1: ASCIIwwdc (community transcripts, 2012-2020)
    // Source 2: Apple (official transcripts, 2020+)
    // Apple hosts transcripts at developer.apple.com/videos/play/wwdc{year}/{id}/
    // with JSON data at developer.apple.com/tutorials/data/videos/play/wwdc{year}/{id}.json

    const sessions = []
    for (const year of range(2014, 2026)) {
      const yearSessions = await fetchSessionList(year)
      sessions.push(...yearSessions)
    }
    return sessions
  }

  transform(session) {
    return {
      metadata: {
        title: `WWDC${session.year}: ${session.title}`,
        path: `wwdc/${session.year}/${session.id}`,
        role: 'article',
        roleHeading: 'WWDC Session',
        docKind: 'session',
      },
      markdown: formatTranscript(session),
      sourceMetadata: {
        year: session.year,
        session_id: session.id,
        track: session.track,
        duration: session.duration,
        speakers: session.speakers,
        frameworks: session.frameworks,
      },
    }
  }
}
```

### 4.2 WWDC-specific MCP Tool

```javascript
{
  name: 'search_wwdc',
  description: 'Search WWDC session transcripts by topic, year, or framework',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      year: { type: 'number', description: 'Filter by WWDC year' },
      framework: { type: 'string', description: 'Filter by framework' },
      limit: { type: 'number', default: 10 },
    },
    required: ['query'],
  },
}
```

---

## Phase 5: Static Website (7-10 days)

**Goal:** Serve the entire documentation corpus as a fast, searchable static website.

See [05-static-website.md](05-static-website.md) for full design.

Key decisions:
- Use `Bun.serve()` for development server
- Pre-render HTML from markdown/JSON at build time
- Client-side search using a compressed FTS index (exported from SQLite)
- Deploy as static files to any CDN (Vercel, Cloudflare Pages, GitHub Pages)

```
apple-docs serve              # Start dev server on localhost:3000
apple-docs serve --build      # Build static site to dist/
apple-docs serve --port 8080  # Custom port
```

---

## Phase 6: Polish & Differentiation (ongoing)

### 6.1 On-the-fly Markdown Generation

See [06-markdown-generation.md](06-markdown-generation.md).

### 6.2 Disk Space Management Commands

```
apple-docs export --format json-only    # Remove markdown files, keep JSON
apple-docs export --format markdown-only # Remove JSON files, keep markdown
apple-docs cleanup --raw-json           # Remove raw JSON (saves ~2GB)
apple-docs cleanup --markdown           # Remove markdown files
apple-docs status --disk                # Show per-format disk usage
```

### 6.3 Semantic Search (Future)

Investigate local embedding models (ONNX runtime in Bun) to enable natural language queries without external API dependencies.

### 6.4 Dash Docset Export (Future)

Generate Dash-compatible docsets for integration with Dash, Zeal, and DevDocs.

---

## Milestone Summary

| Phase | Duration | Deliverables | Pages Added |
|-------|----------|-------------|-------------|
| 0: Foundation | 2-3 days | Namespace, schema v5, source plugin | 0 |
| 1: Distribution | 3-4 days | `setup` command, npm, CI, binary builds | 0 |
| 2: Text Sources | 5-7 days | Swift Evolution, Swift.org, Swift Book, Archive, ranking | ~2,000 |
| 3: Code Sources | 5-7 days | Sample code, package catalog, new MCP tools | ~30,000 |
| 4: WWDC | 3-4 days | 3,000+ session transcripts | ~3,000 |
| 5: Static Website | 7-10 days | Browsable web UI with search | 0 (new format) |
| 6: Polish | Ongoing | Disk management, on-the-fly MD, exports | 0 |

**Total estimated effort:** 25-35 days for phases 0-5.

**End state:** ~365,000+ documents across 11 sources, searchable via CLI, MCP, and web interface. Cross-platform (macOS, Linux, Windows). Zero npm dependencies for core. Instant setup via pre-built databases. The most comprehensive, fastest, and most accessible Apple documentation tool in the ecosystem.
