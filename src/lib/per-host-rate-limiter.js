import { RateLimiter } from './rate-limiter.js'

function bucketKeyFor(url) {
  if (!url) return '*'
  try {
    return new URL(url).hostname || '*'
  } catch {
    return '*'
  }
}

/**
 * Create a hostname-scoped token-bucket limiter.
 * @param {{
 *   defaults?: { rate?: number, burst?: number },
 *   primary?: { rate?: number, burst?: number } | null,
 * }} [opts]
 */
export function createHostBucketedLimiter(opts = {}) {
  const defaults = opts.defaults ?? {}
  const rate = defaults.rate ?? 5
  const burst = defaults.burst ?? 2
  const primaryConfig = opts.primary ?? null
  const buckets = new Map()
  const primaryLimiter = primaryConfig
    ? new RateLimiter(primaryConfig.rate ?? rate, primaryConfig.burst ?? burst)
    : null

  function getBucket(url) {
    const key = bucketKeyFor(url)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = new RateLimiter(rate, burst)
      buckets.set(key, bucket)
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
  }
}
