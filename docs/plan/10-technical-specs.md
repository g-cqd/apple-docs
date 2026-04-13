# Technical Specifications

> Detailed specifications for key components referenced across all phases. An engineer should be able to implement directly from these specs.

---

## 1. Database Schema (Complete DDL)

### Schema v5 (Phase 0) — Additions to existing tables

```sql
-- Migration v5: Add multi-source metadata columns

-- Roots table additions
ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc';

-- Pages table additions (transition period — replaced by documents in v6)
ALTER TABLE pages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc';
ALTER TABLE pages ADD COLUMN language TEXT;
ALTER TABLE pages ADD COLUMN is_release_notes INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN url_depth INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN doc_kind TEXT;
ALTER TABLE pages ADD COLUMN source_metadata TEXT;
ALTER TABLE pages ADD COLUMN min_ios TEXT;
ALTER TABLE pages ADD COLUMN min_macos TEXT;
ALTER TABLE pages ADD COLUMN min_watchos TEXT;
ALTER TABLE pages ADD COLUMN min_tvos TEXT;
ALTER TABLE pages ADD COLUMN min_visionos TEXT;

-- Framework synonyms table
CREATE TABLE IF NOT EXISTS framework_synonyms (
  canonical TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  PRIMARY KEY (canonical, alias)
);

-- Seed data
INSERT OR IGNORE INTO framework_synonyms (canonical, alias) VALUES
  ('quartzcore', 'coreanimation'),
  ('coreanimation', 'quartzcore'),
  ('quartz2d', 'coregraphics'),
  ('coregraphics', 'quartz2d'),
  ('metalkit', 'metal'),
  ('metalperformanceshaders', 'metal'),
  ('uikitcore', 'uikit'),
  ('appkit', 'cocoa'),
  ('foundation', 'nsobject'),
  ('swiftui', 'declarativeui');

-- Backfill queries
UPDATE roots SET source_type = 'hig' WHERE kind = 'design';
UPDATE roots SET source_type = 'guidelines' WHERE slug = 'app-store-review';
UPDATE pages SET source_type = (SELECT source_type FROM roots WHERE roots.id = pages.root_id);
UPDATE pages SET is_release_notes = 1 WHERE path LIKE '%/release-notes%' OR role = 'releaseNotes';
UPDATE pages SET url_depth = length(path) - length(replace(path, '/', ''));

-- Schema version bump
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '5');
```

### Schema v6 (Phase 1) — Normalized content model

```sql
-- Migration v6: Canonical normalized document model

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL DEFAULT 'apple-docc',
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  kind TEXT,
  role TEXT,
  role_heading TEXT,
  framework TEXT,
  url TEXT,
  language TEXT,
  abstract_text TEXT,
  declaration_text TEXT,
  platforms_json TEXT,
  min_ios TEXT,
  min_macos TEXT,
  min_watchos TEXT,
  min_tvos TEXT,
  min_visionos TEXT,
  is_deprecated INTEGER DEFAULT 0,
  is_beta INTEGER DEFAULT 0,
  is_release_notes INTEGER DEFAULT 0,
  url_depth INTEGER DEFAULT 0,
  source_metadata TEXT,
  content_hash TEXT,
  raw_payload_hash TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type);
CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language);
CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);

CREATE TABLE IF NOT EXISTS document_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL,
  heading TEXT,
  content_text TEXT NOT NULL,
  content_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(document_id, section_kind, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id);
CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind);

CREATE TABLE IF NOT EXISTS document_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  section TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(from_key, to_key, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_rel_from ON document_relationships(from_key);
CREATE INDEX IF NOT EXISTS idx_rel_to ON document_relationships(to_key);

-- FTS5 indexes on normalized model
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, abstract, declaration, headings, key,
  content='documents',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
  title,
  content='documents',
  content_rowid='id',
  tokenize='trigram'
);

-- Snapshot metadata
CREATE TABLE IF NOT EXISTS snapshot_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Populate documents from existing pages
INSERT INTO documents (source_type, key, title, kind, role, framework, url, language,
  abstract_text, declaration_text, min_ios, min_macos, min_watchos, min_tvos, min_visionos,
  is_release_notes, url_depth, source_metadata, content_hash)
SELECT
  p.source_type, p.path, p.title, p.doc_kind, p.role,
  r.slug, 'https://developer.apple.com/documentation/' || p.path, p.language,
  p.abstract, p.declaration,
  p.min_ios, p.min_macos, p.min_watchos, p.min_tvos, p.min_visionos,
  p.is_release_notes, p.url_depth, p.source_metadata, NULL
FROM pages p
JOIN roots r ON r.id = p.root_id;

-- Populate FTS
INSERT INTO documents_fts (rowid, title, abstract, declaration, headings, key)
SELECT id, title, abstract_text, declaration_text, '', key FROM documents;

INSERT INTO documents_trigram (rowid, title)
SELECT id, title FROM documents;

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '6');
```

