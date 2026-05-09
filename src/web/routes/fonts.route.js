import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { extname, join } from 'node:path'
import { listAppleFonts, renderFontText } from '../../resources/apple-assets.js'
import { assertFontPathContained } from '../../resources/apple-fonts/safe-font-path.js'
import { BackpressureError, ValidationError } from '../../lib/errors.js'
import { sha256 } from '../../lib/hash.js'
import { contentDispositionAttachment } from '../../lib/http-content-disposition.js'
import { buildStoreZip } from '../../lib/zip.js'
import {
  MIME_TYPES,
  jsonResponse,
  textResponse,
  fileResponseRevalidated,
  matchesIfNoneMatch,
} from '../responses.js'
import { validateFontText } from './render-validation.js'

/**
 * `/api/fonts` — list every Apple font family the corpus has cataloged.
 * Pure DB read, hashable so revisits short-circuit on If-None-Match.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function listFontsHandler(_request, ctx) {
  return jsonResponse(listAppleFonts(ctx), { hashable: true })
}

/**
 * `/api/fonts/file/<id>` — download a single extracted font file. URL is
 * stable (font id), but Apple ships new font versions on macOS releases,
 * so we revalidate via mtime+size ETag instead of pinning forever.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function fontFileHandler(request, ctx, _url, match) {
  const font = ctx.db.getAppleFontFile(decodeURIComponent(match[1]))
  if (!font) return new Response('Not Found', { status: 404 })
  // A6: refuse to serve any font whose stored file_path resolves outside
  // the approved roots (system font dirs + dataDir/resources/fonts/extracted).
  // This is the read-side of the containment invariant.
  let safePath
  try {
    safePath = assertFontPathContained(font.file_path, ctx.dataDir)
  } catch (err) {
    if (err instanceof ValidationError) {
      ctx.logger?.warn?.(`fontFileHandler: refused unsafe path for ${font.id}: ${err.message}`)
      return new Response('Not Found', { status: 404 })
    }
    throw err
  }
  const file = Bun.file(safePath)
  if (!(await file.exists())) return new Response('Not Found', { status: 404 })
  const ext = extname(safePath).toLowerCase()
  return await fileResponseRevalidated(request, file, {
    contentType: MIME_TYPES[ext] || 'application/octet-stream',
    contentDisposition: contentDispositionAttachment(font.file_name),
    maxAge: 86400,
  })
}

/**
 * `/api/fonts/family/<id>.zip` — bundle a font family into a STORE-method
 * ZIP (deterministic bytes for stable ETags). The optional `?subset=`
 * query filters by variant (variable / static / remote / system).
 *
 * A23: persists the built archive to
 * `<dataDir>/resources/fonts/zips/<familyId>-<subset>-<inputHash>.zip`
 * on first request and serves subsequent requests through `Bun.file()`
 * directly. The hash in the filename keys on family file paths + sizes
 * + mtimes, so a font corpus update lands a different cache entry
 * automatically — no explicit invalidation needed.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function fontFamilyZipHandler(request, ctx, url, match) {
  const familyId = decodeURIComponent(match[1])
  const subset = String(url.searchParams.get('subset') ?? 'all').toLowerCase()
  const families = ctx.db.listAppleFonts()
  const family = families.find(f => f.id === familyId)
  if (!family || family.files.length === 0) return new Response('Not Found', { status: 404 })
  const filtered = family.files.filter(file => {
    switch (subset) {
      case 'variable': return !!file.is_variable
      case 'static': return !file.is_variable
      case 'remote': return file.source === 'remote'
      case 'system': return file.source === 'system'
      default: return true
    }
  })
  if (filtered.length === 0) return new Response('Not Found', { status: 404 })

  // Resolve safe paths once + collect input fingerprints. The fingerprint
  // (path|size|mtime per entry) decides cache identity: any byte-level
  // change to the source font files lands a new cache file.
  const safeFiles = []
  const seen = new Set()
  for (const fontFile of filtered) {
    if (seen.has(fontFile.file_name)) continue
    let safePath
    try {
      safePath = assertFontPathContained(fontFile.file_path, ctx.dataDir)
    } catch (err) {
      if (err instanceof ValidationError) {
        ctx.logger?.warn?.(`fontFamilyZipHandler: skipped unsafe path for ${fontFile.id}: ${err.message}`)
        continue
      }
      throw err
    }
    seen.add(fontFile.file_name)
    safeFiles.push({ name: fontFile.file_name, path: safePath })
  }
  if (safeFiles.length === 0) return new Response('Not Found', { status: 404 })

  const fingerprintParts = []
  for (const entry of safeFiles) {
    const file = Bun.file(entry.path)
    if (!(await file.exists())) continue
    fingerprintParts.push(`${entry.name}|${file.size}|${file.lastModified}`)
  }
  if (fingerprintParts.length === 0) return new Response('Not Found', { status: 404 })
  const inputHash = sha256(fingerprintParts.join('\n')).slice(0, 16)
  const fileNameSuffix = subset !== 'all' ? `-${subset}` : ''
  const cacheDir = join(ctx.dataDir, 'resources', 'fonts', 'zips')
  const cachePath = join(cacheDir, `${familyId}${fileNameSuffix}-${inputHash}.zip`)
  // Cache key is content-derived, so the ETag is too. Same lifecycle:
  // identical inputs → identical cache file → identical ETag.
  const etag = `"${inputHash}"`

  const baseHeaders = {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDispositionAttachment(`${familyId}${fileNameSuffix}.zip`),
    'ETag': etag,
    'Cache-Control': 'public, max-age=86400, must-revalidate',
  }
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: baseHeaders })
  }

  if (existsSync(cachePath)) {
    const cached = Bun.file(cachePath)
    return new Response(cached, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(cached.size) },
    })
  }

  // Cache miss: build the ZIP, persist it for subsequent requests, then
  // serve from memory this once. Use temp-and-rename so a partial write
  // can't be picked up by a concurrent reader.
  const entries = []
  for (const entry of safeFiles) {
    const file = Bun.file(entry.path)
    if (!(await file.exists())) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    entries.push({ name: entry.name, data: bytes })
  }
  if (entries.length === 0) return new Response('Not Found', { status: 404 })
  const zip = buildStoreZip(entries)
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
    await Bun.write(tempPath, zip)
    renameSync(tempPath, cachePath)
  } catch (err) {
    // Caching is best-effort; failing to write the disk copy must not
    // fail the response. Surface as a warning so operators see chronic
    // failures.
    ctx.logger?.warn?.(`fontFamilyZipHandler: cache write failed: ${err?.message ?? err}`)
  }

  return new Response(zip, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(zip.byteLength) },
  })
}

/**
 * `/api/fonts/text.svg` — render a text sample using a specific font.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function fontTextSvgHandler(_request, ctx, url) {
  const textCheck = validateFontText(url.searchParams.get('text'))
  if (!textCheck.ok) return jsonResponse({ error: textCheck.error }, { status: 400 })
  try {
    await ctx.renderSemaphore?.acquire()
  } catch (err) {
    if (err instanceof BackpressureError) {
      return new Response('Render queue full. Retry after 1s.\n', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' },
      })
    }
    throw err
  }
  try {
    const render = await renderFontText({
      fontId: url.searchParams.get('fontId'),
      text: textCheck.value,
      size: url.searchParams.get('size') ?? undefined,
    }, ctx)
    return textResponse(render.content, {
      contentType: render.mimeType,
      headers: { 'Cache-Control': 'public, max-age=86400' },
      hashable: true,
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  } finally {
    ctx.renderSemaphore?.release()
  }
}
