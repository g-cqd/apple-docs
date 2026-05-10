import { gzipSync } from 'node:zlib'
import { sha256 } from '../lib/hash.js'
import { renderNotFoundPage } from './templates.js'

/**
 * Cache directive for JSON endpoints whose result is a pure function of the
 * current corpus (`/api/search`, `/api/filters`). Cloudflare's default
 * policy is to skip caching JSON without an explicit Cache-Control
 * directive, so these used to land at Bun on every request even though the
 * corpus is effectively static between syncs. Pairing this directive with
 * an explicit CF cache purge after every deploy (ops/bin/cf-purge.sh)
 * gives instant coherence without staleness drift.
 */
export const API_CORPUS_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600'

/**
 * Filename-extension → MIME type lookup used by both the asset routes and
 * the file-response helpers. Lives at module scope so route handlers don't
 * have to import the table from a stateful context object.
 */
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.dfont': 'application/octet-stream',
  '.zip': 'application/zip',
}

/**
 * Content types that benefit from gzip on the wire. Binaries (images,
 * fonts, archives) are already compressed and gain nothing from another
 * pass, so they stay out of this set.
 */
export const COMPRESSIBLE = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
])

/**
 * @typedef {object} JsonResponseOptions
 * @property {Record<string, string>} [headers]
 * @property {number} [status]
 * @property {boolean} [hashable] When true, finalizeResponse will hash the
 *   body to compute an ETag and emit 304 on If-None-Match match.
 */

/**
 * @param {unknown} data
 * @param {JsonResponseOptions} [options]
 * @returns {Response}
 */
export function jsonResponse(data, { headers = {}, status = 200, hashable = false } = {}) {
  const response = Response.json(data, { status, headers })
  if (hashable) response.headers.set('x-apple-docs-hashable', '1')
  return response
}

/**
 * @typedef {object} TextResponseOptions
 * @property {string} [contentType]
 * @property {Record<string, string>} [headers]
 * @property {number} [status]
 * @property {boolean} [hashable]
 */

/**
 * @param {string | Uint8Array} body
 * @param {TextResponseOptions} [options]
 * @returns {Response}
 */
export function textResponse(body, { contentType = 'text/plain; charset=utf-8', headers = {}, status = 200, hashable = false } = {}) {
  const response = new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      ...headers,
    },
  })
  if (hashable) response.headers.set('x-apple-docs-hashable', '1')
  return response
}

/**
 * Render the corpus-aware 404 page. The HTML's inline JS reads
 * window.location to derive a search query from the requested URL, so users
 * land on the search page pre-filled with what they were looking for.
 * @param {object} siteConfig
 * @returns {Response}
 */
