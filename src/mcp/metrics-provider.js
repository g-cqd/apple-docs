/**
 * Per-request metrics builder + optional metrics server starter for
 * `apple-docs mcp serve` (Phase D.2).
 *
 * Pulled out of http-server.js for two reasons:
 *   1. http-server.js sits at the 400-LOC ceiling; new logic goes elsewhere.
 *   2. Pure read of in-memory counters → trivial to unit-test in isolation
 *      without spinning a server.
 *
 * The cache registry, markdown cache, semaphore, concurrency stats, and
 * reader-pool are all closure-held inside http-server's startHttpServer().
 * They are passed in as deps here rather than imported, so the metrics
 * surface is exactly what the operator probes via /healthz today.
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

export function buildMcpMetrics({
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
  const rp = safeCall(() => readerPool?.stats?.())
  if (rp) {
    metrics.push(
      { name: 'apple_docs_reader_pool_size', help: 'Reader-pool worker count.', type: 'gauge', samples: [{ value: rp.size ?? 0 }] },
      { name: 'apple_docs_reader_pool_active', help: 'Reader-pool workers currently alive.', type: 'gauge', samples: [{ value: rp.active ?? 0 }] },
      { name: 'apple_docs_reader_pool_pending', help: 'Reader-pool in-flight requests across workers.', type: 'gauge', samples: [{ value: rp.pending ?? 0 }] },
      { name: 'apple_docs_reader_pool_spawns_total', help: 'Reader-pool worker spawns.', type: 'counter', samples: [{ value: rp.spawns ?? 0 }] },
      { name: 'apple_docs_reader_pool_errors_total', help: 'Reader-pool worker errors / unexpected exits.', type: 'counter', samples: [{ value: rp.errors ?? 0 }] },
      { name: 'apple_docs_reader_pool_timeouts_total', help: 'Reader-pool per-call deadline expirations.', type: 'counter', samples: [{ value: rp.timeouts ?? 0 }] },
      { name: 'apple_docs_reader_pool_backpressure_rejects_total', help: 'Reader-pool backpressure rejections (per-worker pending cap).', type: 'counter', samples: [{ value: rp.backpressureRejects ?? 0 }] },
    )
  }

  return metrics
}

function safeCall(fn) {
  try { return fn() } catch { return null }
}
