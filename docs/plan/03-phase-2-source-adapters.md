# Phase 2: Source Adapter Layer

> **Goal**: Stop adding sources as one-off pipelines. Introduce a plugin-like adapter contract so every source — existing and future — follows the same discover/fetch/normalize pattern.

## Why Before Source Expansion

Without this layer, each new source (Swift Evolution, WWDC, etc.) would be another bespoke pipeline file with its own fetch logic, storage conventions, and update strategy. The adapter pattern:

- Makes source addition a fill-in-the-blanks exercise
- Ensures consistent update/check behavior across all sources
- Enables `sync --sources swift-evolution,wwdc` filtering
- Provides source-level error isolation (one source fails, others continue)

## Exit Criteria

- [ ] Base adapter class/interface defined with discover/fetch/check/normalize contract
- [ ] Apple DocC source refactored to adapter pattern
- [ ] HIG source refactored to adapter pattern
- [ ] App Store Review Guidelines source refactored to adapter pattern
- [ ] `sync` command uses adapter registry to dispatch by source type
- [ ] `sync --sources <list>` flag works to sync specific sources
- [ ] Source-specific update checking is explicit and tested
- [ ] All existing tests pass; golden queries produce same results

## Source Adapter Contract

### Base Interface

**File to create**: `src/sources/base.js`

```js
/**
 * Every source adapter implements this interface.
 * Adapters are stateless — all state lives in the database.
 */
export class SourceAdapter {
  /** Unique source type identifier */
  static type = 'base';

  /** Human-readable name */
  static displayName = 'Base Source';

  /** Whether this source requires network access */
  static requiresNetwork = true;

  /**
   * Discover all indexable items from this source.
   * Returns an array of document keys to fetch.
   * @param {object} ctx - { db, logger, rateLimiter, config }
   * @returns {Promise<DiscoveryResult>}
   */
  async discover(ctx) { throw new Error('Not implemented'); }

  /**
   * Fetch a single document by key.
   * Returns the raw payload (JSON, HTML, Markdown, etc.)
   * @param {string} key - Document key from discovery
   * @param {object} ctx
   * @returns {Promise<FetchResult>}
   */
  async fetch(key, ctx) { throw new Error('Not implemented'); }

  /**
   * Check if a previously fetched document has changed.
   * Used by `update` command for incremental updates.
   * @param {string} key - Document key
   * @param {object} previousState - { etag, lastModified, contentHash }
   * @param {object} ctx
   * @returns {Promise<CheckResult>} - { changed: boolean, newState: object }
   */
  async check(key, previousState, ctx) { throw new Error('Not implemented'); }

  /**
   * Normalize a raw payload into the canonical document model.
   * @param {string} key
   * @param {object} rawPayload
   * @returns {NormalizeResult} - { document, sections, relationships }
   */
  normalize(key, rawPayload) { throw new Error('Not implemented'); }

  /**
   * Extract cross-references and relationships from a document.
   * Returns keys of related documents to seed into the crawl queue.
   * @param {string} key
   * @param {object} rawPayload
   * @returns {string[]} - Array of document keys to crawl
   */
  extractReferences(key, rawPayload) { return []; }

  /**
   * Source-specific rendering hints (e.g., "render WWDC with timestamps").
   * @returns {object}
   */
  renderHints() { return {}; }
}
```

### Type Definitions

```js
/** @typedef {{ keys: string[], roots: object[] }} DiscoveryResult */
/** @typedef {{ key: string, payload: object, etag?: string, lastModified?: string }} FetchResult */
/** @typedef {{ changed: boolean, newState: object }} CheckResult */
/** @typedef {{ document: object, sections: object[], relationships: object[] }} NormalizeResult */
```

### Adapter Registry

**File to create**: `src/sources/registry.js`

```js
import { AppleDoccAdapter } from './apple-docc.js';
import { HigAdapter } from './hig.js';
import { GuidelinesAdapter } from './guidelines.js';

const adapters = new Map();

export function registerAdapter(AdapterClass) {
  adapters.set(AdapterClass.type, AdapterClass);
}

export function getAdapter(sourceType) {
  const Adapter = adapters.get(sourceType);
  if (!Adapter) throw new Error(`Unknown source type: ${sourceType}`);
  return new Adapter();
}

export function getAllAdapters() {
  return [...adapters.values()].map(A => new A());
}

export function getAdapterTypes() {
  return [...adapters.keys()];
}

// Register built-in adapters
registerAdapter(AppleDoccAdapter);
registerAdapter(HigAdapter);
registerAdapter(GuidelinesAdapter);
```

## Tasks

### 2.1 — Implement Base Adapter Class

**File to create**: `src/sources/base.js`

Define the base class with the contract above. Include JSDoc types. Include validation helpers:
- `validateDiscoveryResult(result)` — checks shape
- `validateFetchResult(result)` — checks shape
- `validateNormalizeResult(result)` — checks required fields

### 2.2 — Refactor Apple DocC to Adapter

**File to create**: `src/sources/apple-docc.js`
**Files to reference**: `src/apple/api.js`, `src/apple/extractor.js`, `src/pipeline/discover.js`

