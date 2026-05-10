/**
 * Per-request metrics builder + optional metrics server starter for
 * `apple-docs mcp serve`.
 *
 * The cache registry, markdown cache, semaphore, concurrency stats, and
 * reader-pool are all closure-held inside http-server's startHttpServer().
 * They are passed in as deps here rather than imported, so the metrics
 * surface is exactly what the operator probes via /healthz.
 *
 * Naming convention: `apple_docs_mcp_<subsystem>_<name>` with `_total` for
 * counters per Prometheus convention. Cache stats use `cache="<tool>"` to
 * avoid metric explosion (one timeseries per tool, not one metric per tool).
 */

import { startMetricsServer } from '../lib/metrics-server.js'

/**
 * Start the optional Prometheus scrape endpoint for this MCP server, but
 * only when the operator passed `--metrics-port`. Returns null when the
 * port is absent (no perf cost, no listener).
 *
 * @returns {{ server: any, url: string, port: number,
 *   close: () => Promise<void> } | null}
 */
export function maybeStartMcpMetricsServer(opts, deps) {
  const port = opts?.metricsPort
  if (port == null || !Number.isFinite(port)) return null
  const host = opts.metricsHost ?? '127.0.0.1'
  return startMetricsServer({
    port,
    host,
    logger: deps.logger,
    serve: deps.serve,
    provider: () => buildMcpMetrics(deps),
  })
}

function buildMcpMetrics({
  cacheRegistry,
  markdownCache,
  heavySemaphore,
  concurrencyStats,
  readerPool,
}) {
  const metrics = []

  // ---- Per-tool response cache. cacheRegistry.stats() returns
  // { enabled, totalHits, totalMisses, stamp, tools: { <tool>: { hits,
  // misses, size, capacity } } }. Only emit when the registry was enabled
  // — disabled means the operator opted out and we should not advertise
  // permanently-zero counters.
  const cacheStats = safeCall(() => cacheRegistry?.stats?.())
  if (cacheStats && cacheStats.enabled !== false) {
    const hits = []
    const misses = []
    const size = []
    const capacity = []
    for (const [tool, s] of Object.entries(cacheStats.tools ?? {})) {
      hits.push({ labels: { cache: tool }, value: s.hits ?? 0 })
      misses.push({ labels: { cache: tool }, value: s.misses ?? 0 })
      size.push({ labels: { cache: tool }, value: s.size ?? 0 })
      capacity.push({ labels: { cache: tool }, value: s.capacity ?? 0 })
    }
    metrics.push(
      { name: 'apple_docs_mcp_cache_hits_total', help: 'Per-tool MCP response cache hits.', type: 'counter', samples: hits },
      { name: 'apple_docs_mcp_cache_misses_total', help: 'Per-tool MCP response cache misses.', type: 'counter', samples: misses },
      { name: 'apple_docs_mcp_cache_size', help: 'Per-tool MCP response cache current item count.', type: 'gauge', samples: size },
      { name: 'apple_docs_mcp_cache_capacity', help: 'Per-tool MCP response cache configured capacity.', type: 'gauge', samples: capacity },
    )
  }

  // ---- Markdown render cache (read_doc rendering hot path).
  const md = safeCall(() => markdownCache?.stats?.())
  if (md) {
    metrics.push(
      { name: 'apple_docs_mcp_markdown_cache_hits_total', help: 'Markdown render-cache hits.', type: 'counter', samples: [{ value: md.hits ?? 0 }] },
      { name: 'apple_docs_mcp_markdown_cache_misses_total', help: 'Markdown render-cache misses.', type: 'counter', samples: [{ value: md.misses ?? 0 }] },
      { name: 'apple_docs_mcp_markdown_cache_evictions_total', help: 'Markdown render-cache LRU evictions.', type: 'counter', samples: [{ value: md.evictions ?? 0 }] },
      { name: 'apple_docs_mcp_markdown_cache_size', help: 'Markdown render-cache current item count.', type: 'gauge', samples: [{ value: md.size ?? 0 }] },
    )
  }

  // ---- Heavy-tool semaphore. `_queue.length` is the canonical waiter
  // count; the underscore is internal but stable and is what /healthz
  // already reports, so we mirror the contract.
  if (heavySemaphore) {
    metrics.push(
      { name: 'apple_docs_heavy_semaphore_active', help: 'Active heavy-tool permits in use.', type: 'gauge', samples: [{ value: heavySemaphore.active ?? 0 }] },
      { name: 'apple_docs_heavy_semaphore_waiting', help: 'Heavy-tool calls queued waiting for a permit.', type: 'gauge', samples: [{ value: heavySemaphore._queue?.length ?? 0 }] },
    )
  }
  if (concurrencyStats) {
    metrics.push({
      name: 'apple_docs_heavy_semaphore_rejected_total',
      help: 'Heavy-tool calls rejected because the queue was full (HTTP 503).',
      type: 'counter',
      samples: [{ value: concurrencyStats.rejected ?? 0 }],
    })
  }

  // ---- Reader-thread pool (off by default; only emit when wired).
  // The pool exposes per-pool stats via `pools.{strict,deep}`; emit
  // `pool=` labels so operators can verify the split.
  const rp = safeCall(() => readerPool?.stats?.())
  if (rp) {
    pushReaderPoolMetrics(metrics, rp)
  }

  return metrics
}

function safeCall(fn) {
  try { return fn() } catch { return null }
}

function pushReaderPoolMetrics(metrics, rp) {
  const pools = rp.pools
  const FIELDS = [
    ['size', 'gauge', 'apple_docs_reader_pool_size', 'Reader-pool worker count.'],
    ['active', 'gauge', 'apple_docs_reader_pool_active', 'Reader-pool workers currently alive.'],
    ['pending', 'gauge', 'apple_docs_reader_pool_pending', 'Reader-pool in-flight requests.'],
    ['spawns', 'counter', 'apple_docs_reader_pool_spawns_total', 'Reader-pool worker spawns.'],
    ['errors', 'counter', 'apple_docs_reader_pool_errors_total', 'Reader-pool worker errors.'],
    ['timeouts', 'counter', 'apple_docs_reader_pool_timeouts_total', 'Reader-pool deadline expirations.'],
    ['backpressureRejects', 'counter', 'apple_docs_reader_pool_backpressure_rejects_total', 'Reader-pool backpressure rejections.'],
  ]
  for (const [field, type, name, help] of FIELDS) {
    const samples = pools
      ? [
          { labels: { pool: 'strict' }, value: pools.strict?.[field] ?? 0 },
          { labels: { pool: 'deep' }, value: pools.deep?.[field] ?? 0 },
        ]
      : [{ value: rp[field] ?? 0 }]
    metrics.push({ name, help, type, samples })
  }
}
