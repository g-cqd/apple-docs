import { createStamper } from './cache.js'

/**
 * Process-local LRU of fully rendered Markdown documents keyed by page path.
 *
 * Why a dedicated cache instead of relying on the per-tool cache registry:
 * the tool-level LRU keys on `(tool, args, corpusStamp)`, so two read_doc
 * calls for the same page that differ only in `section` / `maxChars` /
 * `match` each miss the cache and re-run `renderMarkdown()` — the hottest
 * CPU step in `lookup()`. This cache sits *inside* `lookup()` and holds the
 * rendered body + sections tuple keyed only by `page.path`, so all those
 * variants share one render.
 *
 * Invalidation reuses the same `corpusStamp` the tool cache already uses
 * (schema version + DB mtime, refreshed every 5 s). When the stamp rotates
 * after a corpus refresh — entries for that path are treated as stale on next
 * access and re-rendered.
 *
 * Capacity: 512 entries. Rendered Markdown bodies land in the tens of KB,
 * so the steady-state memory footprint is on the order of 10–50 MB.
 *
 * @param {object} ctx - shared command context ({ db, dataDir, ... })
 * @param {object} [opts]
 * @param {number} [opts.capacity=512]
 * @param {number} [opts.scale=1] - multiplier applied to the default capacity
 *   when `opts.capacity` is not set. Shared convention with the tool cache
 *   registry so one env var (`APPLE_DOCS_MCP_CACHE_SCALE`) scales both.
 * @param {() => number} [opts.now] - injectable clock (tests only)
 * @param {string}   [opts.dbPath] - override (tests only)
 */
export function createMarkdownCache(ctx, opts = {}) {
  const scale = opts.scale != null && Number.isFinite(opts.scale) && opts.scale > 0
    ? opts.scale
    : 1
  const capacity = Math.max(1, opts.capacity ?? Math.ceil(512 * scale))
  const stamper = opts.stamper ?? createStamper(ctx, opts)
  // Map<path, { content, sections, fallback, stamp }>; Map iteration is
  // insertion-ordered, so the first key is the LRU-oldest.
  const entries = new Map()
  let hits = 0
  let misses = 0
  let evictions = 0

  function get(path) {
    const entry = entries.get(path)
    if (entry === undefined) { misses++; return undefined }
    if (entry.stamp !== stamper.get()) {
      // Corpus rotated since we cached this page — evict and treat as miss.
      entries.delete(path)
      misses++
      return undefined
    }
    // Mark most-recently-used.
    entries.delete(path)
    entries.set(path, entry)
    hits++
    return entry
  }

  function set(path, payload) {
    if (entries.has(path)) entries.delete(path)
    entries.set(path, { ...payload, stamp: stamper.get() })
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
      evictions++
    }
  }

  function invalidate() {
    entries.clear()
    hits = 0
    misses = 0
    evictions = 0
    stamper.refresh?.()
  }

  function stats() {
    const total = hits + misses
    return {
      size: entries.size,
      capacity,
      hits,
      misses,
      evictions,
      hitRatio: total === 0 ? 0 : hits / total,
    }
  }

  return { get, set, invalidate, stats }
}