---

## 2. Source Adapter Interface (Complete)

### Type Signatures

```ts
// Types for source adapter contract (JSDoc or future TypeScript)

interface SourceAdapter {
  // Static properties
  static type: string;
  static displayName: string;
  static requiresNetwork: boolean;

  // Discovery
  discover(ctx: AdapterContext): Promise<DiscoveryResult>;

  // Fetching
  fetch(key: string, ctx: AdapterContext): Promise<FetchResult>;

  // Change detection
  check(key: string, previousState: CheckState, ctx: AdapterContext): Promise<CheckResult>;

  // Normalization
  normalize(key: string, rawPayload: unknown): NormalizeResult;

  // Reference extraction (for BFS crawl sources)
  extractReferences(key: string, rawPayload: unknown): string[];

  // Rendering hints
  renderHints(): RenderHints;
}

interface AdapterContext {
  db: Database;
  logger: Logger;
  rateLimiter: RateLimiter;
  semaphore: Semaphore;
  config: Config;
}

interface DiscoveryResult {
  keys: string[];
  roots?: Array<{ slug: string; title: string; kind: string }>;
  metadata?: Record<string, unknown>;
}

interface FetchResult {
  key: string;
  payload: unknown;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

interface CheckState {
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

interface CheckResult {
  changed: boolean;
  newState: CheckState;
  deleted?: boolean;
}

interface NormalizeResult {
  document: NormalizedDocument;
  sections: NormalizedSection[];
  relationships: NormalizedRelationship[];
}

interface NormalizedDocument {
  sourceType: string;
  key: string;
  title: string;
  kind?: string;
  role?: string;
  roleHeading?: string;
  framework?: string;
  url?: string;
  language?: string;
  abstractText?: string;
  declarationText?: string;
  platformsJson?: string;
  minIos?: string;
  minMacos?: string;
  minWatchos?: string;
  minTvos?: string;
  minVisionos?: string;
  isDeprecated?: boolean;
  isBeta?: boolean;
  isReleaseNotes?: boolean;
  urlDepth?: number;
  sourceMetadata?: Record<string, unknown>;
  contentHash?: string;
}

interface NormalizedSection {
  sectionKind: 'abstract' | 'declaration' | 'parameters' | 'discussion' |
               'content' | 'topics' | 'relationships' | 'see_also' | 'transcript';
  heading?: string;
  contentText: string;  // Plain text for search indexing
  contentJson?: string; // Structured JSON for rendering
  sortOrder: number;
}

interface NormalizedRelationship {
  fromKey: string;
  toKey: string;
  relationType: 'child' | 'see_also' | 'conforms_to' | 'inherits_from' |
                'sample_of' | 'related_framework' | 'parent';
  section?: string;
  sortOrder?: number;
}

interface RenderHints {
  showTimestamps?: boolean;     // WWDC transcripts
  showSENumber?: boolean;       // Swift Evolution
  showPlatformBadges?: boolean; // Apple DocC
  showSectionNumbers?: boolean; // App Store Guidelines
}
```

### Adapter Lifecycle During Sync

