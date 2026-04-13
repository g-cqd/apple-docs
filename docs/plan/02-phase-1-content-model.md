# Phase 1: Canonical Normalized Content Model

> **Goal**: Make the corpus independent of pre-rendered Markdown. Introduce a normalized document representation that CLI, MCP, and the future static site all read from.

## Why This Phase Comes First

Both research efforts agree: Markdown should not be a required runtime artifact. Currently, search indexes are built from Markdown files, `read` fails without Markdown, and the storage model couples pipeline correctness to a presentation format. This phase decouples them, unlocking:

- On-demand rendering (any format, any time)
- Storage profiles (Phase 8)
- Static website generation (Phase 7) from the same model
- Source adapter normalization (Phase 2)

## Exit Criteria

- [ ] Normalized document schema defined and populated during sync
- [ ] Shared renderers: Markdown, HTML, plain text, snippet
- [ ] Search indexes built from normalized text, not Markdown files
- [ ] `read` command renders on-demand from normalized model (Markdown file optional)
- [ ] Body index builder uses normalized content
- [ ] All existing tests pass; golden search queries produce same or better results

## Normalized Document Model

### Core Entity: `documents` table

Replaces the semantic role of both `pages` table metadata and Markdown files as source-of-truth.

```sql
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,          -- 'apple-docc', 'hig', 'guidelines', ...
  key TEXT NOT NULL UNIQUE,           -- canonical path (e.g., 'documentation/swiftui/view')
  title TEXT NOT NULL,
  kind TEXT,                          -- 'symbol', 'article', 'tutorial', 'sample', ...
  role TEXT,                          -- Apple's role field (symbol, collectionGroup, etc.)
  role_heading TEXT,                  -- 'Structure', 'Protocol', 'Class', ...
  framework TEXT,                     -- primary framework/root slug
  url TEXT,                           -- full Apple URL
  language TEXT,                      -- 'swift', 'objc', 'both'
  abstract_text TEXT,                 -- plain text abstract
  declaration_text TEXT,              -- plain text declaration
  platforms_json TEXT,                -- JSON: {"ios": "13.0", "macos": "10.15", ...}
  min_ios TEXT,
  min_macos TEXT,
  min_watchos TEXT,
  min_tvos TEXT,
  min_visionos TEXT,
  is_deprecated INTEGER DEFAULT 0,
  is_beta INTEGER DEFAULT 0,
  is_release_notes INTEGER DEFAULT 0,
  url_depth INTEGER DEFAULT 0,
  source_metadata TEXT,              -- JSON blob for source-specific extras
  content_hash TEXT,                 -- hash of normalized content for change detection
  raw_payload_hash TEXT,             -- hash of raw JSON for staleness detection
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_documents_source ON documents(source_type);
CREATE INDEX idx_documents_framework ON documents(framework);
CREATE INDEX idx_documents_kind ON documents(kind);
CREATE INDEX idx_documents_language ON documents(language);
```

### Content Sections: `document_sections` table

Stores the structured content of each document, enabling selective rendering and search field extraction.

```sql
CREATE TABLE IF NOT EXISTS document_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL,         -- 'abstract', 'declaration', 'parameters', 'discussion',
                                     -- 'content', 'topics', 'relationships', 'see_also'
  heading TEXT,                       -- section heading if any
  content_text TEXT NOT NULL,         -- plain text for search indexing
  content_json TEXT,                  -- structured JSON for rendering (DocC content nodes)
  sort_order INTEGER NOT NULL,
  UNIQUE(document_id, section_kind, sort_order)
);

CREATE INDEX idx_sections_doc ON document_sections(document_id);
```

### Relationships: `document_relationships` table

```sql
CREATE TABLE IF NOT EXISTS document_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_key TEXT NOT NULL,             -- source document key
  to_key TEXT NOT NULL,               -- target document key
  relation_type TEXT NOT NULL,        -- 'child', 'see_also', 'conforms_to', 'inherits_from',
                                     -- 'sample_of', 'related_framework'
  section TEXT,                       -- grouping section name (e.g., topic section title)
  sort_order INTEGER DEFAULT 0,
  UNIQUE(from_key, to_key, relation_type)
);

CREATE INDEX idx_rel_from ON document_relationships(from_key);
CREATE INDEX idx_rel_to ON document_relationships(to_key);
```

## Tasks

### 1.1 — Create Normalized Schema & Migration

**Files to create**: `src/storage/migrations/v6-normalized-model.js`
**Files to modify**: `src/storage/database.js`

1. Add `documents`, `document_sections`, `document_relationships` tables
2. Keep existing `pages`, `roots`, `refs` tables for backward compatibility during transition
3. Migration populates `documents` from existing `pages` data:
   - Copy metadata fields directly
   - Parse `platforms` string into `min_ios`, `min_macos`, etc.
   - Set `content_hash` from existing raw JSON hash
4. Migration populates `document_sections` by loading raw JSON and extracting sections
5. Migration populates `document_relationships` from existing `refs` table

### 1.2 — Build Normalizer Module

**Files to create**: `src/content/normalize.js`

The normalizer takes a raw source payload and produces a normalized document + sections.

```js
/**
 * @param {object} rawPayload - Raw JSON from Apple's API (or any source)
 * @param {string} sourceType - 'apple-docc', 'hig', 'guidelines', etc.
 * @returns {{ document: NormalizedDocument, sections: NormalizedSection[] }}
 */
export function normalize(rawPayload, sourceType) { ... }
```

