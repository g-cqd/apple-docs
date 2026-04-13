# Phase 0: Stabilize & Foundation

> **Goal**: Create guardrails, fix known bugs, establish the namespace, and lay the schema foundation before deeper architectural changes.

## Exit Criteria

- [ ] CI exists (GitHub Actions: install Bun, lint, test)
- [ ] `bun.lock` committed
- [ ] `tsconfig.json` with `allowJs` — progressive TypeScript enabled
- [ ] HTML root update bug fixed for Guidelines
- [ ] `read` command falls back to on-demand JSON rendering when Markdown missing
- [ ] Command namespace redesigned (`mcp start`, `web` reserved)
- [ ] Schema v5 migration applied (source_type, platform columns, metadata JSON)
- [ ] Golden search query suite established (baseline for regression detection)
- [ ] All 53+ existing tests still pass

## Tasks

### 0.1 — Lock Dependencies & Toolchain

**Files to modify**: `package.json`, new `bun.lock`, new `tsconfig.json`, new `.github/workflows/ci.yml`

1. Run `bun install` to generate `bun.lock` — commit it
2. Add `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "esnext",
       "module": "esnext",
       "moduleResolution": "bundler",
       "allowJs": true,
       "checkJs": false,
       "strict": false,
       "noEmit": true,
       "types": ["bun-types"],
       "baseUrl": ".",
       "paths": { "#src/*": ["./src/*"] }
     },
     "include": ["src/**/*", "test/**/*", "cli.js", "index.js"]
   }
   ```
3. Add scripts to `package.json`:
   ```json
   {
     "scripts": {
       "test": "bun test",
       "typecheck": "bun x tsc --noEmit",
       "lint": "bun x biome check ./src ./test",
       "ci": "bun run lint && bun run typecheck && bun test"
     }
   }
   ```
4. Create `.github/workflows/ci.yml`:
   - Trigger on push/PR to main
   - Install Bun, run `bun run ci`
   - Matrix: ubuntu-latest, macos-latest

### 0.2 — Fix HTML Root Update Bug

**Files to modify**: `src/commands/update.js`, `src/pipeline/sync-guidelines.js`

**Problem**: The update flow uses `checkDocPage` (ETag/HEAD request) for all pages, but Guidelines are fetched from HTML, not the JSON API. This means Guidelines updates/deletions may be missed.

**Fix**:
1. In `update.js`, detect `source_type = 'guidelines'` pages and skip JSON-based ETag checking
2. For guidelines pages, re-fetch the HTML page and diff against stored content
3. Handle section additions, modifications, and deletions explicitly
4. Add test: mock guidelines HTML with changed section, verify update detects it

### 0.3 — Add `read` Fallback Rendering

**Files to modify**: `src/commands/lookup.js`, `src/apple/renderer.js`

**Problem**: If Markdown file is missing, `read`/`lookup` fails instead of rendering on-demand from raw JSON.

**Fix**:
1. In `lookup.js`, when Markdown file read fails:
   - Load raw JSON from `raw-json/{path}.json`
   - Call `renderer.render(json)` to produce Markdown
   - Return the rendered content (do not persist by default)
2. Add performance logging: measure render time per page
3. Add test: delete a Markdown file, verify `read` still returns content from JSON

### 0.4 — Command Namespace Redesign

**Files to modify**: `cli.js`, `src/cli/parser.js`, `src/cli/help.js`, `package.json`

**New namespace**:
```
apple-docs sync [--sources X]       # Crawl/update documentation
apple-docs search <query>           # Full-text search
apple-docs read <path>              # Fetch document content
apple-docs browse <framework>       # Topic tree exploration
apple-docs frameworks               # List all roots
apple-docs update                   # Incremental ETag-based update
apple-docs index                    # Build full-body search index
apple-docs doctor                   # Diagnose and repair corpus
apple-docs status                   # Corpus statistics

apple-docs mcp start               # Start MCP stdio server
apple-docs mcp install              # Print setup instructions
apple-docs mcp config               # Show current MCP configuration

apple-docs web serve                # Dev server (localhost:3000)
apple-docs web build                # Build static site
apple-docs web deploy               # Publish static site

apple-docs setup                    # Download pre-built database (Phase 6)
apple-docs storage profile          # Set storage profile (Phase 8)
apple-docs storage stats            # Show disk usage breakdown (Phase 8)
apple-docs storage gc               # Garbage collect caches (Phase 8)
```

**Implementation**:
1. In `cli.js`, add `mcp` and `web` as top-level commands that dispatch to sub-commands
2. `apple-docs mcp start` replaces direct `index.js` invocation for stdio
3. Create `src/cli/mcp-entry.js` as backward-compatible shim:
   ```js
   // apple-docs-mcp binary entry — delegates to mcp start
   import { startMcpServer } from '../mcp/server.js';
   startMcpServer();
   ```
4. Update `package.json` bins:
   ```json
   { "bin": { "apple-docs": "./cli.js", "apple-docs-mcp": "./src/cli/mcp-entry.js" } }
   ```
5. Reserve `web` and `storage` commands as stubs that print "Coming in a future release"
6. Update help text in `src/cli/help.js`

