import { textResponse, jsonResponse } from '../responses.js'
import { VERSION } from '../../lib/version.js'
import { buildRobotsTxt, buildApiCatalog, buildMcpServerCard } from '../discovery.js'

// Discovery endpoints are a pure function of siteConfig (no corpus
// dependency), so a flat hour of shared-cache life is safe and they're
// `hashable` for ETag + gzip + 304.
const DISCOVERY_CACHE_CONTROL = 'public, max-age=3600'

/**
 * `/robots.txt` — content-signal policy + sitemap pointer. Served by Bun so
 * it works under `apple-docs web serve` (the static `public/robots.txt` is
 * only reachable behind Caddy in production).
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function robotsTxtHandler(_request, ctx) {
  return textResponse(buildRobotsTxt(ctx.siteConfig), {
    contentType: 'text/plain; charset=utf-8',
    headers: { 'Cache-Control': DISCOVERY_CACHE_CONTROL },
    hashable: true,
  })
}

/**
 * `/.well-known/api-catalog` — RFC 9727 linkset (RFC 9264 JSON).
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function apiCatalogHandler(_request, ctx) {
  return textResponse(JSON.stringify(buildApiCatalog(ctx.siteConfig)), {
    contentType: 'application/linkset+json',
    headers: { 'Cache-Control': DISCOVERY_CACHE_CONTROL },
    hashable: true,
  })
}

/**
 * `/.well-known/mcp/server-card.json` — MCP server identity + tool list.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function mcpServerCardHandler(_request, ctx) {
  return jsonResponse(buildMcpServerCard(ctx.siteConfig, VERSION), {
    headers: { 'Cache-Control': DISCOVERY_CACHE_CONTROL },
    hashable: true,
  })
}
