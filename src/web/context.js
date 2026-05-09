import { dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { createReaderPool } from '../storage/reader-pool.js'
import { createHostBucketedLimiter } from '../lib/per-host-rate-limiter.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter } from '../content/highlight.js'
import { createLru } from '../lib/lru.js'
import { createWebRenderCache } from './render-cache.js'
import { buildTitleIndex, buildAliasMap } from './search-artifacts.js'

/**
 * @typedef {object} WebContext
 * @property {import('../storage/database.js').DocsDatabase} db
 * @property {string} dataDir
 * @property {object} logger
 * @property {object} siteConfig
 * @property {string} srcWebDir
 * @property {object} rateLimiter
 * @property {object} renderCache
 * @property {object | null} readerPool
 * @property {object} searchCtx Search context with optional reader pool attached.
 * @property {object} searchCache LRU keyed on normalized search opts + corpus stamp.
 * @property {{ get: () => string, refresh: () => string }} corpusStamp
 * @property {object} frameworkTreeCache LRU of <slug>:<hash> framework-tree JSON blobs.
 * @property {Map<string, string>} frameworkTreeBySlug Latest tree hash per framework slug.
 * @property {Record<string, string>} securityHeaders Default headers applied to every page response.
 * @property {Record<string, string>} assetCacheHeaders Default headers for /assets/* + /worker/*.
 * @property {object} gzipCache LRU of pre-compressed response bodies keyed by ETag.
 * @property {Map<string, string | Promise<string>>} bundleCache Per-server cache of synthesised /assets/<name>.js bundles. The Promise variant is the in-flight build that parallel requests should await rather than racing each other into Bun.build.
 * @property {() => object} getTitleIndex
 * @property {() => object} getAliasMap
 * @property {() => object} getSearchManifest
 * @property {() => void} invalidateDocumentCaches Drop every document-derived cache after a corpus mutation.
 */

/**
 * Build the WebContext used by serve.js routes. Centralizes the per-server
 * mutable state (caches, reader pool, corpus stamp, render cache) so route
 * handlers can be moved to per-file modules without re-discovering 12
 * closure references each time.
 *
 * @param {{ port?: number, baseUrl?: string, siteName?: string, readerPool?: object | null }} opts
 * @param {{ db: import('../storage/database.js').DocsDatabase, dataDir: string, logger: object }} ctx
 * @returns {Promise<WebContext>}
 */
export async function createWebContext(opts, ctx) {
  const { db, dataDir, logger } = ctx
  // `bundled: true` so the rendered HTML references `/assets/core.js` and
  // `/assets/listing.js` — the same filenames the static `web build` writes.
  // In production behind Caddy, `file_server` serves those bundles from
  // `dist/web/assets/`; the request never reaches Bun. For local preview
  // (`apple-docs web serve` standalone, no dist on disk) the /assets/ route
  // synthesises the bundles on the fly from `src/web/assets/`.
  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
    assetVersion: Date.now().toString(36),
    bundled: true,
  }

  void initHighlighter().catch((err) => {
    logger.warn('Syntax highlighter unavailable:', err.message)
  })

  const srcWebDir = dirname(new URL(import.meta.url).pathname)
  const rateLimiter = createHostBucketedLimiter({
    defaults: { rate: 5, burst: 2 },
    primary: { rate: 5, burst: 2 },
  })
  const renderCache = createWebRenderCache(db)
  const readerPool = await resolveWebReaderPool(ctx, opts, logger)
  const searchCtx = readerPool ? { ...ctx, readerPool } : ctx
  const searchCache = createLru({ max: parseNonNegativeInt(process.env.APPLE_DOCS_WEB_SEARCH_CACHE) ?? 512 })
  const corpusStamp = createCorpusStamp(ctx)

  // Framework tree-view JSON cache. Each framework page render computes the
  // tree JSON, hashes it, and stores it here keyed by `<slug>:<hash>`. The
  // /data/frameworks/<slug>/tree.<hash>.json route reads from this map so
  // we never re-render or re-hash on the cacheable path. Memory footprint
  // is bounded by the LRU max; eviction keeps it small.
  const frameworkTreeCache = createLru({ max: 64 })
  const frameworkTreeBySlug = new Map()

  // Cached search artifacts (invalidated when the document corpus changes).
  let cachedTitleIndex = null
  let cachedAliasMap = null
  let cachedSearchManifest = null

  function getTitleIndex() { return cachedTitleIndex ??= buildTitleIndex(db) }
  function getAliasMap() { return cachedAliasMap ??= buildAliasMap(db) }
  function invalidateDocumentCaches() {
    renderCache.invalidate()
    searchCache.clear()
    corpusStamp.refresh()
    cachedTitleIndex = null
    cachedAliasMap = null
    cachedSearchManifest = null
  }
  function getSearchManifest() {
    if (cachedSearchManifest) return cachedSearchManifest
    const titleIndex = getTitleIndex()
    const aliasMap = getAliasMap()
    const titleJson = JSON.stringify(titleIndex)
    const aliasJson = JSON.stringify(aliasMap)
    const titleHash = sha256(titleJson).slice(0, 10)
    const aliasHash = sha256(aliasJson).slice(0, 10)
    cachedSearchManifest = {
      version: 2,
      titleCount: titleIndex.keys.length,
      aliasCount: Object.keys(aliasMap).length,
      shardCount: 0,
      files: {
        'title-index': `title-index.${titleHash}.json`,
        'aliases': `aliases.${aliasHash}.json`,
      },
      generatedAt: new Date().toISOString(),
    }
    return cachedSearchManifest
  }

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
  // In production Caddy serves /assets/* and /worker/* directly from disk
  // with `Cache-Control: public, max-age=31536000, immutable` (configured in
  // Caddyfile.tpl). Bun's copies are only hit by `apple-docs web serve` for
  // local previews — but those benefit from cacheable headers too, since
  // `?v=<assetVersion>` busts the cache on every server restart.
  const assetCacheHeaders = {
    'Cache-Control': 'public, max-age=31536000, immutable',
  }

  const gzipCache = createLru({ max: 256 })

  // Per-server cache of synthesised /assets/<name>.js bundles. Bun.build
  // is fast (~4 ms locally) but rerunning it on every request still adds
  // avoidable latency; the cache flips that to amortised zero. Lives on
  // the context so two servers in the same process can never read each
  // other's bytes (matches gzipCache / searchCache / corpusStamp scope).
  // Implicit invalidation: assetVersion in rendered HTML cycles on every
  // server boot, so a stale bundle is never linked from a fresh page.
  const bundleCache = new Map()

  return {
    db,
    dataDir,
    logger,
    siteConfig,
    srcWebDir,
    rateLimiter,
    renderCache,
    readerPool,
    searchCtx,
    searchCache,
    corpusStamp,
    frameworkTreeCache,
    frameworkTreeBySlug,
    securityHeaders,
    assetCacheHeaders,
    gzipCache,
    bundleCache,
    getTitleIndex,
    getAliasMap,
    getSearchManifest,
    invalidateDocumentCaches,
  }
}

