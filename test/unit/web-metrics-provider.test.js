import { describe, expect, test } from 'bun:test'
import { buildWebMetrics } from '../../src/web/metrics-provider.js'
import { createObservability } from '../../src/web/middleware/observability.js'

function metricNames(metrics) {
  return new Set(metrics.map(m => m.name))
}

function findMetric(metrics, name) {
  return metrics.find(m => m.name === name) ?? null
}

describe('buildWebMetrics', () => {
  test('emits request latency histogram + counter from observability', () => {
    const obs = createObservability()
    obs.record({ pathname: '/healthz', status: 200, ms: 0.5 })
    obs.record({ pathname: '/healthz', status: 200, ms: 1.2 })
    obs.record({ pathname: '/api/search', status: 200, ms: 8.0 })

    const metrics = buildWebMetrics({ observability: obs })
    const names = metricNames(metrics)
    expect(names.has('apple_docs_web_request_latency_ms_bucket')).toBe(true)
    expect(names.has('apple_docs_web_request_latency_ms_sum')).toBe(true)
    expect(names.has('apple_docs_web_request_latency_ms_count')).toBe(true)
    expect(names.has('apple_docs_web_requests_total')).toBe(true)

    const reqs = findMetric(metrics, 'apple_docs_web_requests_total')
    const routes = new Set(reqs.samples.map(s => s.labels.route))
    expect(routes.has('/healthz')).toBe(true)
    expect(routes.has('/api/search')).toBe(true)

    const count = findMetric(metrics, 'apple_docs_web_request_latency_ms_count')
    expect(count.samples[0].value).toBe(3)
  })

  test('omits reader-pool / rate-limiter blocks when deps absent', () => {
    const metrics = buildWebMetrics({ observability: createObservability() })
    const names = metricNames(metrics)
    expect(names.has('apple_docs_reader_pool_size')).toBe(false)
    expect(names.has('apple_docs_web_rate_limit_buckets')).toBe(false)
  })

  test('emits reader-pool block when stats() is wired', () => {
    const readerPool = {
      stats: () => ({ size: 8, active: 8, pending: 1, spawns: 8, errors: 0, timeouts: 0, backpressureRejects: 0 }),
    }
    const metrics = buildWebMetrics({
      observability: createObservability(),
      readerPool,
    })
    const names = metricNames(metrics)
    expect(names.has('apple_docs_reader_pool_size')).toBe(true)
    expect(names.has('apple_docs_reader_pool_active')).toBe(true)
    expect(names.has('apple_docs_reader_pool_timeouts_total')).toBe(true)
  })

  test('emits rate-limiter bucket gauge when limiter wired', () => {
    const rateLimiter = { name: 'web', _size: () => 17 }
    const metrics = buildWebMetrics({
      observability: createObservability(),
      rateLimiter,
    })
    const m = findMetric(metrics, 'apple_docs_web_rate_limit_buckets')
    expect(m).not.toBeNull()
    expect(m.samples[0].labels.name).toBe('web')
    expect(m.samples[0].value).toBe(17)
  })

  test('emits cache byte gauges only for caches that expose byteSize()', () => {
    const metrics = buildWebMetrics({
      observability: createObservability(),
      searchCache: { byteSize: () => 1024 },
      renderCache: { /* no byteSize */ },
      gzipCache: { byteSize: () => 2048 },
    })
    const m = findMetric(metrics, 'apple_docs_web_cache_bytes')
    expect(m).not.toBeNull()
    const labels = m.samples.map(s => s.labels.cache).sort()
    expect(labels).toEqual(['gzip', 'search'])
  })

  test('emits event-loop lag percentiles when sampler wired', () => {
    const eventLoopLag = {
      snapshot: () => ({ p50: 0.4, p95: 1.2, p99: 3.8, max: 9.1, samples: 600 }),
    }
    const metrics = buildWebMetrics({
      observability: createObservability(),
      eventLoopLag,
    })
    const lag = findMetric(metrics, 'apple_docs_event_loop_lag_ms')
    expect(lag).not.toBeNull()
    const byQuantile = Object.fromEntries(lag.samples.map(s => [s.labels.quantile, s.value]))
    expect(byQuantile['0.5']).toBe(0.4)
    expect(byQuantile['0.95']).toBe(1.2)
    expect(byQuantile['0.99']).toBe(3.8)
    expect(byQuantile.max).toBe(9.1)

    const samples = findMetric(metrics, 'apple_docs_event_loop_lag_samples')
    expect(samples.samples[0].value).toBe(600)
  })

  test('always emits process memory gauges', () => {
    const metrics = buildWebMetrics({ observability: createObservability() })
    const names = metricNames(metrics)
    expect(names.has('apple_docs_process_rss_bytes')).toBe(true)
    expect(names.has('apple_docs_process_heap_bytes')).toBe(true)
    const heap = findMetric(metrics, 'apple_docs_process_heap_bytes')
    const kinds = new Set(heap.samples.map(s => s.labels.kind))
    expect(kinds.has('used')).toBe(true)
    expect(kinds.has('total')).toBe(true)
  })
})

describe('observability classifyRoute', () => {
  test('collapses dynamic paths into bounded labels', () => {
    const obs = createObservability()
    expect(obs.classifyRoute('/docs/swiftui/view')).toBe('/docs/*')
    expect(obs.classifyRoute('/api/symbols/public/heart.svg')).toBe('/api/symbols')
    expect(obs.classifyRoute('/data/frameworks/swiftui/tree.abcd123456.json')).toBe('/data/*')
    expect(obs.classifyRoute('/assets/search.js')).toBe('/assets/*')
    expect(obs.classifyRoute('/healthz')).toBe('/healthz')
    expect(obs.classifyRoute('/random/path')).toBe('other')
  })
})
