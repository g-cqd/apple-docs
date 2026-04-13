# Phase 8: Storage Profiles & Polish

> **Goal**: Give users explicit control over disk usage, add operational hardening, and finalize the platform from "powerful" to "trusted."
>
> **Depends on**: Phase 6 (complete)
> **Can parallel with**: Phase 7 (static website — orthogonal concerns: website reads from content model, storage controls materialization)
>
> **Parallelization rationale**: All Phase 8 tasks (Parts A, B, and C) operate on the storage layer, CLI commands, test infrastructure, and legacy cleanup. None require Phase 7's static site builder, web templates, or client-side search artifacts. The `prebuilt` storage profile's `persistHtml: true` option uses the existing `render-html.js` renderer from Phase 1, not Phase 7's full-page templates.

## Part A: Storage Profiles

### Why Storage Profiles

Currently apple-docs writes 3 copies of every document: SQLite metadata, raw JSON, and Markdown. Total: ~4.5 GB. Most users don't need all three. Storage profiles let users choose their trade-off:

| Profile | Raw JSON | Normalized DB | Markdown | HTML | Disk Usage | Best For |
|---|---|---|---|---|---|---|
| `raw-only` | Yes | Yes | No | No | ~2.5 GB | CI, headless MCP, minimal disk |
| `balanced` | Yes | Yes | On-demand cache | No | ~2.5-3.5 GB | **Default** — most developers |
| `prebuilt` | Yes | Yes | Yes | Yes | ~5+ GB | Offline power users, snapshot builds |

### Exit Criteria (Storage)

- [ ] `apple-docs storage profile set <name>` changes active profile
- [ ] `apple-docs storage stats` shows per-category disk usage
- [ ] `apple-docs storage materialize markdown [--roots ...]` generates markdown on demand
- [ ] `apple-docs storage materialize html [--roots ...]` generates HTML on demand
- [ ] `apple-docs storage gc` removes cached materializations
- [ ] `read` command respects profile (renders on-demand for raw-only/balanced)
- [ ] Markdown is never a correctness dependency

### Tasks

#### 8.1 — Storage Profile Configuration

**File to create**: `src/storage/profiles.js`

```js
const PROFILES = {
  'raw-only': {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: false,
    description: 'Minimal disk usage. Renders on-demand.',
  },
  'balanced': {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: true,       // Cache Markdown on first read
    cacheMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    description: 'Default. Caches on first read, evicts after 7 days.',
  },
  'prebuilt': {
    persistMarkdown: true,
    persistHtml: true,
    cacheOnRead: false,       // Already materialized
    description: 'Full materialization. Largest disk usage.',
  }
};

export function getProfile(db) {
  return db.getConfig('storage_profile') || 'balanced';
}

export function setProfile(db, name) {
  if (!PROFILES[name]) throw new Error(`Unknown profile: ${name}. Use: ${Object.keys(PROFILES).join(', ')}`);
  db.setConfig('storage_profile', name);
}
```

#### 8.2 — Storage Commands

**File to create**: `src/commands/storage.js`

```js
// apple-docs storage profile [set <name>]
// apple-docs storage stats
// apple-docs storage materialize <format> [--roots ...]
// apple-docs storage gc [--drop markdown,html] [--older-than 30d]

export async function storageCommand(ctx, args) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'profile':
      if (args[1] === 'set') {
        setProfile(ctx.db, args[2]);
        ctx.logger.info(`Storage profile set to: ${args[2]}`);
      } else {
        const profile = getProfile(ctx.db);
        ctx.logger.info(`Current profile: ${profile}`);
        ctx.logger.info(PROFILES[profile].description);
      }
      break;

    case 'stats':
      const stats = await computeStorageStats(ctx);
      ctx.logger.info(`Database:   ${formatSize(stats.database)}`);
      ctx.logger.info(`Raw JSON:   ${formatSize(stats.rawJson)}`);
      ctx.logger.info(`Markdown:   ${formatSize(stats.markdown)}`);
      ctx.logger.info(`HTML cache: ${formatSize(stats.html)}`);
      ctx.logger.info(`Total:      ${formatSize(stats.total)}`);
      break;

    case 'materialize':
      await materialize(ctx, args[1], args.slice(2));
      break;

    case 'gc':
      await garbageCollect(ctx, args.slice(1));
      break;
  }
}
```