```
┌─────────────────────────────────────────────┐
│ For each registered adapter:                │
│                                             │
│ 1. adapter.discover(ctx)                    │
│    → Returns list of document keys          │
│                                             │
│ 2. For each key (BFS queue for DocC):       │
│    a. adapter.fetch(key, ctx)               │
│       → Returns raw payload + etag          │
│    b. Save raw payload to disk              │
│    c. adapter.normalize(key, payload)       │
│       → Returns document + sections + rels  │
│    d. Upsert into documents table           │
│    e. Upsert into document_sections table   │
│    f. Upsert into document_relationships    │
│    g. adapter.extractReferences(key, payload)│
│       → Returns child keys for BFS          │
│    h. Add child keys to crawl queue         │
│                                             │
│ 3. Rebuild FTS5 indexes for this source     │
└─────────────────────────────────────────────┘
```

### Adapter Lifecycle During Update

```
┌─────────────────────────────────────────────┐
│ For each registered adapter:                │
│                                             │
│ 1. Get all documents with this source_type  │
│                                             │
│ 2. For each document:                       │
│    a. adapter.check(key, prevState, ctx)    │
│       → Returns { changed, deleted, newState }│
│    b. If changed:                           │
│       - adapter.fetch(key, ctx)             │
│       - adapter.normalize(key, payload)     │
│       - Update documents, sections, rels    │
│    c. If deleted:                           │
│       - Mark document as deleted            │
│       - Remove from FTS indexes             │
│                                             │
│ 3. Optionally: re-discover for new keys     │
└─────────────────────────────────────────────┘
```

---

## 3. Apple DocC JSON API Surface

### Endpoints

| Endpoint | Returns | Used By |
|---|---|---|
| `developer.apple.com/tutorials/data/documentation/technologies.json` | Technology index (all frameworks) | Discovery |
| `developer.apple.com/tutorials/data/documentation/{path}.json` | Documentation page | Fetch |
| `developer.apple.com/tutorials/data/design/{path}.json` | HIG design page | Fetch (HIG) |
| `developer.apple.com/tutorials/data/videos/wwdc{year}.json` | WWDC session list | Discovery (WWDC) |
| `developer.apple.com/tutorials/data/videos/play/wwdc{year}/{id}.json` | WWDC session detail | Fetch (WWDC) |

### DocC JSON Structure

```json
{
  "metadata": {
    "title": "View",
    "role": "symbol",
    "roleHeading": "Protocol",
    "modules": [{ "name": "SwiftUI" }],
    "platforms": [
      { "name": "iOS", "introducedAt": "13.0" },
      { "name": "macOS", "introducedAt": "10.15" }
    ],
    "symbolKind": "protocol",
    "navigatorTitle": [{ "kind": "identifier", "text": "View" }]
  },
  "abstract": [
    { "type": "text", "text": "A type that represents part of your app's user interface..." }
  ],
  "primaryContentSections": [
    {
      "kind": "declarations",
      "declarations": [{
        "tokens": [
          { "kind": "keyword", "text": "protocol" },
          { "kind": "text", "text": " " },
          { "kind": "identifier", "text": "View" }
        ],
        "languages": ["swift"],
        "platforms": ["iOS", "macOS", "tvOS", "watchOS", "visionOS"]
      }]
    },
    {
      "kind": "content",
      "content": [
        { "type": "heading", "level": 2, "text": "Overview", "anchor": "overview" },
        { "type": "paragraph", "inlineContent": [...] },
        { "type": "codeListing", "syntax": "swift", "code": ["..."] }
      ]
    }
  ],
  "topicSections": [
    { "title": "Creating a View", "identifiers": ["doc://..."] }
  ],
  "relationshipsSections": [
    { "title": "Inherits From", "type": "inheritsFrom", "identifiers": ["doc://..."] }
  ],
  "seeAlsoSections": [
    { "title": "Views", "identifiers": ["doc://..."] }
  ],
  "references": {
    "doc://com.apple.documentation/documentation/swiftui/text": {
      "type": "topic",
      "title": "Text",
      "url": "/documentation/swiftui/text",
      "role": "symbol",
      "kind": "symbol",
      "abstract": [...]
    }
  }
}
```

