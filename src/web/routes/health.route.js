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
