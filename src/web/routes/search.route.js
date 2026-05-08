import { createHash } from 'node:crypto'
import { search } from '../../commands/search.js'
import { jsonResponse, API_CORPUS_CACHE_CONTROL } from '../responses.js'

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