### Content Node Types

| Block-Level | Inline |
|---|---|
| `paragraph` | `text` |
| `heading` (level 1-6) | `codeVoice` |
| `codeListing` (syntax, code[]) | `emphasis` |
| `unorderedList` / `orderedList` | `reference` |
| `aside` (style: note/important/warning/tip) | `link` (destination) |
| `table` (header, rows) | `image` |
| `termList` (items with term+definition) | `subscript` / `superscript` |
| `links` (style: detailedGrid/list) | `strikethrough` |
| `row` / `tabNavigator` | `inlineHead` |

### Platform Extraction Logic

```js
function extractPlatforms(metadata) {
  const platforms = {};
  for (const p of metadata.platforms || []) {
    const key = p.name.toLowerCase()
      .replace('ios', 'ios')
      .replace('macos', 'macos')
      .replace('watchos', 'watchos')
      .replace('tvos', 'tvos')
      .replace('visionos', 'visionos');
    platforms[key] = p.introducedAt;
  }
  return platforms;
}
```

---

## 4. Search Ranking Specification

### BM25 Weight Configuration

```sql
-- FTS5 BM25 weights for documents_fts columns:
-- title(10.0), abstract(5.0), declaration(3.0), headings(2.0), key(1.0)
SELECT *, bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) AS rank
FROM documents_fts
WHERE documents_fts MATCH ?
ORDER BY rank
LIMIT ?;
```

### Tier Scoring

```js
// Tier assignment in SQL CASE statement
const tierScore = `
  CASE
    WHEN lower(d.title) = lower(?) THEN 1         -- Exact title match
    WHEN lower(d.key) = lower(?) THEN 1            -- Exact path match
    WHEN lower(d.title) LIKE lower(?) || '%' THEN 2  -- Title prefix
    WHEN lower(d.key) LIKE '%' || lower(?) THEN 3    -- Path contains
    ELSE 4                                            -- BM25 rank
  END AS tier
`;
```

### Post-BM25 Reranking Formula

```js
function computeAdjustedScore(result, query, intent) {
  let score = result.bm25Score;

  // R1: Exact path/identifier match
  if (result.key.toLowerCase().endsWith('/' + query.toLowerCase())) {
    score *= 3.0;
  }

  // R2: Symbol kind boost for symbol queries
  if (intent.type === 'symbol' && ['symbol', 'struct', 'class', 'protocol', 'enum'].includes(result.kind)) {
    score *= 1.5;
  }

  // R3: Guide boost for howto queries
  if (intent.type === 'howto' && ['article', 'tutorial', 'sampleCode'].includes(result.kind)) {
    score *= 1.3;
  }

  // R4: Release notes penalty
  if (result.isReleaseNotes) {
    score *= 0.4;
  }

  // R5: Archived content penalty
  if (result.sourceType === 'apple-archive') {
    score *= 0.6;
  }

  // R6: Code example boost
  if (result.hasCodeExamples) {
    score *= 1.2;
  }

  // R7: Depth penalty
  if (result.urlDepth > 5) {
    score *= Math.max(0.5, 1.0 - (result.urlDepth - 5) * 0.05);
  }

  // R8: Source freshness boost
  if (result.sourceType === 'wwdc' && result.sourceMetadata?.year === currentYear) {
    score *= 1.1;
  }

  return score;
}
```

### Query Intent Classification Rules

| Pattern | Intent Type | Confidence |
|---|---|---|
| `/^[A-Z][a-zA-Z0-9]+$/` (CamelCase, no spaces) | `symbol` | 0.9 |
| `/^[A-Z][a-zA-Z0-9]+\.[a-z]/` (e.g., `View.body`) | `symbol` | 0.95 |
| Contains `how`, `guide`, `tutorial`, `example` | `howto` | 0.8 |
| Contains `error`, `crash`, `fix`, `issue`, `fail` | `error` | 0.7 |
| Multi-word, all lowercase | `concept` | 0.6 |
| Contains year (e.g., `2024`, `wwdc`) | `wwdc` | 0.8 |
| Default | `general` | 0.5 |

