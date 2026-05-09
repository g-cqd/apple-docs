import { jsonResponse } from '../responses.js'

/**
 * Liveness probe. Must not touch the DB or any cache so a stuck request
 * handler does not also fail the upstream health check. `no-store` so a
 * cached 200 cannot mask a wedged origin.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function healthHandler() {
  return jsonResponse(
    { ok: true, service: 'apple-docs-web' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * A32 readiness probe. 200 only when the DB is reachable AND (when a
 * reader-pool is wired) at least one reader worker is alive. 503
 * otherwise so a load balancer can route around a wedged instance even
 * when the process is otherwise responsive.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function readinessHandler(_request, ctx) {
  let dbOk = false
  try {
    ctx.db?.db?.query('SELECT 1').get()
    dbOk = true
  } catch (err) {
    ctx.logger?.warn?.(`/readyz: db probe failed: ${err?.message ?? err}`)
  }
  let readerOk = true
  let readerStats = null
  if (ctx.readerPool) {
    try {
      readerStats = ctx.readerPool.stats()
      readerOk = (readerStats?.active ?? 0) > 0
    } catch (err) {
      readerOk = false
      ctx.logger?.warn?.(`/readyz: reader-pool probe failed: ${err?.message ?? err}`)
    }
  }
  const ready = dbOk && readerOk
  return jsonResponse(
    {
      ok: ready,
      service: 'apple-docs-web',
      db: dbOk,
      readerPool: ctx.readerPool ? { ok: readerOk, stats: readerStats } : null,
    },
    { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