```js
export class AppleDoccAdapter extends SourceAdapter {
  static type = 'apple-docc';
  static displayName = 'Apple Developer Documentation';

  async discover(ctx) {
    // Fetch technologies.json
    // Enumerate ~370 roots
    // Return all root keys
  }

  async fetch(key, ctx) {
    // Fetch /tutorials/data/documentation/{key}.json
    // Rate-limited, ETag-aware
    // Save raw JSON to disk
    // Return payload + etag
  }

  async check(key, previousState, ctx) {
    // HEAD request with If-None-Match
    // Return { changed, newState }
  }

  normalize(key, rawPayload) {
    // Delegate to src/content/normalize.js with sourceType = 'apple-docc'
    // Extract sections, relationships
  }

  extractReferences(key, rawPayload) {
    // Use existing extractor.js logic
    // Return child page keys for BFS crawl
  }
}
```

### 2.3 — Refactor HIG to Adapter

**File to create**: `src/sources/hig.js`
**Files to reference**: `src/apple/api.js`, `src/pipeline/discover.js`

The HIG adapter uses the same JSON API but with `/design/` prefix:
- `discover()`: Fetch design technology index, enumerate HIG roots
- `fetch()`: Fetch `/tutorials/data/design/{key}.json`
- `check()`: Same ETag/HEAD pattern
- `normalize()`: Same DocC normalizer with `sourceType = 'hig'`

### 2.4 — Refactor Guidelines to Adapter

**File to create**: `src/sources/guidelines.js`
**Files to reference**: `src/pipeline/sync-guidelines.js`, `src/apple/guidelines-parser.js`

The Guidelines adapter is different — it's HTML-based:
- `discover()`: Return single key `'app-store-review'`
- `fetch()`: Fetch HTML page, parse with HTMLRewriter into sections
- `check()`: Fetch HTML page, compare content hash against previous
- `normalize()`: Convert parsed sections to normalized documents with parent-child relationships
- `extractReferences()`: Return section keys for hierarchy

### 2.5 — Refactor Sync Pipeline to Use Adapter Registry

**Files to modify**: `src/commands/sync.js`, `src/pipeline/discover.js`

The sync command becomes:
```js
import { getAllAdapters, getAdapter } from '../sources/registry.js';

async function sync(ctx, options) {
  const sources = options.sources
    ? options.sources.split(',').map(s => getAdapter(s.trim()))
    : getAllAdapters();

  for (const adapter of sources) {
    ctx.logger.info(`Syncing ${adapter.constructor.displayName}...`);
    try {
      const discovery = await adapter.discover(ctx);
      for (const key of discovery.keys) {
        const result = await adapter.fetch(key, ctx);
        const normalized = adapter.normalize(key, result.payload);
        // Upsert into documents, document_sections, document_relationships
        // Save raw payload to disk
      }
    } catch (err) {
      ctx.logger.error(`Source ${adapter.constructor.type} failed: ${err.message}`);
      // Continue with other sources — degrade by source, not globally
    }
  }
}
```

For Apple DocC, the BFS crawl pattern is preserved:
- `discover()` returns root keys
- `fetch()` returns payload
- `extractReferences()` returns child keys → feed back into crawl queue
- Resumable crawl state tracked per source in database

### 2.6 — Refactor Update Command to Use Adapters

**Files to modify**: `src/commands/update.js`

The update command becomes:
```js
for (const adapter of sources) {
  const documents = db.getDocumentsBySource(adapter.constructor.type);
  for (const doc of documents) {
    const checkResult = await adapter.check(doc.key, doc.previousState, ctx);
    if (checkResult.changed) {
      const fetchResult = await adapter.fetch(doc.key, ctx);
      const normalized = adapter.normalize(doc.key, fetchResult.payload);
      // Update documents, sections, relationships
    }
  }
}
```

### 2.7 — Add Adapter Tests

**Files to create**: `test/unit/adapters/apple-docc.test.js`, `test/unit/adapters/hig.test.js`, `test/unit/adapters/guidelines.test.js`, `test/unit/adapters/base.test.js`

Test per adapter:
- `discover()` returns valid DiscoveryResult
- `normalize()` produces valid NormalizedResult from fixture data
- `extractReferences()` returns expected child keys
- `check()` correctly detects changed/unchanged
- Error handling: network failures, malformed payloads

## Files Changed Summary

| File | Action |
|---|---|
| `src/sources/base.js` | Create |
| `src/sources/registry.js` | Create |
| `src/sources/apple-docc.js` | Create |
| `src/sources/hig.js` | Create |
| `src/sources/guidelines.js` | Create |
| `src/commands/sync.js` | Modify (use adapter registry) |
| `src/commands/update.js` | Modify (use adapter check) |
| `src/pipeline/discover.js` | Modify (delegate to adapters) |
| `test/unit/adapters/*.test.js` | Create |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Adapter abstraction adds complexity without value | Low | Medium | Only 3 adapters now; payoff comes in Phase 4 (7 more) |
| BFS crawl pattern doesn't fit adapter model cleanly | Medium | Medium | AppleDoccAdapter handles crawl internally; adapter contract doesn't mandate crawl |
| Guidelines adapter significantly different from DocC | Low | Low | Adapter contract is intentionally loose; Guidelines overrides most methods |