For Apple DocC payloads:
- Extract metadata from `rawPayload.metadata`
- Extract abstract from `rawPayload.abstract`
- Extract declarations from `rawPayload.primaryContentSections` where kind = 'declarations'
- Extract parameters from sections where kind = 'parameters'
- Extract discussion/content from sections where kind = 'content'
- Extract topics from `rawPayload.topicSections`
- Extract relationships from `rawPayload.relationshipsSections`
- Extract see-also from `rawPayload.seeAlsoSections`
- Build plain text for each section (for search indexing)
- Build structured JSON for each section (for rendering)

### 1.3 — Build Shared Renderers

**Files to create**: `src/content/render-markdown.js`, `src/content/render-html.js`, `src/content/render-text.js`, `src/content/render-snippet.js`

Each renderer takes a normalized document + sections and produces output:

```js
// render-markdown.js
export function renderMarkdown(document, sections) → string

// render-html.js
export function renderHtml(document, sections) → string

// render-text.js (for search indexing)
export function renderPlainText(document, sections) → string

// render-snippet.js (for search result previews)
export function renderSnippet(document, sections, query, maxLength) → string
```

**Markdown renderer**: Port existing `src/apple/renderer.js` logic but consume normalized sections instead of raw DocC JSON. Preserve YAML front matter, declarations, parameter tables, topic sections, cross-reference links.

**HTML renderer**: Produce standalone HTML fragments (no full page — that's Phase 7). Convert content nodes to semantic HTML. Code blocks with language hints. Declaration formatting.

**Plain text renderer**: Strip all formatting. Concatenate section texts. Used for search field population.

**Snippet renderer**: Given a query, find the best matching section, extract context window, highlight match terms. Return truncated text with `...` ellipsis.

### 1.4 — Rewire Sync Pipeline to Populate Normalized Model

**Files to modify**: `src/pipeline/discover.js`, `src/pipeline/download.js`, `src/pipeline/sync-guidelines.js`, `src/commands/sync.js`

During sync, after downloading raw JSON:
1. Call `normalize(rawPayload, sourceType)` to get normalized doc + sections
2. Upsert into `documents` table
3. Upsert sections into `document_sections` table
4. Extract relationships and upsert into `document_relationships`
5. Continue to write raw JSON to disk (canonical truth)
6. Optionally write Markdown to disk (if storage profile = 'balanced' or 'prebuilt')

**Backward compatibility**: Keep populating `pages` table in parallel during transition period. Remove in Phase 8.

### 1.5 — Rewire Search to Use Normalized Model

**Files to modify**: `src/commands/search.js`, `src/storage/database.js`

Update FTS5 indexes to be populated from normalized content:

```sql
-- Rebuild pages_fts to source from documents + document_sections
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, abstract, declaration, headings, path,
  content='documents',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Rebuild trigram index
CREATE VIRTUAL TABLE documents_trigram USING fts5(
  title,
  content='documents',
  content_rowid='id',
  tokenize='trigram'
);

-- Body search from sections
CREATE VIRTUAL TABLE documents_body_fts USING fts5(
  body,
  content='document_sections',
  tokenize='porter unicode61'
);
```

Search queries join against `documents` table for metadata (source_type, language, min_ios, etc.) to support future filtering.

### 1.6 — Rewire `read` / `lookup` to Render On-Demand

**Files to modify**: `src/commands/lookup.js`

The `read` path becomes:
1. Look up document in `documents` table by key
2. Load sections from `document_sections`
3. Call `renderMarkdown(document, sections)` to produce output
4. Return rendered content
5. Optionally: if Markdown file exists on disk, read directly (faster path)
6. Optionally: if Markdown file doesn't exist but raw JSON does, normalize → render

This eliminates the hard dependency on Markdown files.

### 1.7 — Rewire Body Index Builder

**Files to modify**: `src/pipeline/index-body.js`, `src/commands/index.js`

The `index` command now:
1. Reads normalized sections from `document_sections` (not Markdown files)
2. Concatenates section texts via `renderPlainText()`
3. Inserts into `documents_body_fts`
4. Incremental mode: only process documents where `content_hash` changed since last index

## Files Changed Summary

| File | Action |
|---|---|
| `src/storage/database.js` | Modify (new tables, FTS rebuild) |
| `src/storage/migrations/v6-normalized-model.js` | Create |
| `src/content/normalize.js` | Create |
| `src/content/render-markdown.js` | Create |
| `src/content/render-html.js` | Create |
| `src/content/render-text.js` | Create |
| `src/content/render-snippet.js` | Create |
| `src/pipeline/discover.js` | Modify |
| `src/pipeline/download.js` | Modify |
| `src/pipeline/sync-guidelines.js` | Modify |
| `src/commands/sync.js` | Modify |
| `src/commands/search.js` | Modify |
| `src/commands/lookup.js` | Modify |
| `src/pipeline/index-body.js` | Modify |
| `src/commands/index.js` | Modify |
| `test/unit/normalize.test.js` | Create |
| `test/unit/renderers.test.js` | Create |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration corrupts existing database | Medium | High | Transaction-wrapped migration; backup before running |
| Search quality regresses after FTS rebuild | Medium | Medium | Golden query suite (Phase 0.6) validates before/after |
| Normalizer misses edge cases in DocC JSON | Medium | Low | Test against real fixtures (swiftui-view.json); add more fixtures |
| Performance regression from on-demand rendering | Low | Low | Benchmark render times; cache in balanced profile |
