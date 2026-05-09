/**
 * Per-IP token-bucket rate limiter for the public web server.
 *
 * P3.5 of the remediation plan. The audits flagged the docs handler as
 * an SSRF amplifier (anyone reachable on 0.0.0.0:3000 could drive Apple
 * fetches via /docs/<path>) and the web server overall as a
 * CPU-exhaustion target. The plan's principle is to keep the read path
 * open but bound the work per IP — this module is the per-IP gate.
 *
 * Two limiters are typically created:
 *   - default (60 req/s, burst 120) — gates every request.
 *   - docs   (5 req/min, burst 5)   — extra-strict layer for the
 *                                     on-demand-fetch /docs/<path> route.
 *
 * IP resolution prefers X-Forwarded-For (Cloudflare / Caddy upstream)
 * and falls back to server.requestIP() for direct-served deployments.
 *
 * Buckets live in an LRU keyed on IP — capped so a flood of unique
 * source IPs (botnet, scan) can't grow the table without bound.
 */

const DEFAULT_LRU_CAP = 4096

function resolveIp(request, server) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  try {
    return server?.requestIP?.(request)?.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * @param {{ rate?: number, burst?: number, lruCap?: number, name?: string }} [opts]
 *   rate: tokens added per second. burst: max tokens in flight.
 *   lruCap: max bucket entries before LRU eviction.
 *   name: surfaced on the 429 response Retry-After comment for
 *         diagnostics (no external impact).
 */
export function createRateLimiter(opts = {}) {
  const rate = opts.rate ?? 60
  const burst = opts.burst ?? 120
  const lruCap = opts.lruCap ?? DEFAULT_LRU_CAP
  const name = opts.name ?? 'default'
  const tokenIntervalMs = rate > 0 ? 1000 / rate : Infinity
  /** @type {Map<string, { tokens: number, lastRefill: number }>} */
  const buckets = new Map()

  function refillAndTake(ip) {
    const now = Date.now()
    let bucket = buckets.get(ip)
    if (bucket) {
      // LRU touch — re-insert moves the key to the end.
      buckets.delete(ip)
      const elapsed = now - bucket.lastRefill
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed / tokenIntervalMs)
      bucket.lastRefill = now
    } else {
      bucket = { tokens: burst, lastRefill: now }
    }
    buckets.set(ip, bucket)
    // Cap the bucket count: drop the oldest (least-recently-touched).
    if (buckets.size > lruCap) {
      const oldestKey = buckets.keys().next().value
      if (oldestKey !== undefined) buckets.delete(oldestKey)
    }
    if (bucket.tokens < 1) return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) * tokenIntervalMs) }
    bucket.tokens -= 1
    return { ok: true }
  }

  return {
    name,
    /**
     * Try to consume one token for the requesting IP. Returns
     * { ok: true } on success, { ok: false, retryAfterMs } on overflow.
     *
     * @param {Request} request
     * @param {{ requestIP?: (req: Request) => { address: string } | null }} [server]
     */
    take(request, server) {
      return refillAndTake(resolveIp(request, server))
    },
    /** Test-only / observability: current bucket count. */
    _size() { return buckets.size },
  }
}

/**
 * 429 response with a Retry-After header (seconds, integer-rounded).
 * Plain text body so curl / proxy logs surface a readable reason.
 */
export function tooManyRequestsResponse(retryAfterMs, name = 'default') {
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new Response(`Too many requests (${name}). Retry after ${retryAfterSec}s.\n`, {
    status: 429,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(retryAfterSec),
    },
  })
}