/**
 * Lazily-refreshed string identifying the current corpus state. Bumps when
 * either the SQLite schema version changes (a sync ran a migration) or the
 * DB file's mtime moves (any write committed). Used to key the search
 * response cache so a corpus refresh implicitly invalidates every cached
 * search.
 *
 * @param {{ db: { dbPath?: string, getSchemaVersion?: () => number } }} ctx
 */
function createCorpusStamp(ctx) {
  const dbPath = ctx?.db?.dbPath
  let cached = null
  let refreshedAt = 0

  function compute() {
    let mtime = 0
    try { mtime = dbPath && dbPath !== ':memory:' ? Math.floor(statSync(dbPath).mtimeMs) : 0 } catch {}
    let schema = 0
    try { schema = ctx?.db?.getSchemaVersion?.() ?? 0 } catch {}
    return `${schema}:${mtime}`
  }

  return {
    get() {
      const now = Date.now()
      if (cached == null || now - refreshedAt >= 5_000) {
        cached = compute()
        refreshedAt = now
      }
      return cached
    },
    refresh() {
      cached = compute()
      refreshedAt = Date.now()
      return cached
    },
  }
}

/**
 * Resolve an optional SQLite reader-thread pool for /api/search. Honours
 * the `APPLE_DOCS_WEB_READERS` env var (off|auto|on) and
 * `APPLE_DOCS_WEB_READER_WORKERS` for sizing. Returns null when the pool
 * is disabled, the DB is in-memory, or the pool fails to start (the search
 * path falls back to the main-thread bun:sqlite handle).
 */
async function resolveWebReaderPool(ctx, opts, logger) {
  if (opts && 'readerPool' in opts) return opts.readerPool ?? null
  const mode = process.env.APPLE_DOCS_WEB_READERS ?? 'auto'
  if (['off', '0', 'false', 'no'].includes(String(mode).toLowerCase())) return null

  const dbPath = ctx?.db?.dbPath
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) {
    if (String(mode).toLowerCase() === 'on') {
      logger?.warn?.('web reader-pool: no real database file available, skipping')
    }
    return null
  }

  const size = parsePositiveInt(process.env.APPLE_DOCS_WEB_READER_WORKERS) ?? undefined
  try {
    const pool = createReaderPool({
      dbPath,
      size,
      log: (level, msg) => logger?.[level]?.(`web reader-pool: ${msg}`),
    })
    await pool.start()
    const snap = pool.stats()
    logger?.info?.(`web reader-pool: ready size=${snap.size} spawns=${snap.spawns}`)
    return pool
  } catch (err) {
    logger?.error?.(`web reader-pool: failed to start (${err?.message ?? err}); falling back to main-thread reads`)
    return null
  }
}

function parsePositiveInt(value) {
  if (value == null) return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseNonNegativeInt(value) {
  if (value == null) return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