#### 8.3 — On-Demand Rendering with Cache

**Files to modify**: `src/commands/lookup.js`

For `balanced` profile, cache rendered Markdown on first read:

```js
async function readDocument(key, ctx) {
  const profile = getProfile(ctx.db);

  // Try cached file first
  const mdPath = `${ctx.config.home}/markdown/${key}.md`;
  const mdFile = Bun.file(mdPath);
  if (await mdFile.exists()) {
    return mdFile.text();
  }

  // Render on-demand
  const doc = ctx.db.getDocumentByKey(key);
  const sections = ctx.db.getSections(doc.id);
  const markdown = renderMarkdown(doc, sections);

  // Cache if balanced profile
  if (profile === 'balanced') {
    await Bun.write(mdPath, markdown);
  }

  return markdown;
}
```

#### 8.4 — Garbage Collection

```js
async function garbageCollect(ctx, options) {
  const drops = parseDropOptions(options); // --drop markdown,html
  const olderThan = parseOlderThan(options); // --older-than 30d

  if (drops.includes('markdown')) {
    const count = await deleteDirectory(`${ctx.config.home}/markdown/`);
    ctx.logger.info(`Removed ${count} Markdown files`);
  }

  if (drops.includes('html')) {
    const count = await deleteDirectory(`${ctx.config.home}/html/`);
    ctx.logger.info(`Removed ${count} HTML files`);
  }

  if (olderThan) {
    const count = await deleteCachedOlderThan(`${ctx.config.home}/markdown/`, olderThan);
    ctx.logger.info(`Removed ${count} cached files older than ${olderThan}`);
  }
}
```

---

## Part B: Operational Hardening

### Exit Criteria (Hardening)

- [ ] Scheduled freshness checking (optional background update)
- [ ] Benchmark history tracked across versions
- [ ] Corpus integrity verification (checksums, document counts)
- [ ] Schema migration tested end-to-end
- [ ] `doctor` command comprehensively repairs all source types

### Tasks

#### 8.5 — Scheduled Freshness Checks

**Files to modify**: `src/commands/status.js`

```js
// apple-docs status --check-freshness
export async function checkFreshness(ctx) {
  const lastSync = ctx.db.getLastSyncTime();
  const daysSinceSync = (Date.now() - new Date(lastSync)) / (1000 * 60 * 60 * 24);

  if (daysSinceSync > 7) {
    ctx.logger.warn(`Corpus is ${Math.floor(daysSinceSync)} days old. Consider running 'apple-docs update'.`);
  }

  // Check each source's last update time
  const sources = ctx.db.getSourceUpdateTimes();
  for (const source of sources) {
    const days = (Date.now() - new Date(source.lastUpdate)) / (1000 * 60 * 60 * 24);
    if (days > 14) {
      ctx.logger.warn(`${source.displayName} not updated in ${Math.floor(days)} days`);
    }
  }
}
```

#### 8.6 — Benchmark History

**File to create**: `test/benchmarks/history.js`

Track search latency and sync throughput over time:

```js
export async function recordBenchmark(name, value, unit) {
  const historyFile = '.benchmarks/history.jsonl';
  const entry = {
    name,
    value,
    unit,
    timestamp: new Date().toISOString(),
    commit: await getGitCommit(),
  };
  await Bun.write(historyFile, JSON.stringify(entry) + '\n', { append: true });
}

// In CI:
// After tests pass, run benchmarks and record
// Alert if p95 search latency increases > 20%
```

#### 8.7 — Corpus Integrity Verification

**Files to modify**: `src/commands/consolidate.js`

Extend `doctor` to verify:
1. Every document in `documents` table has corresponding raw JSON on disk
2. All normalized sections are consistent with raw payloads (content_hash matches)
3. FTS5 indexes are in sync with documents table (row counts match)
4. Relationship graph has no dangling references
5. Source adapters can re-discover and verify document counts match