### 0.5 — Schema v5 Migration

**Files to modify**: `src/storage/database.js`

**New columns on `roots` table**:
```sql
ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc';
-- Values: 'apple-docc', 'hig', 'guidelines', 'swift-evolution', 'swift-org',
--         'swift-book', 'apple-archive', 'wwdc', 'sample-code', 'packages'
```

**New columns on `pages` table**:
```sql
ALTER TABLE pages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc';
ALTER TABLE pages ADD COLUMN language TEXT;           -- 'swift', 'objc', 'both', NULL
ALTER TABLE pages ADD COLUMN is_release_notes INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN url_depth INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN doc_kind TEXT;           -- 'symbol', 'article', 'tutorial', 'sample', ...
ALTER TABLE pages ADD COLUMN source_metadata TEXT;    -- JSON blob for source-specific data
ALTER TABLE pages ADD COLUMN min_ios TEXT;
ALTER TABLE pages ADD COLUMN min_macos TEXT;
ALTER TABLE pages ADD COLUMN min_watchos TEXT;
ALTER TABLE pages ADD COLUMN min_tvos TEXT;
ALTER TABLE pages ADD COLUMN min_visionos TEXT;
```

**New table**:
```sql
CREATE TABLE IF NOT EXISTS framework_synonyms (
  canonical TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  PRIMARY KEY (canonical, alias)
);
-- Seed: CoreAnimation ↔ QuartzCore, Combine ↔ ReactiveStreams, etc.
```

**Migration strategy**:
1. Add migration v5 to the existing version-gated migration system in `database.js`
2. Backfill `source_type` from root kind ('design' → 'hig', 'guidelines' → 'guidelines', else 'apple-docc')
3. Backfill `language` by scanning raw JSON declarations for 'swift' or 'occ'
4. Backfill `is_release_notes` by path heuristic (`/release-notes/` or role = 'releaseNotes')
5. Backfill `url_depth` as `path.split('/').length`
6. Backfill `doc_kind` from existing `role` column mapping
7. Parse `platforms` string to populate `min_ios`, `min_macos`, etc.

### 0.6 — Golden Search Query Suite

**Files to create**: `test/golden/search-queries.json`, `test/golden/search-benchmark.test.js`

**Purpose**: Establish a baseline of expected search behavior that detects regressions across all future phases.

**Structure**:
```json
[
  {
    "query": "NavigationStack",
    "expect": {
      "first_result_path": "documentation/swiftui/navigationstack",
      "top_5_contain": ["documentation/swiftui/navigationstack"],
      "max_latency_ms": 50
    }
  },
  {
    "query": "async await",
    "expect": {
      "top_5_contain": ["documentation/swift/concurrency"],
      "min_results": 5
    }
  }
]
```

Create 20-30 golden queries covering:
- Exact symbol lookup (NavigationStack, URLSession, View)
- CamelCase expansion (NavigationSplitView → navigation split view)
- Fuzzy/typo tolerance (Navigaton → NavigationStack)
- Framework-scoped search (SwiftUI + List)
- Multi-word conceptual search ("async await", "push notifications")
- Body search queries (if index built)

### 0.7 — Integration Test Harness

**Files to create**: `test/integration/sync.test.js`, `test/integration/search.test.js`

**Purpose**: End-to-end tests using a small fixture corpus (not full Apple docs).

1. Create a minimal test corpus: 5-10 mock JSON files representing a small framework
2. Test full pipeline: discover → crawl → download → convert → index → search
3. Test update: modify a fixture, run update, verify change detected
4. Test search tiers: exact, prefix, trigram, fuzzy against known corpus
5. Use temporary database (`:memory:` or tmp dir)

## Files Changed Summary

| File | Action | Phase Task |
|---|---|---|
| `package.json` | Modify (scripts, bins) | 0.1, 0.4 |
| `bun.lock` | Create | 0.1 |
| `tsconfig.json` | Create | 0.1 |
| `.github/workflows/ci.yml` | Create | 0.1 |
| `src/commands/update.js` | Modify (guidelines handling) | 0.2 |
| `src/pipeline/sync-guidelines.js` | Modify (diff detection) | 0.2 |
| `src/commands/lookup.js` | Modify (fallback rendering) | 0.3 |
| `cli.js` | Modify (mcp/web dispatch) | 0.4 |
| `src/cli/parser.js` | Modify (sub-command parsing) | 0.4 |
| `src/cli/help.js` | Modify (new namespace) | 0.4 |
| `src/cli/mcp-entry.js` | Create (compat shim) | 0.4 |
| `src/storage/database.js` | Modify (migration v5) | 0.5 |
| `test/golden/search-queries.json` | Create | 0.6 |
| `test/golden/search-benchmark.test.js` | Create | 0.6 |
| `test/integration/sync.test.js` | Create | 0.7 |
| `test/integration/search.test.js` | Create | 0.7 |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Schema migration breaks existing databases | Medium | High | Backup before migration; version-gated rollback |
| Namespace change confuses existing users | Low | Medium | `apple-docs-mcp` binary preserved; help text updated |
| TypeScript setup introduces friction | Low | Low | `allowJs` + `checkJs: false` — zero disruption to existing JS |
