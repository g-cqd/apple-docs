import { sha256 } from '../../lib/hash.js'
import { buildFrameworkTreeData } from '../templates.js'

/**
 * `/data/frameworks/<slug>/tree.<hash>.json` — framework tree-view JSON.
 * Filled by the framework-page render in docs.route.js. If the cache
 * misses (cold start, eviction, or a bot probing a stale hash) we
 * re-render the framework's tree JSON from the DB so the URL is always
 * satisfiable. Hashed responses are immutable to Cloudflare.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function frameworkTreeHandler(_request, ctx, _url, match) {
  const { db, frameworkTreeCache, siteConfig } = ctx
  const [, slug, hash] = match
  const cacheKey = `${slug}:${hash}`
  let json = frameworkTreeCache.get(cacheKey)
  if (json === undefined) {
    const root = db.getRootBySlug(slug)
    if (!root) return new Response('Not Found', { status: 404 })
    const docs = db.getPagesByRoot(root.slug)
    const treeEdges = db.getFrameworkTree(root.slug)
    const fresh = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
    if (!fresh.hasTree) return new Response('Not Found', { status: 404 })
    // Surface the freshly-computed JSON regardless of hash mismatch: the
    // requested URL has the hash baked in, so there's no risk of serving
    // the wrong content under a different cache key.
    json = fresh.json
    frameworkTreeCache.set(`${slug}:${sha256(fresh.json).slice(0, 10)}`, fresh.json)
  }
  return new Response(json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
