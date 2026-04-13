# Phase 5: Search Quality Upgrade

> **Goal**: Make apple-docs search materially better than any competitor through metadata-aware ranking, filters, snippets, and source-aware reranking.

## Current Search Architecture (Baseline)

The existing 4-tier cascade:
1. **FTS5** — BM25 over title/abstract/declaration with exact/prefix/contains tiering
2. **Trigram** — Substring title matching (if < 5 results, query ≥ 3 chars)
3. **Levenshtein** — Fuzzy with 40% trigram pre-filter (if < 5 results, query ≥ 4 chars)
4. **Body** — Full-text body search with 200ms delay (if index built)

This is already the most sophisticated offline search in the ecosystem. Phase 5 adds the **metadata layer** on top.

## Exit Criteria

- [ ] Platform version filtering works (`--min-ios 17`, `--platform visionos`)
- [ ] Source type filtering works (`--source wwdc`, `--source swift-evolution`)
- [ ] Language filtering works (`--language swift`, `--language objc`)
- [ ] Framework aliases/synonyms expand queries (CoreAnimation ↔ QuartzCore)
- [ ] Snippet generation returns highlighted context for results
- [ ] Source-aware reranking applies 8+ heuristic rules
- [ ] Release notes are down-weighted in default search
- [ ] Golden query suite passes with improved or equal quality
- [ ] Search latency remains < 50ms for 95th percentile queries

---

## Tasks

### 5.1 — Platform Version Filtering

**Files to modify**: `src/commands/search.js`, `src/storage/database.js`

Add SQL WHERE clauses using the `min_ios`, `min_macos`, etc. columns from Phase 0 schema:

```sql
-- Example: search for SwiftUI views available on iOS 17+
SELECT * FROM documents_fts
JOIN documents ON documents.id = documents_fts.rowid
WHERE documents_fts MATCH ?
  AND (documents.min_ios IS NULL OR documents.min_ios <= '17.0')
```

**CLI flags**:
- `--min-ios <version>` — Only results available on iOS N+
- `--min-macos <version>` — Only results available on macOS N+
- `--platform <name>` — Only results available on platform (ios, macos, watchos, tvos, visionos)

**MCP tool params**: Add `min_ios`, `min_macos`, `platform` to `search_docs` schema.

### 5.2 — Source Type Filtering

**Files to modify**: `src/commands/search.js`

```sql
WHERE documents.source_type IN ('apple-docc', 'hig')  -- when --source specified
```

This is straightforward with the `source_type` column. Support comma-separated values:
- `--source apple-docc,hig` — Search only Apple docs and HIG
- `--source wwdc` — Search only WWDC transcripts

### 5.3 — Language Filtering

**Files to modify**: `src/commands/search.js`

```sql
WHERE (documents.language = 'swift' OR documents.language = 'both' OR documents.language IS NULL)
```

- `--language swift` — Only Swift APIs
- `--language objc` — Only Objective-C APIs

### 5.4 — Framework Aliases & Synonyms

**Files to modify**: `src/commands/search.js`, `src/storage/database.js`

Use the `framework_synonyms` table from Phase 0:

```js
function expandQuery(query, db) {
  // Check if any word in query matches an alias
  const words = query.split(/\s+/);
  const expanded = words.map(word => {
    const canonical = db.getCanonicalFramework(word.toLowerCase());
    if (canonical && canonical !== word.toLowerCase()) {
      return `(${word} OR ${canonical})`;
    }
    return word;
  });
  return expanded.join(' ');
}
```

**Seed synonyms**:
```
CoreAnimation ↔ QuartzCore
Combine ↔ ReactiveStreams  
UIKit ↔ UIKitCore
CoreGraphics ↔ Quartz2D
CoreData ↔ NSPersistentContainer
Metal ↔ MetalKit ↔ MetalPerformanceShaders
ARKit ↔ RealityKit (related, not exact)
```

### 5.5 — Snippet Generation

**Files to create**: `src/content/render-snippet.js` (if not created in Phase 1)
**Files to modify**: `src/commands/search.js`, `src/mcp/handlers.js`

Generate contextual snippets for search results:

```js
/**
 * Extract a snippet from document sections matching query terms.
 * @param {NormalizedDocument} doc
 * @param {NormalizedSection[]} sections
 * @param {string} query
 * @param {number} maxLength - Max snippet length (default 200)
 * @returns {string} - Snippet with query terms wrapped in ** for highlighting
 */
export function renderSnippet(doc, sections, query, maxLength = 200) {
  const terms = query.toLowerCase().split(/\s+/);

  // Priority: find match in abstract > declaration > first content section > discussion
  for (const section of sections) {
    const text = section.content_text;
    const matchIndex = findBestMatch(text, terms);
    if (matchIndex >= 0) {
      return extractWindow(text, matchIndex, maxLength, terms);
    }
  }

  // Fallback: truncated abstract
  return doc.abstract_text?.slice(0, maxLength) + '...';
}
```

### 5.6 — Source-Aware Reranking Heuristics

**File to create**: `src/search/ranking.js`
**Files to modify**: `src/commands/search.js`

Apply post-BM25 reranking heuristics. These are deterministic score adjustments, not ML models:

