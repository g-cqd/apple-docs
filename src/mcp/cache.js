import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Per-tool LRU cache for MCP tool handlers.
 *
 * Scope: process-local. No external backing store (corpus is a single-user
 * SQLite file; a shared cache would cost complexity without payoff).
 *
 * Lifetime: one registry per MCP process. In stdio mode the registry is
 * created once inside `createServer`. In HTTP mode `startHttpServer` creates
 * one registry at boot and injects it into every per-request `createServer`
 * call so hits survive across HTTP requests.
 *
 * Key shape: sha256([tool, stableJson(args), corpusStamp].join('\0'))
 *   - `stableJson` sorts object keys so reordered args collide, but *does not*
 *     normalize string values — two queries that differ only by whitespace or
 *     casing stay distinct on purpose (we do not want to pretend "View" and
 *     "view" are the same search).
 *   - `corpusStamp = `${schemaVersion}:${dbMtimeMs}`` refreshed every 5s so
 *     `apple-docs update` invalidates transparently without a callback.
 *
 * Per-tool sizes (items, not bytes):
 *   search_docs   100
 *   read_doc      200
 *   browse        100
 *   list_frameworks 16
 *   list_taxonomy  16
 *
 * Escape hatch: `APPLE_DOCS_MCP_CACHE=off` disables the cache entirely so a
 * debugger can see raw projection output.
 */

const DEFAULT_SIZES = {
  search_docs: 100,
  read_doc: 200,
  browse: 100,
  list_frameworks: 16,
  list_taxonomy: 16,
}

// Short enough that an ad-hoc `apple-docs update` is visible within seconds;
// `statSync` is sub-millisecond on APFS, so the per-request overhead is
// negligible even at peak agent fan-out.
const STAMP_TTL_MS = 5_000

// How long to cache empty/negative results (zero-hit searches, 404 lookups).
// Much shorter than the positive-result lifetime so typos and fuzz don't
// poison the cache, but long enough to absorb a burst from a stuck agent.
const DEFAULT_NEGATIVE_TTL_MS = 30_000

// Symbol key tool handlers can set on their return value to signal "this is a
// negative result, apply the short TTL". Using a Symbol means the marker is
// invisible to JSON.stringify and never leaks into MCP responses.
export const CACHE_NEGATIVE = Symbol('apple-docs.cache.negative')

export function createCacheRegistry(ctx, opts = {}) {
  const enabled = opts.enabled ?? (process.env.APPLE_DOCS_MCP_CACHE !== 'off')
  const sizes = { ...DEFAULT_SIZES, ...(opts.sizes ?? {}) }
  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
  const now = opts.now ?? (() => Date.now())
  const caches = new Map()
  const counters = new Map()
  for (const [tool, size] of Object.entries(sizes)) {
    caches.set(tool, new LruCache(size))
    counters.set(tool, { hits: 0, misses: 0 })
  }
  const stamper = createStamper(ctx, opts)

  return {
    enabled,
    wrap(tool, handler) {
      if (!enabled || !caches.has(tool)) return handler
      const cache = caches.get(tool)
      const counter = counters.get(tool)
      return async (args) => {
        const key = cacheKey(tool, args, stamper.get())
        const hit = cache.get(key, now())
        if (hit !== undefined) {
          counter.hits++
          return hit
        }
        counter.misses++
        const value = await handler(args)
        const expiresAt = value?.[CACHE_NEGATIVE] === true
          ? now() + negativeTtlMs
          : null
        cache.set(key, value, expiresAt)
        return value
      }
    },
    stats() {
      const tools = {}
      let totalHits = 0
      let totalMisses = 0
      for (const [tool, cache] of caches) {
        const c = counters.get(tool)
        tools[tool] = { size: cache.size, capacity: cache.capacity, hits: c.hits, misses: c.misses }
        totalHits += c.hits
        totalMisses += c.misses
      }
      const total = totalHits + totalMisses
      return {
        enabled,
        stamp: stamper.get(),
        totalHits,
        totalMisses,
        hitRatio: total === 0 ? 0 : totalHits / total,
        tools,
      }
    },
    // Legacy shape used by older tests — returns per-tool LRU size only.
    _stats() {
      const out = {}
      for (const [tool, cache] of caches) out[tool] = cache.size
      return out
    },
    invalidate() {
      for (const cache of caches.values()) cache.clear()
      for (const counter of counters.values()) { counter.hits = 0; counter.misses = 0 }
      stamper.refresh()
    },
  }
}

function createStamper(ctx, opts = {}) {
  const dataDir = ctx?.dataDir
  const dbPath = opts.dbPath ?? (dataDir ? join(dataDir, 'apple-docs.db') : null)
  const schemaVersion = safeSchemaVersion(ctx)
  let cachedStamp = null
  let refreshedAt = 0

  function compute() {
    let mtime = 0
    try { mtime = dbPath ? Math.floor(statSync(dbPath).mtimeMs) : 0 } catch { mtime = 0 }
    return `${schemaVersion}:${mtime}`
  }

  return {
    get() {
      const now = Date.now()
      if (cachedStamp == null || now - refreshedAt >= STAMP_TTL_MS) {
        cachedStamp = compute()
        refreshedAt = now
      }
      return cachedStamp
    },
    refresh() {
      cachedStamp = compute()
      refreshedAt = Date.now()
    },
  }
}

function safeSchemaVersion(ctx) {
  try { return ctx?.db?.getSchemaVersion?.() ?? 0 } catch { return 0 }
}

export function cacheKey(tool, args, stamp) {
  const payload = `${tool}\0${stableJson(args ?? {})}\0${stamp}`
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Deterministic JSON: sort object keys recursively.
 * String values are NOT normalized — distinct by casing/whitespace.
 */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
  return `{${parts.join(',')}}`
}

class LruCache {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0)
    // Map<key, { value, expiresAt: number | null }>
    this.map = new Map()
  }
  get size() { return this.map.size }
  get(key, nowMs = Date.now()) {
    if (!this.map.has(key)) return undefined
    const entry = this.map.get(key)
    if (entry.expiresAt != null && entry.expiresAt <= nowMs) {
      // Expired: evict and treat as miss. The next set() rewrites freshly.
      this.map.delete(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }
  set(key, value, expiresAt = null) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt })
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
  clear() { this.map.clear() }
}