```js
// apple-docs doctor --verify-integrity
export async function verifyIntegrity(ctx) {
  const issues = [];

  // 1. Check raw JSON exists for each document
  const docs = ctx.db.getAllDocumentKeys();
  for (const key of docs) {
    const jsonPath = `${ctx.config.home}/raw-json/${key}.json`;
    if (!await Bun.file(jsonPath).exists()) {
      issues.push({ level: 'error', message: `Missing raw JSON: ${key}` });
    }
  }

  // 2. Check FTS sync
  const ftsCount = ctx.db.getFtsDocumentCount();
  const docCount = ctx.db.getDocumentCount();
  if (ftsCount !== docCount) {
    issues.push({ level: 'warn', message: `FTS count (${ftsCount}) != document count (${docCount}). Run 'apple-docs index' to rebuild.` });
  }

  // 3. Check dangling relationships
  const danglingRels = ctx.db.getDanglingRelationships();
  if (danglingRels.length > 0) {
    issues.push({ level: 'warn', message: `${danglingRels.length} dangling relationships found` });
  }

  return issues;
}
```

#### 8.8 — Migration End-to-End Tests

**File to create**: `test/integration/migrations.test.js`

Test that schema migrations work correctly:
1. Create database at schema v4 (current)
2. Run migration v5 (Phase 0)
3. Run migration v6 (Phase 1)
4. Verify all tables exist with correct columns
5. Verify data integrity after migration
6. Verify search still works after migration

#### 8.9 — Comprehensive Doctor Command

**Files to modify**: `src/commands/consolidate.js`

Make `doctor` source-aware:
```js
// apple-docs doctor [--fix] [--sources <list>]
export async function doctor(ctx, options) {
  const sources = options.sources ? parseSourceList(options.sources) : getAllAdapterTypes();

  for (const sourceType of sources) {
    ctx.logger.info(`Checking ${sourceType}...`);
    const adapter = getAdapter(sourceType);

    // Verify document count matches discovery
    if (options.fix) {
      // Re-normalize documents with outdated content_hash
      // Rebuild missing FTS entries
      // Clean up orphaned files
    }
  }
}
```

---

## Part C: Remove Transition Scaffolding

### Tasks

#### 8.10 — Remove Legacy `pages` Table Dependency

By this phase, all code should read from `documents` + `document_sections`. Remove:
- Migration code that populates legacy `pages` table
- Any remaining queries against `pages` table
- Eventually: drop `pages` table in a future migration

#### 8.11 — Remove Old MCP Server Files

If not already done in Phase 3:
- Delete `src/mcp/server.js` (old custom JSON-RPC)
- Delete `src/mcp/tools.js` (old tool dispatch)

#### 8.12 — Update README and Documentation

- Update README.md with new command namespace
- Document all source types and their coverage
- Document storage profiles
- Document MCP tools and resources
- Add architecture diagram

---

## Files Changed Summary

| File | Action |
|---|---|
| `src/storage/profiles.js` | Create |
| `src/commands/storage.js` | Create |
| `src/commands/lookup.js` | Modify (cache-aware rendering) |
| `src/commands/consolidate.js` | Modify (comprehensive doctor) |
| `src/commands/status.js` | Modify (freshness checks) |
| `cli.js` | Modify (storage commands) |
| `test/integration/migrations.test.js` | Create |
| `test/benchmarks/history.js` | Create |
| `src/storage/database.js` | Modify (remove pages dependency) |
| `README.md` | Update |

## Success Metrics (Full v2)

At the end of Phase 8, apple-docs v2 should satisfy ALL success criteria from the overview:

| Criterion | Verification |
|---|---|
| 11+ sources | `apple-docs status` shows all source types |
| Verified offline corpus | `apple-docs doctor --verify-integrity` passes |
| Official MCP SDK | Contract tests pass; MCP clients work |
| Reproducible snapshots | `apple-docs setup` downloads and verifies |
| Static website | `apple-docs web build && apple-docs web serve` works |
| Storage profiles | `apple-docs storage profile set raw-only` works |
| Cross-platform | CI passes on macOS + Linux |
| Search quality | Golden query suite passes; benchmarks meet targets |
