// MCP HTTP server /healthz + /readyz response builders.
//
// Pulled out of http-server.js as part of Phase D so that file stays
// under the 400-LOC ceiling. Pure functions with explicit deps —
// closures over server-internal state are passed in by the caller.

/**
 * Liveness body. When `exposeCacheStats` is on, includes the cache
 * registry, markdown cache, semaphore stats, and reader-pool stats so
 * an operator can probe how the process is loaded without scraping a
 * separate metrics endpoint.
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
}) {
  const body = { ok: true, service: 'apple-docs-mcp' }
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
 * A32 readiness response. 200 only when the DB is reachable AND (when
 * reader-pool is wired) ≥1 worker is alive. Distinct from /healthz:
 * healthz says the process is up, readyz says it can serve traffic.
 */
export function buildReadinessResponse({ ctx, readerPool }) {
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
  return Response.json(
    {
      ok: ready,
      service: 'apple-docs-mcp',
      db: dbOk,
      readerPool: readerPool ? { ok: readerOk, stats: readerStats } : null,
    },
    { status: ready ? 200 : 503 },
  )
}
