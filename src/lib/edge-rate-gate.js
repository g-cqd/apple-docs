/**
 * Rate-limit gate that is on by default for public (edge) traffic and off
 * for local traffic.
 *
 * Public instances sit behind Cloudflare, whose volumetric protection does
 * not stop low-and-slow scraping or cheap CPU amplification against the
 * small reader pools. A per-IP token bucket in the app covers that gap
 * without throttling operator probes, the watchdog, or local benchmarks:
 * those carry no Cloudflare headers (see `isEdgeRequest`).
 *
 * Mode, from `<PREFIX>_RATE_LIMIT`:
 *   unset → 'edge' : limit requests that came through the edge
 *   '1'   → 'all'  : limit every request (including loopback)
 *   '0'   → 'off'  : never limit
 * Setting `<PREFIX>_RATE` or `<PREFIX>_BURST` without `_RATE_LIMIT=0`
 * implies 'all'.
 */

import { isEdgeRequest } from './http-edge.js'

/** Per-IP defaults for the public instances. */
export const DEFAULT_RATE_PER_SECOND = 2
export const DEFAULT_BURST = 60

/** Liveness and readiness probes are never limited. */
const EXEMPT_PATHS = new Set(['/healthz', '/readyz'])

function parsePositive(value) {
  if (value == null) return null
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Read the gate configuration for one server from the environment.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} prefix  e.g. 'APPLE_DOCS_WEB'
 * @param {{ forceAll?: boolean }} [opts]  `forceAll` is the programmatic opt-in
 * @returns {{ mode: 'off' | 'edge' | 'all', rate: number, burst: number }}
 */
export function resolveRateGateConfig(env, prefix, opts = {}) {
  const flag = env[`${prefix}_RATE_LIMIT`]
  const rate = parsePositive(env[`${prefix}_RATE`])
  const burst = parsePositive(env[`${prefix}_BURST`])
  let mode = 'edge'
  if (flag === '0') mode = 'off'
  else if (flag === '1' || opts.forceAll === true || rate != null || burst != null) mode = 'all'
  return {
    mode,
    rate: rate ?? DEFAULT_RATE_PER_SECOND,
    burst: burst ?? DEFAULT_BURST,
  }
}

/**
 * @typedef {{ ok: true } | { ok: false, retryAfterMs: number }} GateResult
 */

/**
 * Wrap a token-bucket limiter with the edge/all/off policy.
 *
 * @param {{ mode: 'off' | 'edge' | 'all', limiter: { name?: string, take: (req: Request, server?: object) => GateResult } }} args
 * @returns {{ name: string, mode: string, check: (request: Request, server?: object) => GateResult }}
 */
export function createEdgeRateGate({ mode, limiter }) {
  return {
    name: limiter.name ?? 'default',
    mode,
    check(request, server) {
      if (mode === 'off') return { ok: true }
      if (mode === 'edge' && !isEdgeRequest(request)) return { ok: true }
      if (EXEMPT_PATHS.has(new URL(request.url).pathname)) return { ok: true }
      return limiter.take(request, server)
    },
  }
}
