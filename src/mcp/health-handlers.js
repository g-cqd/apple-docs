// MCP HTTP server /healthz + /readyz response builders.
//
// Pure functions with explicit deps — closures over server-internal
// state are passed in by the caller.

/**
 * Liveness body. When `exposeCacheStats` is on, includes the cache
 * registry, markdown cache, semaphore stats, and reader-pool stats so
 * an operator can probe how the process is loaded without scraping a
 * separate metrics endpoint. `sandboxed` (true, false, or null when unknown)
 * is included when the caller passes it; the HTTP server does so for local
 * callers only.
 */
export function buildHealthBody({
  exposeCacheStats,
  cacheRegistry,
  markdownCache,
  heavyMax,
  heavyQueue,
  heavySemaphore,
  concurrencyStats,
  readerPool,
  sandboxed,
}) {
  const body = { ok: true, service: 'apple-docs-mcp' }
  if (sandboxed !== undefined) body.sandboxed = sandboxed
  if (!exposeCacheStats) return body
  body.cache = cacheRegistry.stats()
  body.markdownCache = markdownCache.stats?.()
  body.concurrency = {
    heavyMax,
    heavyQueue,
    active: heavySemaphore.active,
    waiting: heavySemaphore._queue.length,
    rejected: concurrencyStats.rejected,
  }
  if (readerPool) body.readerPool = readerPool.stats?.()
  return body
}

/**
 * Readiness response. 200 only when the DB is reachable AND (when
 * reader-pool is wired) ≥1 worker is alive. Distinct from /healthz:
 * healthz says the process is up, readyz says it can serve traffic.
 *
 * `detailed: false` (public callers) returns only `{ok}` so reader-pool
 * sizes, timeouts and counters stay internal.
 */
export function buildReadinessResponse({ ctx, readerPool, detailed = true }) {
  let dbOk = false
  try {
    ctx?.db?.db?.query('SELECT 1').get()
    dbOk = true
  } catch {}
  let readerOk = true
  let readerStats = null
  if (readerPool) {
    try {
      readerStats = readerPool.stats?.()
      readerOk = (readerStats?.active ?? 0) > 0
    } catch { readerOk = false }
  }
  const ready = dbOk && readerOk
  const body = detailed
    ? {
        ok: ready,
        service: 'apple-docs-mcp',
        db: dbOk,
        readerPool: readerPool ? { ok: readerOk, stats: readerStats } : null,
      }
    : { ok: ready }
  return Response.json(body, { status: ready ? 200 : 503 })
}
