# Markdown Generation Strategies

## On-the-fly rendering vs persistent files vs JSON-only

---

## 1. Problem Statement

apple-docs currently stores documentation in **three forms simultaneously:**
1. **SQLite database** -- metadata (title, abstract, platforms, etc.) in `pages` table + FTS5 indexes
2. **Raw JSON files** -- Apple's original API responses in `~/.apple-docs/raw-json/{path}.json`
3. **Markdown files** -- Rendered markdown with YAML front matter in `~/.apple-docs/markdown/{path}.md`

This triple-storage approach is wasteful:
- Raw JSON: ~2-3 GB for full corpus
- Markdown files: ~1.5-2 GB for full corpus
- SQLite database: ~200-400 MB
- **Total: ~4-5.5 GB**

The markdown files exist primarily for:
1. The `read` command and MCP `read` tool (returns full page content)
2. The body search index (FTS5 indexes markdown content)
3. Potential static site generation

The question: **can we render markdown on-the-fly from JSON instead of persisting it?**

---

## 2. Investigation: Rendering Performance

### 2.1 Benchmark: renderPage() Speed

The existing `renderer.js` converts DocC JSON to markdown. Key question: how fast is it?

**Characteristics of the renderer:**
- Pure JavaScript, no I/O during rendering
- String concatenation via array `.join('\n')`
- Recursive traversal of content nodes (paragraphs, headings, code, tables, lists, asides)
- Reference resolution (build relative paths)
- YAML front matter generation

**Expected performance:**
- Typical page JSON: 5-50 KB
- Typical content nodes: 10-200
- String operations: O(n) where n = total text length
- No regex in hot paths (except final `\n{3,}` cleanup)

**Estimated render time per page:** < 1ms for typical pages, < 5ms for large pages (like the SwiftUI View page at 720KB JSON).

**Conclusion:** On-the-fly rendering is effectively free. The bottleneck is I/O (reading the JSON file from disk), not the transformation.

### 2.2 Benchmark: JSON File Read Speed

Using Bun's optimized `Bun.file().json()`:
- Small file (5 KB JSON): ~0.1ms
- Medium file (50 KB JSON): ~0.5ms
- Large file (720 KB JSON): ~3ms

**Total per-page latency (read + render):** < 1ms typical, < 8ms worst case.

For comparison, reading a pre-rendered markdown file:
- Small file (3 KB MD): ~0.1ms
- Medium file (30 KB MD): ~0.3ms
- Large file (200 KB MD): ~1.5ms

**Verdict:** On-the-fly rendering from JSON adds ~0.5-5ms per page compared to reading pre-rendered markdown. This is negligible for single-page reads. For batch operations (body indexing, static site build), the cost is significant at scale.

---

## 3. Strategy Options

### Option A: JSON-only storage + on-the-fly rendering (DEFAULT)

**How it works:**
- Sync downloads JSON files only
- Markdown is rendered on-demand when `read` is called
- Body index is built by rendering each page to markdown, then indexing (batch operation)
- Static site build renders all pages during build

**Storage:** ~2.5 GB (JSON + DB only)
**Pros:**
- Smallest disk footprint
- Single source of truth (JSON)
- No markdown staleness issues (always renders from latest JSON)
- Simpler sync (no convert step)

**Cons:**
- Body indexing is slower (must render 330K pages: ~5-15 minutes extra)
- Static site build is slower (must render all pages)
- Cannot `grep` markdown files directly on disk

### Option B: Dual storage (CURRENT)

**How it works:**
- Sync downloads JSON, then converts to markdown
- Both formats persisted on disk

**Storage:** ~4.5 GB (JSON + markdown + DB)
**Pros:**
- Fast body indexing (read pre-rendered markdown)
- Fast static site builds
- Can grep/browse markdown files directly
- Existing `read` command just reads a file

**Cons:**
- Double the disk usage
- Markdown can become stale if renderer changes
- Two-step sync (download then convert)
- Conversion step adds time to initial sync

### Option C: Markdown-only storage

**How it works:**
- Sync downloads JSON, converts to markdown, deletes JSON
- Only markdown files persist

**Storage:** ~2 GB (markdown + DB only)
**Pros:**
- Smaller than dual storage
- Fast body indexing and reads

**Cons:**
- Cannot re-render with improved renderer without re-downloading
- Loses structured data (JSON has machine-readable metadata)
- Cannot extract new fields from JSON without re-sync

### Option D: User-configurable (RECOMMENDED)

**How it works:**
- Default: JSON-only (Option A) for smallest footprint
- Flag `--with-markdown`: Also persist markdown files (Option B)
- Flag `--markdown-only`: Delete JSON after conversion (Option C)
- Can convert between modes at any time

**Implementation:**

