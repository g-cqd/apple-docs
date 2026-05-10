/**
 * Metrics builder + optional Prometheus-scrape starter for
 * `apple-docs web serve`. Mirrors the shape of
 * `src/mcp/metrics-provider.js` so a single Prometheus rule set can
 * cover both listeners with parallel `apple_docs_<surface>_*`
 * metrics.
 *
 * Phase 1.1 of docs/plans/2026-05-10-javascript-performance-sota.md.
 */

import { startMetricsServer } from '../lib/metrics-server.js'

/**
 * Start the optional Prometheus scrape endpoint for this web server.
 * Returns null when `--metrics-port` is absent (no perf cost).
 *
 * @param {{ metricsPort?: number, metricsHost?: string }} opts
 * @param {{
 *   logger: any,
 *   serve?: any,
 *   readerPool?: any,
 *   rateLimiter?: any,
 *   searchCache?: any,
 *   renderCache?: any,
 *   gzipCache?: any,
 *   bundleCache?: any,
 *   observability: { exposition: () => any[] },
 *   eventLoopLag: { snapshot: () => any },
 * }} deps
 */
export function maybeStartWebMetricsServer(opts, deps) {
  const port = opts?.metricsPort
  if (port == null || !Number.isFinite(port)) return null
  const host = opts.metricsHost ?? '127.0.0.1'
  return startMetricsServer({
    port,
    host,
    logger: deps.logger,
    serve: deps.serve,
    provider: () => buildWebMetrics(deps),
  })
}

export function buildWebMetrics(deps) {
  const metrics = []

  // ---- Per-request latency + counter (from the observability shim).
  if (deps.observability) {
    metrics.push(...deps.observability.exposition())
  }

  // ---- Reader-thread pool (off by default; only emit when wired).
  // After P2.1 the pool is a {strict, deep} facade — emit per-pool
  // labels so operators can see the split is healthy. Falls back to
  // single-pool gauges if `pools` isn't present (test fixtures).
  const rp = safeCall(() => deps.readerPool?.stats?.())
  if (rp) {
    pushReaderPoolMetrics(metrics, rp)
  }

  // ---- Per-IP rate limiter bucket count (only when limiter is wired).
  if (deps.rateLimiter && typeof deps.rateLimiter._size === 'function') {
    metrics.push({
      name: 'apple_docs_web_rate_limit_buckets',
      help: 'Per-IP token-bucket entries currently held by the web rate limiter.',
      type: 'gauge',
      samples: [{ labels: { name: deps.rateLimiter.name ?? 'default' }, value: deps.rateLimiter._size() }],
    })
  }

  // ---- Cache byte sizes (best-effort; caches that don't expose
  // byteSize() are simply not reported).
  const cacheBytes = []
  for (const [label, cache] of [
    ['search', deps.searchCache],
    ['render', deps.renderCache],
    ['gzip', deps.gzipCache],
    ['bundle', deps.bundleCache],
  ]) {
    const bytes = safeCall(() => cache?.byteSize?.())
    if (typeof bytes === 'number' && Number.isFinite(bytes)) {
      cacheBytes.push({ labels: { cache: label }, value: bytes })
    }
  }
  if (cacheBytes.length > 0) {
    metrics.push({
      name: 'apple_docs_web_cache_bytes',
      help: 'Web in-process cache byte usage.',
      type: 'gauge',
      samples: cacheBytes,
    })
  }

  // ---- Event-loop lag percentiles + sample count.
  const lag = safeCall(() => deps.eventLoopLag?.snapshot?.())
  if (lag) {
    metrics.push({
      name: 'apple_docs_event_loop_lag_ms',
      help: 'Event-loop lag in milliseconds (interval-drift sampler).',
      type: 'gauge',
      samples: [
        { labels: { quantile: '0.5' }, value: lag.p50 },
        { labels: { quantile: '0.95' }, value: lag.p95 },
        { labels: { quantile: '0.99' }, value: lag.p99 },
        { labels: { quantile: 'max' }, value: lag.max },
      ],
    })
    metrics.push({
      name: 'apple_docs_event_loop_lag_samples',
      help: 'Event-loop lag sample window currently retained.',
      type: 'gauge',
      samples: [{ value: lag.samples }],
    })
  }

  // ---- Process memory (RSS, JS heap, native bytes).
  const mem = safeCall(() => process.memoryUsage())
  if (mem) {
    metrics.push(
      { name: 'apple_docs_process_rss_bytes', help: 'Resident set size of the process.', type: 'gauge', samples: [{ value: mem.rss }] },
      { name: 'apple_docs_process_heap_bytes', help: 'JavaScript heap usage.', type: 'gauge', samples: [
        { labels: { kind: 'used' }, value: mem.heapUsed },
        { labels: { kind: 'total' }, value: mem.heapTotal },
      ] },
      { name: 'apple_docs_process_external_bytes', help: 'External (off-heap) memory pinned by V8/JSC.', type: 'gauge', samples: [{ value: mem.external ?? 0 }] },
    )
  }

  return metrics
}

function safeCall(fn) {
  try { return fn() } catch { return null }
}

/**
 * Emit reader-pool metrics labeled by `pool="strict"|"deep"` when the
 * combined facade exposes per-pool stats. When `rp.pools` is absent
 * (e.g. tests pass a single-pool stub), fall back to flat gauges
 * matching the pre-P2.1 shape.
 */
function pushReaderPoolMetrics(metrics, rp) {
  const pools = rp.pools
  const FIELDS = [
    ['size', 'gauge', 'Reader-pool worker count.'],
    ['active', 'gauge', 'Reader-pool workers currently alive.'],
    ['pending', 'gauge', 'Reader-pool in-flight requests.'],
    ['spawns', 'counter', 'Reader-pool worker spawns.'],
    ['errors', 'counter', 'Reader-pool worker errors / unexpected exits.'],
    ['timeouts', 'counter', 'Reader-pool per-call deadline expirations.'],
    ['backpressureRejects', 'counter', 'Reader-pool backpressure rejections.'],
  ]
  const NAME = {
    size: 'apple_docs_reader_pool_size',
    active: 'apple_docs_reader_pool_active',
    pending: 'apple_docs_reader_pool_pending',
    spawns: 'apple_docs_reader_pool_spawns_total',
    errors: 'apple_docs_reader_pool_errors_total',
    timeouts: 'apple_docs_reader_pool_timeouts_total',
    backpressureRejects: 'apple_docs_reader_pool_backpressure_rejects_total',
  }
  for (const [field, type, help] of FIELDS) {
    const samples = pools
      ? [
          { labels: { pool: 'strict' }, value: pools.strict?.[field] ?? 0 },
          { labels: { pool: 'deep' }, value: pools.deep?.[field] ?? 0 },
        ]
      : [{ value: rp[field] ?? 0 }]
    metrics.push({ name: NAME[field], help, type, samples })
  }
}
