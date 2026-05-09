import { extname } from 'node:path'
import { listAppleFonts, renderFontText } from '../../resources/apple-assets.js'
import { BackpressureError } from '../../lib/errors.js'
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
  const file = Bun.file(font.file_path)
  if (!(await file.exists())) return new Response('Not Found', { status: 404 })
  const ext = extname(font.file_path).toLowerCase()
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
  // Dedupe by file_name as a defensive belt; the schema upgrade in v12
  // already enforces this at insert time.
  const entries = []
  const seen = new Set()
  for (const fontFile of filtered) {
    if (seen.has(fontFile.file_name)) continue
    const file = Bun.file(fontFile.file_path)
    if (!(await file.exists())) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    entries.push({ name: fontFile.file_name, data: bytes })
    seen.add(fontFile.file_name)
  }
  if (entries.length === 0) return new Response('Not Found', { status: 404 })
  const zip = buildStoreZip(entries)
  const fileNameSuffix = subset !== 'all' ? `-${subset}` : ''
  // ETag derived from the SHA-1 of the zip bytes — STORE-method archives
  // are deterministic enough that identical inputs produce identical
  // bytes, so the ETag changes if and only if the family contents change
  // (or we add/remove subsets).
  const etag = `"${sha256(zip).slice(0, 16)}"`
  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDispositionAttachment(`${familyId}${fileNameSuffix}.zip`),
    'Content-Length': String(zip.byteLength),
    'ETag': etag,
    'Cache-Control': 'public, max-age=86400, must-revalidate',
  })
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(zip, { status: 200, headers })
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