export function notFoundResponse(siteConfig) {
  return new Response(renderNotFoundPage(siteConfig), {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

/**
 * Build a JSON 5xx error response with stack-trace stripping in production.
 *
 * Development logs benefit from full stack traces in the response body,
 * but production deployments would leak file paths, function names, and
 * sometimes captured argument values to an unauthenticated client.
 * `NODE_ENV=production` strips the stack from the wire; the structured
 * log line via `lib/logger.js` still keeps everything.
 *
 * @param {Error|string} error
 * @param {{ status?: number, exposeStack?: boolean }} [opts]
 */
export function errorResponse(error, opts = {}) {
  const status = opts.status ?? 500
  const exposeStack = opts.exposeStack ?? (process.env.NODE_ENV !== 'production')
  const message = typeof error === 'string' ? error : (error?.message ?? 'Internal error')
  const body = { error: message }
  if (exposeStack && error?.stack) body.stack = String(error.stack)
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Loose If-None-Match parser per RFC 7232. Accepts the `*` wildcard, a
 * single tag, or a comma-separated list. Strong/weak prefix is preserved
 * verbatim for comparison — callers are expected to use strong tags.
 * @param {string | null | undefined} headerValue
 * @param {string} etag
 * @returns {boolean}
 */
export function matchesIfNoneMatch(headerValue, etag) {
  if (!headerValue) return false
  const value = headerValue.trim()
  if (value === '*') return true
  return value.split(',').map(part => part.trim()).includes(etag)
}

/**
 * @typedef {object} FileResponseOptions
 * @property {string} contentType
 * @property {string} [contentDisposition]
 * @property {number} [maxAge]
 */

/**
 * Build a 304-aware response for a Bun.file backed asset whose URL is
 * stable but whose contents may change (pre-rendered symbol SVGs, extracted
 * font files, family ZIPs). The ETag is composed from the on-disk
 * mtime + size — far cheaper than hashing the bytes, and sufficient
 * because every regeneration path either rewrites the file or replaces it
 * atomically.
 * @param {Request} request
 * @param {ReturnType<typeof Bun.file>} file
 * @param {FileResponseOptions} options
 * @returns {Promise<Response>}
 */
export async function fileResponseRevalidated(request, file, {
  contentType,
  contentDisposition,
  maxAge = 86400,
}) {
  let stat
  try {
    stat = await file.stat()
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  const etag = `"${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}"`
  const headers = new Headers({
    'Content-Type': contentType,
    'ETag': etag,
    // Allow shared caches (Caddy / Cloudflare / browser) to keep the bytes
    // for `maxAge` seconds, but require a conditional GET after that so we
    // never pin a stale render once the prerender cache or the on-disk
    // font is rewritten.
    'Cache-Control': `public, max-age=${maxAge}, must-revalidate`,
  })
  if (contentDisposition) headers.set('Content-Disposition', contentDisposition)
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(file, { status: 200, headers })
}

/**
 * Hashable-aware response post-processing: if the upstream handler tagged
 * the response with `x-apple-docs-hashable=1`, attach a content-hash ETag
 * and short-circuit on If-None-Match match. Falls through to gzip
 * compression for compressible MIME types when the client advertises gzip
 * in Accept-Encoding.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {{ gzipCache: { get: (k: string) => Uint8Array | undefined, set: (k: string, v: Uint8Array) => void } }} options
 * @returns {Promise<Response>}
 */
export async function finalizeResponse(request, response, { gzipCache }) {
  const accept = request.headers.get('accept-encoding') || ''
  const hashable = response.headers.get('x-apple-docs-hashable') === '1'
  response.headers.delete('x-apple-docs-hashable')

  const contentType = response.headers.get('content-type') || ''
  const mimeBase = contentType.split(';')[0].trim()

  if (hashable) {
    const body = await response.text()
    const etag = `"${sha256(body).slice(0, 16)}"`
    const headers = new Headers(response.headers)
    headers.set('ETag', etag)

    if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      headers.delete('Content-Encoding')
      headers.delete('Content-Length')
      headers.delete('Content-Type')
      return new Response(null, { status: 304, headers })
    }

    if (accept.includes('gzip') && COMPRESSIBLE.has(mimeBase)) {
      let compressed = gzipCache.get(etag)
      if (!compressed) {
        compressed = gzipSync(Buffer.from(body))
        gzipCache.set(etag, compressed)
      }
      headers.set('Content-Encoding', 'gzip')
      headers.set('Content-Length', String(compressed.length))
      return new Response(compressed, { status: response.status, headers })
    }

    return new Response(body, { status: response.status, headers })
  }

  // Only the hashable / cacheable gzip path is supported. A sync
  // `gzipSync` on every non-hashable response would block the event
  // loop for ~10–50 ms on 1 MB payloads and dominate TTFB because every
  // dynamic response paid the cost without a cache.
  //
  // The hashable path above keeps its cached gzip — those bodies are
  // deterministic functions of their inputs (search results, doc HTML)
  // and the LRU amortizes the compress cost across requests. The
  // non-hashable path was only hit by one-off responses (errors,
  // redirects, ad-hoc payloads) where uncompressed bandwidth is
  // negligible AND the deployment is expected to be CDN-fronted (Caddy
  // / Cloudflare handle compression at the edge for free). Direct-served
  // dev instances pay marginally more bytes; CPU is the constrained
  // resource so this is the right tradeoff.

  return response
}
