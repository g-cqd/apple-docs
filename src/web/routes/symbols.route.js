import { getPrerenderedSymbolPath, renderSfSymbol, searchSfSymbols } from '../../resources/apple-assets.js'
import { jsonResponse, fileResponseRevalidated, notFoundResponse } from '../responses.js'

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
  return jsonResponse(row, { hashable: true })
}

/**
 * `/api/symbols/<public|private>/<name>.{svg|png}` — render path. Falls
 * through to the on-disk pre-rendered SVG when the request is the
 * canonical theme-neutral one (no fg/bg/size/weight/scale overrides) so
 * the symbols-page grid never blocks on Swift. Any customisation routes
 * to the live renderer.
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
  if (format === 'svg' && !fgParam && !bgParam && !sizeParam && !weightParam && !scaleParam) {
    const cached = getPrerenderedSymbolPath(ctx, scope, decodedName)
    const cachedFile = Bun.file(cached)
    if (await cachedFile.exists()) {
      return await fileResponseRevalidated(request, cachedFile, {
        contentType: 'image/svg+xml; charset=utf-8',
        maxAge: 86400,
      })
    }
  }
  try {
    const render = await renderSfSymbol({
      scope,
      name: decodedName,
      format,
      size: sizeParam ?? undefined,
      color: fgParam ?? undefined,
      background: bgParam ?? undefined,
      weight: weightParam ?? undefined,
      scale: scaleParam ?? undefined,
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
  }
}