```js
/**
 * Apply reranking heuristics to raw search results.
 * @param {SearchResult[]} results - Raw BM25-ranked results
 * @param {string} query - Original query
 * @param {object} options - Filter/boost options
 * @returns {SearchResult[]} - Reranked results
 */
export function rerank(results, query, options = {}) {
  return results
    .map(r => ({ ...r, adjustedScore: applyHeuristics(r, query, options) }))
    .sort((a, b) => b.adjustedScore - a.adjustedScore);
}
```

**The 8 Reranking Rules**:

| # | Rule | Adjustment | Rationale |
|---|---|---|---|
| R1 | **Exact path/identifier match** | Score × 3.0 | If query matches a path segment exactly, it's almost certainly the right result |
| R2 | **Symbol kind boost for symbol queries** | Score × 1.5 | If query looks like a type name (CamelCase), boost Structures/Protocols/Classes |
| R3 | **Guide boost for "how do I" queries** | Score × 1.3 | If query contains "how", "guide", "tutorial", boost articles/tutorials |
| R4 | **Release notes penalty** | Score × 0.4 | Release notes rarely answer developer questions; down-weight 2.5× |
| R5 | **Archived content penalty** | Score × 0.6 | Legacy/archived content less relevant unless explicitly searched |
| R6 | **Code example boost** | Score × 1.2 | Documents with code samples are more actionable |
| R7 | **Depth penalty** | Score × (1.0 - depth × 0.05) | Deeper pages (url_depth > 5) are usually less relevant |
| R8 | **Source freshness boost** | Score × 1.1 for recent sources | WWDC current year, recently updated docs get slight boost |

### 5.7 — Query Intent Detection

**File to create**: `src/search/intent.js`

Simple heuristic query classification:

```js
/**
 * Classify query intent to inform reranking.
 * @param {string} query
 * @returns {{ type: 'symbol'|'concept'|'howto'|'error'|'general', confidence: number }}
 */
export function classifyIntent(query) {
  // Symbol: CamelCase, starts with uppercase, contains no spaces
  if (/^[A-Z][a-zA-Z0-9]+$/.test(query)) return { type: 'symbol', confidence: 0.9 };

  // How-to: starts with "how", contains "guide", "tutorial"
  if (/^how\b|guide|tutorial|example/i.test(query)) return { type: 'howto', confidence: 0.8 };

  // Error: contains "error", "crash", "fix", "issue"
  if (/error|crash|fix|issue|bug|fail/i.test(query)) return { type: 'error', confidence: 0.7 };

  // Concept: multi-word, lowercase
  if (query.includes(' ') && query === query.toLowerCase()) return { type: 'concept', confidence: 0.6 };

  return { type: 'general', confidence: 0.5 };
}
```

### 5.8 — Related Document Graph

**Files to modify**: `src/commands/search.js`, `src/mcp/handlers.js`

Expose document relationships in search results and as a standalone query:

```js
// In search results, include related docs count
result.relatedCount = db.countRelationships(result.key);

// Standalone: get related docs for a given page
export async function getRelatedDocs(key, ctx) {
  const rels = db.getRelationships(key);
  return {
    children: rels.filter(r => r.relation_type === 'child'),
    seeAlso: rels.filter(r => r.relation_type === 'see_also'),
    conformsTo: rels.filter(r => r.relation_type === 'conforms_to'),
    inheritsFrom: rels.filter(r => r.relation_type === 'inherits_from'),
  };
}
```

### 5.9 — Search Benchmark Suite

**Files to create**: `test/benchmarks/search-benchmark.js`

Automated benchmark that runs after search changes:

```js
const benchmarks = [
  { name: 'exact-symbol', query: 'NavigationStack', expectedLatency: 10 },
  { name: 'fuzzy-typo', query: 'Navigaton', expectedLatency: 30 },
  { name: 'multi-word', query: 'async await concurrency', expectedLatency: 20 },
  { name: 'body-search', query: 'how to implement custom layout', expectedLatency: 200 },
  { name: 'filtered', query: 'View --source apple-docc --min-ios 17', expectedLatency: 15 },
];

// Run each 100 times, report p50, p95, p99
```

## Files Changed Summary

| File | Action |
|---|---|
| `src/commands/search.js` | Modify (filters, reranking, snippets) |
| `src/storage/database.js` | Modify (filter queries, alias lookups) |
| `src/search/ranking.js` | Create |
| `src/search/intent.js` | Create |
| `src/content/render-snippet.js` | Create or modify |
| `src/mcp/schemas.js` | Modify (add filter params) |
| `src/mcp/handlers.js` | Modify (pass filters, return snippets) |
| `src/cli/formatter.js` | Modify (display snippets, source labels) |
| `test/unit/ranking.test.js` | Create |
| `test/unit/intent.test.js` | Create |
| `test/benchmarks/search-benchmark.js` | Create |
| `test/golden/search-queries.json` | Update |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reranking heuristics degrade some queries | Medium | Medium | Golden query suite catches regressions; heuristics are tunable constants |
| Filter combinations create slow queries | Low | Medium | Index on source_type, language, min_* columns; benchmark |
| Snippet generation is slow for body search | Medium | Low | Limit snippet to first match; cache snippets |
| Framework aliases cause false positives | Low | Low | Aliases are curated, not auto-generated; easy to adjust |