---

## 5. Rendering Pipeline

### Markdown Renderer (from normalized model)

```
NormalizedDocument + NormalizedSection[] → Markdown string

Output structure:
  ---
  title: {title}
  framework: {framework}
  role: {roleHeading}
  platforms: {platformsJson}
  ---

  # {title}

  {abstract section}

  ## Declaration

  ```swift
  {declaration section}
  ```

  ## Overview / Discussion

  {content sections, in sort_order}

  ## Topics

  {topic sections with links}

  ## Relationships

  {relationship sections}

  ## See Also

  {see_also sections}
```

### HTML Renderer (from normalized model)

```
NormalizedDocument + NormalizedSection[] → HTML fragment string

Output structure:
  <h1>{title}</h1>
  <p class="abstract">{abstract}</p>
  <section class="declaration">
    <h2>Declaration</h2>
    <pre><code class="language-swift">{declaration}</code></pre>
  </section>
  <section class="discussion">
    <h2>Overview</h2>
    {content nodes → HTML}
  </section>
  <section class="topics">
    <h2>Topics</h2>
    {topic groups with links}
  </section>
  ...
```

### Content Node → HTML Mapping

| DocC Node | HTML Output |
|---|---|
| `paragraph` | `<p>{inline}</p>` |
| `heading` (level N) | `<hN id="{anchor}">{text}</hN>` |
| `codeListing` | `<pre><code class="language-{syntax}">{code}</code></pre>` |
| `unorderedList` | `<ul><li>{items}</li></ul>` |
| `orderedList` | `<ol><li>{items}</li></ol>` |
| `aside` (note) | `<aside class="note"><p class="aside-title">Note</p>{content}</aside>` |
| `aside` (important) | `<aside class="important">...</aside>` |
| `table` | `<table><thead>...</thead><tbody>...</tbody></table>` |
| `termList` | `<dl><dt>{term}</dt><dd>{definition}</dd></dl>` |
| `text` | `{text}` |
| `codeVoice` | `<code>{text}</code>` |
| `emphasis` | `<em>{text}</em>` |
| `reference` | `<a href="/docs/{path}">{title}</a>` |
| `link` | `<a href="{destination}">{text}</a>` |
| `image` | `<img src="{url}" alt="{alt}">` |
| `strikethrough` | `<del>{text}</del>` |

---

## 6. WWDC Source Specifications

### Apple Official API (2020+)

**Session list endpoint**: `developer.apple.com/tutorials/data/videos/wwdc{year}.json`

Response shape:
```json
{
  "sections": [{
    "groups": [{
      "items": [{
        "id": "...",
        "title": "What's new in SwiftUI",
        "description": "...",
        "url": "/videos/play/wwdc2024/10144/"
      }]
    }]
  }]
}
```

**Session detail endpoint**: `developer.apple.com/tutorials/data/videos/play/wwdc{year}/{id}.json`

### ASCIIwwdc (2012-2020)

**Repository**: `github.com/ASCIIwwdc/asciiwwdc-content`
**Structure**: `/{year}/{session_id}.txt`
**Format**: Plain text transcript, one paragraph per speaker turn

### Normalization

```js
{
  document: {
    sourceType: 'wwdc',
    key: `wwdc/${year}/${sessionId}`,
    title: sessionTitle,
    kind: 'wwdc-session',
    framework: primaryFramework || null,
    sourceMetadata: JSON.stringify({
      year, sessionId, track, duration, speakers, frameworks: mentionedFrameworks
    })
  },
  sections: [
    { sectionKind: 'abstract', contentText: description, sortOrder: 0 },
    { sectionKind: 'transcript', contentText: fullTranscript, sortOrder: 1 }
  ]
}
```

---

