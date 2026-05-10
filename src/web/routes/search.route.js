import { createHash } from 'node:crypto'
import { search } from '../../commands/search.js'
import { jsonResponse, API_CORPUS_CACHE_CONTROL } from '../responses.js'
import { BackpressureError, Semaphore } from '../../lib/semaphore.js'

/**
 * Bounded concurrency for explicit `deep=1` search requests.
 *
 * The deep reader pool itself is small (default 2), so a hostile peer
 * sending a flood of `deep=1` requests can pin every deep slot for
 * the configured deadline window — saturating other clients' deep
 * search even though strict reads stay fast. This module-level
 * semaphore caps concurrent deep requests across the whole web
 * server; overflow returns HTTP 503 + Retry-After so the caller
 * retries instead of queueing without bound.
 *
 * `maxWaiters` is sized to ~2× the gate so a brief burst is absorbed
 * without 503s; sustained pressure trips the rejection path.
 */
const DEEP_GATE_MAX_INFLIGHT = parsePositiveInt(process.env.APPLE_DOCS_WEB_DEEP_INFLIGHT) ?? 4
const DEEP_GATE_MAX_WAITERS = parsePositiveInt(process.env.APPLE_DOCS_WEB_DEEP_QUEUE) ?? 8
const deepGate = new Semaphore(DEEP_GATE_MAX_INFLIGHT, { maxWaiters: DEEP_GATE_MAX_WAITERS })

function parsePositiveInt(value) {
  const n = value == null ? NaN : Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * `/api/search` — the latency-sensitive endpoint that powers the search
 * page and the in-page autocompleter. Builds a normalized search-opts
 * object from the query string, hits Bun's in-process LRU keyed on
 * (opts, corpus stamp), and falls through to commands/search.js on miss.
 *
 * The Cache-Control directive (`API_CORPUS_CACHE_CONTROL`) plus the
 * Cloudflare cache rule for `/api/*` makes the edge serve cached responses
 * for repeat queries; the deploy-time `purge_everything` keeps it
 * coherent across syncs.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function searchHandler(_request, ctx, url) {
  const query = url.searchParams.get('q')
  if (!query) return jsonResponse({ results: [], total: 0 })
  const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('full_text') === '1'
  const searchOpts = {
    query,
    limit: Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50') || 50, 200),
    fuzzy: url.searchParams.get('fuzzy') === '1' && url.searchParams.get('no_fuzzy') !== '1',
    noDeep: url.searchParams.get('no_deep') === '1' || !deep,
    noEager: url.searchParams.get('no_eager') === '1',
    fast: url.searchParams.get('exhaustive') !== '1',
  }
  for (const key of ['framework', 'language', 'source', 'kind', 'platform']) {
    const val = url.searchParams.get(key)
    if (val) searchOpts[key] = val
  }
  for (const key of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos']) {
    const val = url.searchParams.get(key)
    if (val) searchOpts[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = val
  }
  const year = url.searchParams.get('year')
  if (year) searchOpts.year = Number.parseInt(year)
  const track = url.searchParams.get('track')
  if (track) searchOpts.track = track
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0') || 0
  if (offset > 0) searchOpts.offset = offset

  const { searchCache, searchCtx, corpusStamp } = ctx
  const cacheKey = searchResponseCacheKey(searchOpts, corpusStamp.get())
  const cached = searchCache.get(cacheKey)
  if (cached !== undefined) {
    return jsonResponse(cached, {
      hashable: true,
      headers: { 'x-apple-docs-cache': 'hit', 'Cache-Control': API_CORPUS_CACHE_CONTROL },
    })
  }
  // Gate explicit deep requests through the module-level semaphore.
  // Cheap requests (deep=false) bypass — the strict pool handles them
  // with low latency. Overflow returns 503 + Retry-After.
  if (deep) {
    try {
      return await deepGate.run(async () => {
        const results = await search(searchOpts, searchCtx)
        searchCache.set(cacheKey, results)
        return jsonResponse(results, {
          hashable: true,
          headers: { 'x-apple-docs-cache': 'miss', 'Cache-Control': API_CORPUS_CACHE_CONTROL },
        })
      })
    } catch (err) {
      if (err instanceof BackpressureError) {
        return new Response('Deep search busy. Retry shortly.\n', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' },
        })
      }
      throw err
    }
  }
  const results = await search(searchOpts, searchCtx)
  searchCache.set(cacheKey, results)
  return jsonResponse(results, {
    hashable: true,
    headers: { 'x-apple-docs-cache': 'miss', 'Cache-Control': API_CORPUS_CACHE_CONTROL },
  })
}

function searchResponseCacheKey(searchOpts, stamp) {
  return createHash('sha256').update(`${stableJson(searchOpts)}\0${stamp}`).digest('hex')
}

// Stable, key-sorted JSON so logically-equal opts hash to the same key
// regardless of insertion order.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}
