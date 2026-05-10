/**
 * Fixed-bucket cumulative histogram for Prometheus exposition.
 *
 * Cheaper than a quantile estimator (no t-digest, no reservoir
 * sampling) and produces the bucket-style output Prometheus prefers.
 * Buckets are `<= bucket` boundaries in milliseconds.
 *
 * Default bucket layout covers the search-latency range we care
 * about: sub-ms strict hits, mid-ms FTS, body-search escalating to
 * multi-second outliers. Buckets are inclusive — the value falls
 * into the smallest bucket where `value <= bucket`.
 *
 * Each `record(value)` is O(B) where B = number of buckets (10
 * default), so per-call cost is ~10 comparisons + a tagged
 * Uint32Array increment.
 *
 * Output shape (passed to `formatPrometheus`):
 *   `apple_docs_..._bucket{le="5"} <count>`
 *   `apple_docs_..._bucket{le="+Inf"} <count>`
 *   `apple_docs_..._sum <sum>`
 *   `apple_docs_..._count <total>`
 */

export const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500,
])

/**
 * @param {{ buckets?: number[] }} [opts]
 */
export function createHistogram(opts = {}) {
  const buckets = opts.buckets ?? DEFAULT_LATENCY_BUCKETS_MS
  // counts[i] is cumulative count of values <= buckets[i].
  // counts[buckets.length] is the +Inf bucket (== total observations).
  const counts = new Uint32Array(buckets.length + 1)
  let sum = 0
  let total = 0

  function record(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
    sum += value
    total += 1
    // Find the smallest bucket where value <= bucket.
    let i = 0
    while (i < buckets.length && value > buckets[i]) i++
    // Bump the matched bucket and every bucket after it (cumulative).
    for (let j = i; j <= buckets.length; j++) counts[j] += 1
  }

  /**
   * Emit Prometheus-formatted samples for a histogram metric. Caller
   * supplies `name` (without trailing `_bucket`) and any extra labels
   * to attach to every sample.
   *
   * Returns three metric entries (bucket / sum / count) that the
   * caller can spread into the metrics array.
   *
   * @param {string} name
   * @param {string} help
   * @param {Record<string,string|number>} [labels]
   */
  function exposition(name, help, labels = {}) {
    const bucketSamples = []
    for (let i = 0; i < buckets.length; i++) {
      bucketSamples.push({ labels: { ...labels, le: String(buckets[i]) }, value: counts[i] })
    }
    bucketSamples.push({ labels: { ...labels, le: '+Inf' }, value: counts[buckets.length] })
    return [
      { name: `${name}_bucket`, help, type: 'gauge', samples: bucketSamples },
      { name: `${name}_sum`, help: `${help} (sum, ms).`, type: 'gauge', samples: [{ labels, value: sum }] },
      { name: `${name}_count`, help: `${help} (count).`, type: 'counter', samples: [{ labels, value: total }] },
    ]
  }

  return {
    record,
    exposition,
    /** Test-only / observability hooks. */
    _snapshot: () => ({ buckets, counts: Array.from(counts), sum, total }),
  }
}
