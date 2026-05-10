/**
 * Composite gate for the on-demand docs fetch path.
 *
 * The `/docs/<key>` handler falls through to `fetchDocPage` when a key
 * isn't in the corpus, which would make the public web server a free
 * SSRF amplifier (any reachable client could drive Apple-side traffic).
 * The base per-IP token bucket handles the warm path; the cold path
 * needs three additional defenses:
 *
 *   1. **Strict per-IP bucket** (5/min default) — applied only when the
 *      handler enters the cold path, so legitimate users browsing
 *      already-cached frameworks aren't penalized.
 *
 *   2. **Negative cache** (24h default) — once a key returns 404 from
 *      Apple, remember it so the same client can't replay the miss. LRU-
 *      capped (1024) so the table can't grow unbounded.
 *
 *   3. **Bounded fetch queue** — at most N concurrent on-demand fetches
 *      across all clients (8/16 waiters with 5s queue deadline). Beyond
 *      that, return 503 + Retry-After so the upstream isn't drowned by
 *      a thundering herd.
 *
 * Each defense is a separate concern so callers can mock or disable
 * them in tests.
 */

import { Semaphore } from '../../lib/semaphore.js'
import { createRateLimiter } from './rate-limit.js'

const DEFAULT_PER_IP_RATE = 5 / 60     // 5 req per minute (rate is per-second)
const DEFAULT_PER_IP_BURST = 5
const DEFAULT_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_NEGATIVE_LRU = 1024
const DEFAULT_FETCH_MAX_CONCURRENT = 8
const DEFAULT_FETCH_MAX_WAITERS = 16

export function createOnDemandGate(opts = {}) {
  const perIpLimiter = createRateLimiter({
    rate: opts.perIpRate ?? DEFAULT_PER_IP_RATE,
    burst: opts.perIpBurst ?? DEFAULT_PER_IP_BURST,
    name: 'docs.on-demand',
  })

  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
  const negativeLruCap = opts.negativeLru ?? DEFAULT_NEGATIVE_LRU
  /** @type {Map<string, number>} key → deniedUntil epoch ms */
  const negativeCache = new Map()

  const fetchSemaphore = new Semaphore(
    opts.fetchMaxConcurrent ?? DEFAULT_FETCH_MAX_CONCURRENT,
    { maxWaiters: opts.fetchMaxWaiters ?? DEFAULT_FETCH_MAX_WAITERS },
  )

  function checkPerIp(request, server) {
    return perIpLimiter.take(request, server)
  }

  function isNegativelyCached(key) {
    const deniedUntil = negativeCache.get(key)
    if (deniedUntil == null) return false
    if (deniedUntil < Date.now()) {
      // LRU touch on expiry-and-replace — but cleanest: just delete.
      negativeCache.delete(key)
      return false
    }
    // Touch (re-insert moves to end so this entry stays warm).
    negativeCache.delete(key)
    negativeCache.set(key, deniedUntil)
    return true
  }

  function recordMiss(key) {
    if (negativeCache.size >= negativeLruCap) {
      const oldest = negativeCache.keys().next().value
      if (oldest !== undefined) negativeCache.delete(oldest)
    }
    negativeCache.set(key, Date.now() + negativeTtlMs)
  }

  /**
   * Run `fn` while holding a fetch permit. Throws BackpressureError when
   * the queue exceeds maxWaiters; the caller should translate that to a
   * 503 + Retry-After response.
   */
  async function withFetchPermit(fn) {
    await fetchSemaphore.acquire()
    try {
      return await fn()
    } finally {
      fetchSemaphore.release()
    }
  }

  return {
    checkPerIp,
    isNegativelyCached,
    recordMiss,
    withFetchPermit,
    /** Test-only diagnostics. */
    _state() {
      return {
        negativeCacheSize: negativeCache.size,
        semaphoreActive: fetchSemaphore.active,
        semaphoreQueued: fetchSemaphore._queue.length,
      }
    },
  }
}