## 7. Pre-Built Snapshot Format

### Archive Structure

```
apple-docs-standard-v2.0.0.tar.gz
├── apple-docs.db              # SQLite database
├── manifest.json              # Snapshot manifest
└── raw-json/                  # Raw JSON files (full tier only)
    └── documentation/...
```

### Manifest Schema

```json
{
  "version": "2.0.0",
  "schemaVersion": 6,
  "tier": "standard",
  "createdAt": "2026-04-13T06:00:00Z",
  "buildCommit": "abc123",
  "sources": {
    "apple-docc": { "count": 330000, "lastSync": "2026-04-13T05:00:00Z" },
    "hig": { "count": 500, "lastSync": "2026-04-13T05:00:00Z" },
    "guidelines": { "count": 57, "lastSync": "2026-04-13T05:00:00Z" },
    "swift-evolution": { "count": 450, "lastSync": "2026-04-13T05:00:00Z" },
    "wwdc": { "count": 3200, "lastSync": "2026-04-13T05:00:00Z" }
  },
  "totalDocuments": 334207,
  "checksum": "sha256:abc123...",
  "size": 125829120,
  "compressedSize": 94371840
}
```

### Tier Contents

| Tier | Database Tables | Raw Files | Estimated Compressed |
|---|---|---|---|
| `lite` | documents, documents_fts, framework_synonyms, roots, snapshot_meta | None | ~80 MB |
| `standard` | All of lite + documents_trigram, documents_body_fts, document_sections, document_relationships | None | ~120 MB |
| `full` | All of standard | raw-json/ directory | ~400 MB |

---

## 8. Static Site Search Artifact Format

### Title Index (`title-index.json`)

Compact array format for minimal download size:

```json
{
  "frameworks": ["swiftui", "foundation", "uikit", "combine", ...],
  "entries": [
    ["documentation/swiftui/view", "View", "A type that represents part of your app", 0],
    ["documentation/swiftui/text", "Text", "A view that displays one or more lines", 0],
    ...
  ]
}
```

Each entry: `[path, title, abstract_80chars, framework_index]`

**Estimated size**: 330K entries × ~80 bytes = ~26 MB uncompressed, ~4-6 MB gzipped.

### Body Shards (`shards/{prefix}.json`)

Partitioned by first character of framework name:

```json
{
  "documentation/swiftui/view": "A type that represents part of your app's user interface and provides modifiers...",
  "documentation/swiftui/text": "A view that displays one or more lines of read-only text..."
}
```

Each value truncated to 500 characters. Loaded on demand by the search worker.

### Aliases (`aliases.json`)

```json
{
  "coreanimation": "quartzcore",
  "quartzcore": "coreanimation",
  "coregraphics": "quartz2d"
}
```

---

## 9. File Organization (Target State)