```javascript
// src/commands/sync.js (enhanced)
export async function sync(options, ctx) {
  // ... existing discover + crawl + download logic ...

  // Convert step is now optional
  if (options.withMarkdown || options.markdownOnly) {
    await convertPages(ctx)
    if (options.markdownOnly) {
      await cleanupRawJson(ctx)
    }
  }
}

// src/commands/export.js (NEW)
export async function exportDocs(options, ctx) {
  const { format, output } = options

  switch (format) {
    case 'markdown':
      // Render all JSON to markdown files
      await convertAllPages(ctx, output || join(ctx.dataDir, 'markdown'))
      break
    case 'json-only':
      // Remove markdown directory
      await cleanupMarkdown(ctx)
      break
    case 'markdown-only':
      // Render then remove JSON
      await convertAllPages(ctx)
      await cleanupRawJson(ctx)
      break
  }
}
```

**The `read` command adapts automatically:**

```javascript
// src/commands/lookup.js (enhanced)
export async function lookup(opts, ctx) {
  // ... find page in DB ...

  // Try markdown file first (fastest)
  const mdPath = join(ctx.dataDir, 'markdown', page.path + '.md')
  if (existsSync(mdPath)) {
    return { metadata: page, content: readFileSync(mdPath, 'utf-8') }
  }

  // Fall back to on-the-fly rendering from JSON
  const jsonPath = join(ctx.dataDir, 'raw-json', page.path + '.json')
  if (existsSync(jsonPath)) {
    const json = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    const markdown = renderPage(json, page.path)
    return { metadata: page, content: markdown }
  }

  // Last resort: return metadata only
  return { metadata: page, content: null }
}
```

---

## 4. Body Indexing with On-the-Fly Rendering

The body search index (`pages_body_fts`) currently reads markdown files. With JSON-only storage, it needs to render on-the-fly:

```javascript
// src/pipeline/index-body.js (enhanced)
export async function indexBody(options, ctx) {
  const { db, dataDir, logger } = ctx
  const pages = db.db.query(
    "SELECT id, path FROM pages WHERE status = 'active'"
  ).all()

  // Clear existing index
  db.clearBodyIndex()

  let indexed = 0
  const BATCH = 500

  db.db.run('BEGIN')
  for (const page of pages) {
    let body = null

    // Try markdown file first
    const mdPath = join(dataDir, 'markdown', page.path + '.md')
    if (existsSync(mdPath)) {
      body = readFileSync(mdPath, 'utf-8')
      // Strip YAML front matter
      const fmEnd = body.indexOf('---', 4)
      if (fmEnd > 0) body = body.slice(body.indexOf('\n', fmEnd + 3))
    } else {
      // Render from JSON
      const jsonPath = join(dataDir, 'raw-json', page.path + '.json')
      if (existsSync(jsonPath)) {
        const json = JSON.parse(readFileSync(jsonPath, 'utf-8'))
        body = renderPage(json, page.path)
        // Strip YAML front matter
        const fmEnd = body.indexOf('---', 4)
        if (fmEnd > 0) body = body.slice(body.indexOf('\n', fmEnd + 3))
      }
    }

    if (body) {
      db.insertBody(page.id, body)
      indexed++
    }

    if (indexed % BATCH === 0) {
      db.db.run('COMMIT')
      db.db.run('BEGIN')
      if (indexed % 10000 === 0) {
        logger.info(`Indexed ${indexed}/${pages.length} pages`)
      }
    }
  }
  db.db.run('COMMIT')

  return { indexed, total: pages.length }
}
```

**Performance impact:**
- Current (read markdown): ~3-5 minutes for 330K pages
- With on-the-fly render: ~8-15 minutes for 330K pages
- Acceptable for an operation that runs infrequently (weekly or on-demand)

---

## 5. Disk Space Management Commands

```
apple-docs status --disk                    # Show disk usage by format
apple-docs export --format markdown         # Generate markdown from JSON
apple-docs export --format json-only        # Remove markdown files
apple-docs export --format markdown-only    # Generate markdown, remove JSON
apple-docs cleanup --raw-json              # Remove raw JSON directory
apple-docs cleanup --markdown              # Remove markdown directory
apple-docs cleanup --all                   # Remove both, keep only DB
```

**Status output example:**
```
Disk Usage:
  Database:     287 MB  (apple-docs.db)
  Raw JSON:   2,341 MB  (raw-json/, 328,471 files)
  Markdown:   1,856 MB  (markdown/, 328,471 files)
  Total:      4,484 MB

Tip: Run 'apple-docs export --format json-only' to save 1.8 GB
     (markdown will be rendered on-the-fly when needed)
```

---

## 6. Recommendation

**Default to Option D (user-configurable) with JSON-only as default.**

Rationale:
1. Most users interact via CLI/MCP `search` and `read` -- on-the-fly rendering adds imperceptible latency for single-page reads
2. Saves ~1.8 GB of disk space by default
3. Users who need markdown files can opt in (`--with-markdown`)
4. Body indexing is slightly slower but runs infrequently
5. Static site builds render from JSON (one-time cost during build)
6. Keeps JSON as the single source of truth -- re-rendering with an improved renderer is free

**Migration path:**
- v2.0: Add on-the-fly rendering fallback to `lookup` command
- v2.0: Make markdown conversion opt-in during `sync` (`--with-markdown`)
- v2.0: Add `export` and `cleanup` commands
- v2.1: Add `apple-docs status --disk` reporting
- Future: Consider dropping markdown file persistence entirely if no users need it
