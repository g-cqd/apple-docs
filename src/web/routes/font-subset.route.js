/**
 * `/api/fonts/subset` — accept a list of codepoints / characters / ranges
 * and return a subset of the requested family's variable master.
 *
 * Engine: pyftsubset (Python fontTools) via a long-lived worker pool.
 * See `docs/spikes/subset-engine-parity.md` for the rationale — pyft is
 * the only engine that matches the reference `g-cqd/html-cv` pipeline
 * byte-for-byte.
 *
 * Cache shape:
 *   - Cache key: SHA-256 of `JSON.stringify({font, format, codepoints[sorted]})`.
 *     GET and POST canonicalise to the same key, so both layers share it.
 *   - Layer 1: in-memory LRU (256 entries, 64 MB byte cap).
 *   - Layer 2: on-disk `<dataDir>/cache/font-subset/<sha>.<ext>` — survives
 *     restarts and amortises the worker spawn cost across server lifetimes.
 *   - Layer 3 (external): Cloudflare edge. We emit
 *     `Cache-Control: public, max-age=31536000, immutable` and a strong
 *     `ETag: "<sha>"` so CF caches GETs forever (key = path + query).
 *
 * Cloudflare caches GETs only; POST requests bypass CF and hit the daemon
 * directly. The local LRU + disk cache keeps POST fast after the first
 * request for a given canonical key.
 *
 * Concurrency: `ctx.fontSubsetSemaphore` caps in-flight subset jobs.
 * Overflow → 503 + Retry-After: 1.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BackpressureError } from '../../lib/semaphore.js'
import { readBodyCapped, BodyTooLargeError } from '../../lib/http-body.js'
import { sha256 } from '../../lib/hash.js'
import { contentDispositionAttachment } from '../../lib/http-content-disposition.js'
import { matchesIfNoneMatch } from '../responses.js'
import {
  canonicalizePostBody,
  canonicalizeQuery,
  canonicalKeyString,
  CanonicalizeError,
} from '../lib/font-subset/canonicalize.js'
import { resolveFontPath } from '../lib/font-subset/font-resolver.js'
import { getLegalCodepointSet, capAgainst } from '../lib/font-subset/cmap-cap.js'
import { PoolUnavailableError } from '../lib/font-subset/pyftsubset-pool.js'

const MAX_BODY_BYTES = 256 * 1024 // 256 KB
const FORMAT_EXT = { woff2: 'woff2', ttf: 'ttf', otf: 'otf' }
const FORMAT_MIME = {
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** @type {import('../route-registry.js').RouteHandler} */
export async function fontSubsetHandler(request, ctx) {
  // Parse + canonicalise.
  let canonical
  try {
    if (request.method === 'POST') {
      let bodyText
      try {
        bodyText = await readBodyCapped(request, MAX_BODY_BYTES)
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return jsonError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
        }
        throw err
      }
      let body
      try { body = JSON.parse(bodyText) } catch { return jsonError(400, 'body is not valid JSON') }
      canonical = canonicalizePostBody(body)
    } else if (request.method === 'GET') {
      canonical = canonicalizeQuery(new URL(request.url).searchParams)
    } else {
      return jsonError(405, `method not allowed: ${request.method}`, { Allow: 'GET, POST' })
    }
  } catch (err) {
    if (err instanceof CanonicalizeError) {
      return jsonError(err.status, err.message, undefined, err.details)
    }
    throw err
  }

  // Resolve the source font.
  const fontPath = resolveFontPath(canonical.font, ctx.dataDir)
  if (!fontPath) {
    return jsonError(400, `font family does not support subsetting yet: ${canonical.font}`)
  }

  // Cap codepoints against the source font's cmap.
  let legalSet
  try {
    legalSet = await getLegalCodepointSet(canonical.font, fontPath)
  } catch (err) {
    ctx.logger?.warn?.(`font-subset: failed to parse cmap for ${canonical.font}: ${err?.message ?? err}`)
    return jsonError(500, 'failed to inspect source font')
  }
  const capped = capAgainst(legalSet, canonical.codepoints)
  if (!capped.ok) {
    return jsonError(422, 'one or more codepoints are not in the source font', undefined, {
      illegal: capped.illegal,
      illegalCount: capped.illegalCount,
      sampled: capped.illegal.length,
    })
  }

  // Cache lookup.
  const keyString = canonicalKeyString(canonical)
  const sha = sha256(keyString)
  const ext = FORMAT_EXT[canonical.format]
  const mime = FORMAT_MIME[canonical.format]
  const etag = `"${sha}"`

  const baseHeaders = {
    'Content-Type': mime,
    'ETag': etag,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': contentDispositionAttachment(`${canonical.font}-${sha.slice(0, 8)}.${ext}`),
    'Vary': 'Accept-Encoding',
  }

  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: baseHeaders })
  }

  const cache = ctx.fontSubsetCache
  const memHit = cache?.get?.(sha)
  if (memHit) {
    return new Response(memHit, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(memHit.byteLength) },
    })
  }

  const diskDir = join(ctx.dataDir, 'cache', 'font-subset')
  const diskPath = join(diskDir, `${sha}.${ext}`)
  if (existsSync(diskPath)) {
    try {
      const bytes = new Uint8Array(await readFile(diskPath))
      cache?.set?.(sha, bytes)
      return new Response(bytes, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(bytes.byteLength) },
      })
    } catch (err) {
      ctx.logger?.warn?.(`font-subset: disk read failed for ${sha}: ${err?.message ?? err}`)
      // Fall through to a fresh subset.
    }
  }

  // Cold path — pool.run() under the semaphore.
  if (!ctx.fontSubsetPool) {
    return jsonError(503, 'font subsetting unavailable: pool not initialised', { 'Retry-After': '1' })
  }
  if (ctx.fontSubsetPool.isDegraded?.()) {
    return jsonError(503, 'font subsetting unavailable: pyftsubset not available on host', { 'Retry-After': '60' })
  }

  let permitHeld = false
  try {
    try {
      await ctx.fontSubsetSemaphore?.acquire?.()
      permitHeld = !!ctx.fontSubsetSemaphore
    } catch (err) {
      if (err instanceof BackpressureError) {
        return new Response('Subset queue full. Retry after 1s.\n', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' },
        })
      }
      throw err
    }

    let bytes
    try {
      bytes = await ctx.fontSubsetPool.run({ canonical, fontPath })
    } catch (err) {
      if (err instanceof PoolUnavailableError) {
        return jsonError(503, err.message, { 'Retry-After': '60' }, { setupHint: err.setupHint })
      }
      ctx.logger?.warn?.(`font-subset: pool error: ${err?.message ?? err}`)
      return jsonError(500, 'subset failed')
    }

    // Persist to LRU + disk. Failures here must not fail the response.
    cache?.set?.(sha, bytes)
    try {
      if (!existsSync(diskDir)) mkdirSync(diskDir, { recursive: true })
      const tempPath = `${diskPath}.${process.pid}.${Date.now()}.tmp`
      await Bun.write(tempPath, bytes)
      renameSync(tempPath, diskPath)
    } catch (err) {
      ctx.logger?.warn?.(`font-subset: disk cache write failed: ${err?.message ?? err}`)
    }

    return new Response(bytes, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(bytes.byteLength) },
    })
  } finally {
    if (permitHeld) ctx.fontSubsetSemaphore?.release?.()
  }
}

function jsonError(status, message, extraHeaders, details) {
  const body = { error: message }
  if (details && typeof details === 'object') Object.assign(body, details)
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders || {}),
    },
  })
}
