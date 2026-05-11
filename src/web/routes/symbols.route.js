import { getPrerenderedSymbolPath, renderSfSymbol, searchSfSymbols } from '../../resources/apple-assets.js'
import { BackpressureError } from '../../lib/errors.js'
import { jsonResponse, fileResponseRevalidated, notFoundResponse } from '../responses.js'
import { validateSymbolParams } from './render-validation.js'

/**
 * `/api/symbols/search` — keyword search across the SF Symbols catalog.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function symbolsSearchHandler(_request, ctx, url) {
  return jsonResponse(
    searchSfSymbols(
      url.searchParams.get('q') ?? '',
      {
        scope: url.searchParams.get('scope') || undefined,
        limit: url.searchParams.get('limit') || undefined,
      },
      ctx,
    ),
    { hashable: true },
  )
}

/**
 * `/api/symbols/<public|private>/<name>.json` — single-symbol metadata.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function symbolMetadataHandler(_request, ctx, _url, match) {
  const [, scope, encodedName] = match
  const decodedName = decodeURIComponent(encodedName)
  const row = ctx.db.getSfSymbol(scope, decodedName)
  if (!row) return new Response('Not Found', { status: 404 })
  // Surface the Private Use Area codepoint (and its U+XXXX display
  // form) when the sync-time Swift dump resolved one. NULL codepoints
  // are omitted from the response so the client can simply `if`-guard.
  if (row.codepoint != null) {
    row.codepoint_display = `U+${row.codepoint.toString(16).toUpperCase().padStart(4, '0')}`
  } else {
    delete row.codepoint
    delete row.codepoint_display
  }
  return jsonResponse(row, { hashable: true })
}

/**
 * `/api/symbols/<public|private>/<name>.{svg|png}` — render path. Serves
 * pre-rendered snapshot SVG geometry directly when there are no visual
 * overrides (fg/bg/size). Weight/scale select pre-rendered public variants;
 * custom colours, sizes, and PNGs go through the snapshot-first renderer
 * with live CoreGlyphs/AppKit as fallback.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function symbolRenderHandler(request, ctx, url, match) {
  const [, scope, encodedName, format] = match
  const decodedName = decodeURIComponent(encodedName)
  const fgParam = url.searchParams.get('fg') ?? url.searchParams.get('color')
  const bgParam = url.searchParams.get('bg')
  const sizeParam = url.searchParams.get('size')
  const weightParam = url.searchParams.get('weight')
  const scaleParam = url.searchParams.get('scale')
  const validated = validateSymbolParams({
    size: sizeParam,
    color: fgParam,
    background: bgParam,
    weight: weightParam,
    scale: scaleParam,
  })
  if (!validated.ok) return jsonResponse({ error: validated.error }, { status: 400 })

  if (format === 'svg' && !fgParam && !bgParam && !sizeParam) {
    const cached = getPrerenderedSymbolPath(ctx, scope, decodedName, {
      weight: validated.value.weight,
      scale: validated.value.scale,
    })
    const cachedFile = Bun.file(cached)
    if (await cachedFile.exists()) {
      return await fileResponseRevalidated(request, cachedFile, {
        contentType: 'image/svg+xml; charset=utf-8',
        maxAge: 86400,
      })
    }
  }
  // A1: render through the per-server concurrency cap so a burst of cold
  // requests can't pin every Swift process. Backpressure overflow → 503
  // with a brief Retry-After so clients back off instead of retrying
  // immediately.
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
    const render = await renderSfSymbol({
      scope,
      name: decodedName,
      format,
      ...validated.value,
    }, ctx)
    const file = Bun.file(render.file_path)
    // Live renders are keyed off (renderer, scope, name, format, size,
    // color, background) — same parameters always yield the same on-disk
    // file. The URL captures every dimension, so a bumped renderer
    // produces a new cache row + new file path. We still issue an ETag
    // instead of `immutable` so that a renderer bump on the *server* side
    // flushes browser caches even when the URL hasn't changed (older
    // clients with the same params).
    return await fileResponseRevalidated(request, file, {
      contentType: render.mime_type,
      maxAge: 86400,
    })
  } catch {
    return notFoundResponse(ctx.siteConfig)
  } finally {
    ctx.renderSemaphore?.release()
  }
}
