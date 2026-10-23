import { jsonResponse } from '../responses.js'
import { VERSION } from '../../lib/version.js'
import { getCommitHash } from '../../lib/git-version.js'
import { isEdgeRequest } from '../../lib/http-edge.js'
import { isSandboxed } from '../../lib/sandbox-probe.js'

// Resolved once at module load (getCommitHash memoizes, but hoisting it
// keeps the liveness handler free of even one-time subprocess work).
const COMMIT = getCommitHash()

/**
 * Liveness probe. Must not touch the DB or any cache so a stuck request
 * handler does not also fail the upstream health check. `no-store` so a
 * cached 200 cannot mask a wedged origin. Local callers also get the commit
 * and whether the process is confined by the Seatbelt profile (`sandboxed`:
 * true, false, or null when unknown), so "what is this instance running" is
 * one curl away; public (edge) callers get only `{ok, service, version}`.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function healthHandler(request) {
  const body = { ok: true, service: 'apple-docs-web', version: VERSION }
  if (!isEdgeRequest(request)) {
    body.commit = COMMIT
    body.sandboxed = isSandboxed()
  }
  return jsonResponse(body, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Readiness probe. 200 only when the DB is reachable AND (when a
 * reader-pool is wired) at least one reader worker is alive. 503
 * otherwise so a load balancer can route around a wedged instance even
 * when the process is otherwise responsive.
 *
 * Public (edge) callers get only `{ok}`: the reader-pool sizes, timeouts and
 * backpressure counters are a capacity-planning aid for an attacker. Local
 * callers (the watchdog, operators) get the full body.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function readinessHandler(request, ctx) {
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
  const body = isEdgeRequest(request)
    ? { ok: ready }
    : {
        ok: ready,
        service: 'apple-docs-web',
        db: dbOk,
        readerPool: ctx.readerPool ? { ok: readerOk, stats: readerStats } : null,
      }
  return jsonResponse(body, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
