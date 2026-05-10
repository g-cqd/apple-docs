/**
 * Per-request observability shim. Captures route latency into a shared
 * histogram and bumps a per-route counter so the /metrics provider can
 * surface a Prometheus-compatible histogram + counter for the web
 * server. Also tracks a small "search-mode" classifier (mode/cache/
 * deep/fuzzy) so we can answer questions like "what fraction of search
 * traffic engages the deep path?".
 *
 * Designed to be cheap on the request path:
 *   - One `performance.now()` at entry, one at exit.
 *   - Two map writes (route key + classification key) per request.
 *   - Histogram record is O(buckets) — 10 comparisons + counter bumps.
 *
 * Related: phase 1.1 of docs/plans/2026-05-10-javascript-performance-sota.md
 */

import { createHistogram } from '../../lib/histogram.js'

/**
 * Bucket request URLs into a small fixed set of route labels so the
 * histogram cardinality stays bounded. `/docs/<key>` collapses to
 * `/docs/*`; `/api/symbols/<scope>/<name>.svg` collapses to
 * `/api/symbols/*`. Everything else either matches a literal path or
 * falls through to `other`.
 */
function classifyRoute(pathname) {
  if (!pathname || pathname === '/') return '/'
  if (pathname.startsWith('/api/search')) return '/api/search'
  if (pathname.startsWith('/api/filters')) return '/api/filters'
  if (pathname.startsWith('/api/fonts')) return '/api/fonts'
  if (pathname.startsWith('/api/symbols')) return '/api/symbols'
  if (pathname.startsWith('/docs/')) return '/docs/*'
  if (pathname.startsWith('/data/')) return '/data/*'
  if (pathname.startsWith('/assets/') || pathname.startsWith('/worker/')) return '/assets/*'
  if (pathname === '/healthz' || pathname === '/readyz' || pathname === '/search'
    || pathname === '/search/' || pathname === '/fonts' || pathname === '/fonts/'
    || pathname === '/symbols' || pathname === '/symbols/' || pathname === '/index.html'
  ) return pathname
  return 'other'
}

export function createObservability() {
  const latency = createHistogram()
  // route → { count }, also segmented by status class (2xx/3xx/4xx/5xx).
  const requests = new Map()

  /**
   * Record one finished request.
   *
   * @param {{ pathname: string, status: number, ms: number }} req
   */
  function record(req) {
    const route = classifyRoute(req.pathname)
    const statusClass = `${Math.floor(req.status / 100)}xx`
    const key = `${route}|${statusClass}`
    const entry = requests.get(key)
    if (entry) {
      entry.count += 1
    } else {
      requests.set(key, { route, statusClass, count: 1 })
    }
    latency.record(req.ms)
  }

  function exposition() {
    const out = []
    // Histogram of all request latencies. We don't split the histogram
    // by route to keep cardinality low — operators who need route-level
    // p99 can correlate with the per-route counter.
    out.push(...latency.exposition('apple_docs_web_request_latency_ms', 'Web request latency in milliseconds.'))
    // Per-route counter.
    const samples = []
    for (const { route, statusClass, count } of requests.values()) {
      samples.push({ labels: { route, status: statusClass }, value: count })
    }
    out.push({
      name: 'apple_docs_web_requests_total',
      help: 'Web request count, labeled by route and status class.',
      type: 'counter',
      samples,
    })
    return out
  }

  return { record, exposition, classifyRoute }
}
