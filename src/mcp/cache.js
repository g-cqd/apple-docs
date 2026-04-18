import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Per-tool LRU cache for MCP tool handlers.
 *
 * Scope: process-local. No external backing store (corpus is a single-user
 * SQLite file; a shared cache would cost complexity without payoff).
 *
 * Key shape: sha256([tool, stableJson(args), corpusStamp].join('\0'))
 *   - `stableJson` sorts object keys so reordered args collide, but *does not*
 *     normalize string values — two queries that differ only by whitespace or
 *     casing stay distinct on purpose (we do not want to pretend "View" and
 *     "view" are the same search).
 *   - `corpusStamp = `${schemaVersion}:${dbMtimeMs}`` refreshed every 30s so
 *     `apple-docs update` invalidates transparently without a callback.
 *
 * Per-tool sizes (items, not bytes):
 *   search_docs   100
 *   read_doc      200
 *   browse        100
 *   list_frameworks 16
 *   list_taxonomy  16
 *   status         — never cached (live corpus health signal)
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

const STAMP_TTL_MS = 30_000

export function createCacheRegistry(ctx, opts = {}) {
  const enabled = opts.enabled ?? (process.env.APPLE_DOCS_MCP_CACHE !== 'off')
  const sizes = { ...DEFAULT_SIZES, ...(opts.sizes ?? {}) }
  const caches = new Map()
  for (const [tool, size] of Object.entries(sizes)) {
    caches.set(tool, new LruCache(size))
  }
  const stamper = createStamper(ctx, opts)

  return {
    enabled,
    wrap(tool, handler) {
      if (!enabled || !caches.has(tool)) return handler
      const cache = caches.get(tool)
      return async (args) => {
        const key = cacheKey(tool, args, stamper.get())
        const hit = cache.get(key)
        if (hit !== undefined) return hit
        const value = await handler(args)
        cache.set(key, value)
        return value
      }
    },
    _stats() {
      const out = {}
      for (const [tool, cache] of caches) out[tool] = cache.size
      return out
    },
    invalidate() {
      for (const cache of caches.values()) cache.clear()
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
    this.map = new Map()
  }
  get size() { return this.map.size }
  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
  clear() { this.map.clear() }
}
