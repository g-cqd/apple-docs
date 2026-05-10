import { RateLimiter } from './rate-limiter.js'

const DEFAULT_MAX_BUCKETS = 256

function bucketKeyFor(url) {
  if (!url) return '*'
  try {
    return new URL(url).hostname || '*'
  } catch {
    return '*'
  }
}

function parsePositiveInt(value) {
  if (value == null) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Create a hostname-scoped token-bucket limiter.
 *
 * Buckets are stored in an insertion-ordered LRU. Every cache hit
 * re-inserts the bucket so the most-recently-used host is at the tail
 * of the iteration order; once the cap is exceeded we drop the oldest
 * (head) host. This bounds memory growth on long-running crawls that
 * touch a steady stream of new hosts (audit5 §2.2 / "Top 10 Perf Wins").
 *
 * Override the cap via `opts.maxBuckets` or the
 * `APPLE_DOCS_HOST_BUCKET_MAX` environment variable.
 *
 * @param {{
 *   defaults?: { rate?: number, burst?: number },
 *   primary?: { rate?: number, burst?: number } | null,
 *   maxBuckets?: number,
 * }} [opts]
 */
export function createHostBucketedLimiter(opts = {}) {
  const defaults = opts.defaults ?? {}
  const rate = defaults.rate ?? 5
  const burst = defaults.burst ?? 2
  const primaryConfig = opts.primary ?? null
  const maxBuckets = opts.maxBuckets
    ?? parsePositiveInt(process.env.APPLE_DOCS_HOST_BUCKET_MAX)
    ?? DEFAULT_MAX_BUCKETS
  /** @type {Map<string, RateLimiter>} */
  const buckets = new Map()
  const primaryLimiter = primaryConfig
    ? new RateLimiter(primaryConfig.rate ?? rate, primaryConfig.burst ?? burst)
    : null

  function getBucket(url) {
    const key = bucketKeyFor(url)
    const existing = buckets.get(key)
    if (existing) {
      // LRU touch — re-insert moves the key to the tail of the iteration
      // order so the next eviction won't pick this host.
      buckets.delete(key)
      buckets.set(key, existing)
      return existing
    }
    const bucket = new RateLimiter(rate, burst)
    buckets.set(key, bucket)
    if (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value
      if (oldestKey !== undefined) buckets.delete(oldestKey)
    }
    return bucket
  }

  return {
    rate: primaryConfig?.rate ?? rate,
    burst: primaryConfig?.burst ?? burst,
    async acquire(url) {
      if (primaryLimiter) {
        await primaryLimiter.acquire()
      }
      return getBucket(url).acquire()
    },
    /** Test-only / observability hooks. */
    _size() { return buckets.size },
    _has(host) { return buckets.has(host) },
  }
}
