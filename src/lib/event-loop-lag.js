/**
 * Cross-runtime event-loop lag sampler.
 *
 * Bun runs on JavaScriptCore and does not implement Node's
 * `perf_hooks.monitorEventLoopDelay()`. We compromise: the sampler
 * uses a `setInterval` drift method that works identically on Bun
 * and Node. On Node we could detect `monitorEventLoopDelay` and
 * delegate, but the interval-drift sampler is cheap (one timer +
 * one ring-buffer write per tick) and produces tail percentiles
 * that match the API surface our metrics exporter wants.
 *
 * How it works: `setInterval(tick, 100)` schedules a fixed cadence;
 * on each fire we measure the delta from the previous expected
 * deadline. If the loop is idle, delta ≈ 0; if the loop is blocked
 * (sync regex, gzipSync, large JSON parse) the delta climbs to the
 * blocked duration. We keep the last N samples in a ring buffer
 * and compute percentiles on demand.
 *
 * Output: { p50, p95, p99, max, samples } in milliseconds.
 *
 * Related: phase 1.2 of docs/plans/2026-05-10-javascript-performance-sota.md
 */

const DEFAULT_INTERVAL_MS = 100
const DEFAULT_RING_SIZE = 600   // 60 s history at 100 ms cadence

/**
 * Hi-resolution monotonic clock — `performance.now()` is universal,
 * `Bun.nanoseconds()` is faster on Bun but not portable. The added
 * cost of `performance.now()` is dwarfed by the 100 ms interval.
 */
const now = () => performance.now()

/**
 * @param {{ intervalMs?: number, ringSize?: number }} [opts]
 */
export function createEventLoopLagSampler(opts = {}) {
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  const ringSize = Math.max(8, opts.ringSize ?? DEFAULT_RING_SIZE)
  const samples = new Float64Array(ringSize)
  let writeIdx = 0
  let count = 0
  let max = 0

  let lastTick = now()
  const timer = setInterval(() => {
    const t = now()
    // `setInterval` fires "approximately every intervalMs". Lag is
    // (actual - expected). Floor at 0 so a slightly-early fire (rare;
    // some JS runtimes coalesce timers) doesn't pollute the histogram
    // with a negative sample.
    const lag = Math.max(0, (t - lastTick) - intervalMs)
    lastTick = t
    samples[writeIdx] = lag
    writeIdx = (writeIdx + 1) % ringSize
    if (count < ringSize) count++
    if (lag > max) max = lag
  }, intervalMs)
  // Don't keep the process alive on this timer alone.
  timer.unref?.()

  function snapshot() {
    if (count === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 }
    }
    // Copy the live ring into a sortable Float64Array, sort, and
    // pick the percentile slot. Sort cost: O(n log n) per scrape;
    // n ≤ ringSize (default 600) so this runs in microseconds.
    const sorted = new Float64Array(count)
    for (let i = 0; i < count; i++) sorted[i] = samples[i]
    sorted.sort()
    return {
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max,
      samples: count,
    }
  }

  function stop() {
    clearInterval(timer)
  }

  return { snapshot, stop }
}

/**
 * Linear-interpolated percentile pick — cheap, accurate enough for a
 * Prometheus gauge. `arr` is assumed sorted ascending.
 */
function percentile(arr, q) {
  if (arr.length === 0) return 0
  const idx = (arr.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return arr[lo]
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo)
}

/**
 * Process memory snapshot. Cheap (< 1 µs on Bun); read once per
 * metrics scrape rather than every request.
 */
export function processMemorySnapshot() {
  const m = process.memoryUsage()
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external ?? 0,
  }
}
