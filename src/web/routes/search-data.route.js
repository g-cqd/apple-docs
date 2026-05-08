import { jsonResponse } from '../responses.js'

/**
 * `/data/search/search-manifest.json` — version stamp + fingerprinted file
 * names for the title index and alias map. The body itself is not
 * fingerprinted because clients always request the manifest first, but it
 * is hashable so revisits short-circuit on If-None-Match.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function searchManifestHandler(_request, ctx) {
  return jsonResponse(ctx.getSearchManifest(), {
    headers: { 'Cache-Control': 'no-cache' },
    hashable: true,
  })
}

const HASHED_ARTIFACT_PATTERN = /^\/data\/search\/(?:title-index|aliases)\.[0-9a-f]{10}\.json$/

/**
 * Content-hashed search artifacts (`title-index.<hash>.json` /
 * `aliases.<hash>.json`). The hash in the URL changes when the corpus
 * changes, so the body for a given URL is immutable and CF can store it
 * forever. Falls back to 404 on any other hashed name (e.g. an old shape
 * a client cached pre-migration).
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function searchHashedArtifactHandler(_request, ctx, url) {
  if (!HASHED_ARTIFACT_PATTERN.test(url.pathname)) return null
  const fileName = url.pathname.replace('/data/search/', '')
  if (fileName.startsWith('title-index.')) {
    return jsonResponse(ctx.getTitleIndex(), {
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      hashable: true,
    })
  }
  if (fileName.startsWith('aliases.')) {
    return jsonResponse(ctx.getAliasMap(), {
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      hashable: true,
    })
  }
  return new Response('Not Found', { status: 404 })
}

/**
 * Backward-compat route for clients that bookmarked the unhashed name.
 * Modern clients fetch the fingerprinted artifact via the manifest and
 * never hit this path.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function titleIndexLegacyHandler(_request, ctx) {
  return jsonResponse(ctx.getTitleIndex())
}

/**
 * Backward-compat route for the alias map's unhashed name. Same rationale
 * as titleIndexLegacyHandler.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function aliasMapLegacyHandler(_request, ctx) {
  return jsonResponse(ctx.getAliasMap())
}