```
apple-docs/
├── cli.js                          # CLI entry point
├── index.js                        # MCP server entry point
├── package.json
├── bun.lock
├── tsconfig.json
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Lint, typecheck, test
│       ├── snapshot.yml            # Weekly snapshot build
│       └── release-binaries.yml    # Cross-platform binary build
├── src/
│   ├── sources/                    # Source adapters (Phase 2)
│   │   ├── base.js
│   │   ├── registry.js
│   │   ├── apple-docc.js
│   │   ├── hig.js
│   │   ├── guidelines.js
│   │   ├── swift-evolution.js      # Phase 4
│   │   ├── swift-org.js            # Phase 4
│   │   ├── swift-book.js           # Phase 4
│   │   ├── apple-archive.js        # Phase 4
│   │   ├── wwdc.js                 # Phase 4
│   │   ├── sample-code.js          # Phase 4
│   │   └── packages.js             # Phase 4 (deferred)
│   ├── content/                    # Normalized content model (Phase 1)
│   │   ├── normalize.js
│   │   ├── render-markdown.js
│   │   ├── render-html.js
│   │   ├── render-text.js
│   │   └── render-snippet.js
│   ├── search/                     # Search quality (Phase 5)
│   │   ├── ranking.js
│   │   └── intent.js
│   ├── storage/                    # Database & storage
│   │   ├── database.js
│   │   ├── files.js
│   │   ├── profiles.js             # Phase 8
│   │   └── migrations/
│   │       ├── v5-multi-source.js   # Phase 0
│   │       └── v6-normalized-model.js # Phase 1
│   ├── commands/                   # CLI commands
│   │   ├── search.js
│   │   ├── lookup.js
│   │   ├── browse.js
│   │   ├── sync.js
│   │   ├── update.js
│   │   ├── status.js
│   │   ├── frameworks.js
│   │   ├── index.js
│   │   ├── consolidate.js          # doctor
│   │   ├── setup.js                # Phase 6
│   │   ├── snapshot.js             # Phase 6
│   │   ├── storage.js              # Phase 8
│   │   └── web-deploy.js           # Phase 7
│   ├── mcp/                        # MCP server
│   │   ├── server-sdk.js           # Phase 3 (official SDK)
│   │   ├── schemas.js              # Phase 3
│   │   └── handlers.js             # Phase 3
│   ├── web/                        # Static website (Phase 7)
│   │   ├── build.js
│   │   ├── serve.js
│   │   ├── templates.js
│   │   ├── search-artifacts.js
│   │   ├── assets/
│   │   │   ├── style.css
│   │   │   ├── search.js
│   │   │   └── theme.js
│   │   └── worker/
│   │       └── search-worker.js
│   ├── apple/                      # Apple-specific (legacy, migrated to sources/)
│   │   ├── api.js                  # Shared HTTP utilities
│   │   ├── extractor.js            # → moved into apple-docc adapter
│   │   ├── renderer.js             # → moved into content/render-markdown.js
│   │   ├── normalizer.js           # Path normalization (kept)
│   │   └── guidelines-parser.js    # → moved into guidelines adapter
│   ├── pipeline/                   # Pipeline (largely replaced by adapters)
│   │   ├── discover.js             # → delegates to adapter.discover()
│   │   ├── download.js             # → delegates to adapter.fetch()
│   │   ├── convert.js              # → delegates to content/renderers
│   │   ├── index-body.js           # Uses document_sections
│   │   └── sync-guidelines.js      # → moved into guidelines adapter
│   ├── cli/
│   │   ├── parser.js
│   │   ├── help.js
│   │   ├── formatter.js
│   │   └── mcp-entry.js            # Backward-compat shim
│   └── lib/
│       ├── rate-limiter.js
│       ├── semaphore.js
│       ├── fuzzy.js
│       ├── logger.js
│       ├── hash.js
│       └── yaml.js
├── test/
│   ├── unit/
│   │   ├── database.test.js
│   │   ├── extractor.test.js
│   │   ├── normalizer.test.js
│   │   ├── rate-limiter.test.js
│   │   ├── renderer.test.js
│   │   ├── normalize.test.js        # Phase 1
│   │   ├── renderers.test.js        # Phase 1
│   │   ├── ranking.test.js          # Phase 5
│   │   ├── intent.test.js           # Phase 5
│   │   └── adapters/                # Phase 2/4
│   │       ├── base.test.js
│   │       ├── apple-docc.test.js
│   │       ├── hig.test.js
│   │       ├── guidelines.test.js
│   │       └── ...
│   ├── mcp/
│   │   └── contract.test.js         # Phase 3
│   ├── integration/
│   │   ├── sync.test.js             # Phase 0
│   │   ├── search.test.js           # Phase 0
│   │   └── migrations.test.js       # Phase 8
│   ├── golden/
│   │   ├── search-queries.json      # Phase 0
│   │   └── search-benchmark.test.js # Phase 0
│   ├── benchmarks/
│   │   ├── search-benchmark.js      # Phase 5
│   │   └── history.js               # Phase 8
│   └── fixtures/
│       └── swiftui-view.json
└── docs/
    ├── research-1/
    ├── research-2/
    └── plan/                        # This plan
```
