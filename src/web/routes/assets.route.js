import { join } from 'node:path'
import { ASSET_BUNDLES } from '../assets-manifest.js'
import { MIME_TYPES } from '../responses.js'

/**
 * `/assets/<file>` — synthesises named bundles (`core.js`, `listing.js`)
 * on the fly from `src/web/assets/` so standalone `apple-docs web serve`
 * works without a prior build, and rescues cases where Caddy falls
 * through to Bun for /assets/* (e.g. an old asset URL no longer on disk).
 *
 * In production behind Caddy, /assets/* is served from `dist/web/assets/`
 * directly via `file_server`; this branch never runs.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function assetsHandler(_request, ctx, url) {
  const file = url.pathname.replace('/assets/', '')
  if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })

  if (Object.prototype.hasOwnProperty.call(ASSET_BUNDLES, file)) {
    const parts = []
    for (const member of ASSET_BUNDLES[file]) {
      const memberPath = join(ctx.srcWebDir, 'assets', member)
      const memberFile = Bun.file(memberPath)
      if (await memberFile.exists()) {
        parts.push(await memberFile.text())
      }
    }
    if (parts.length === 0) return new Response('Not Found', { status: 404 })
    return new Response(parts.join('\n'), {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...ctx.assetCacheHeaders,
      },
    })
  }

  const filePath = join(ctx.srcWebDir, 'assets', file)
  const bunFile = Bun.file(filePath)
  if (await bunFile.exists()) {
    const ext = `.${file.split('.').pop()}`
    return new Response(bunFile, {
      headers: {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        ...ctx.assetCacheHeaders,
      },
    })
  }
  return new Response('Not Found', { status: 404 })
}

/**
 * `/worker/<file>` — pass-through for Web Worker scripts.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function workerHandler(_request, ctx, url) {
  const file = url.pathname.replace('/worker/', '')
  if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })
  const filePath = join(ctx.srcWebDir, 'worker', file)
  const bunFile = Bun.file(filePath)
  if (await bunFile.exists()) {
    return new Response(bunFile, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...ctx.assetCacheHeaders,
      },
    })
  }
  return new Response('Not Found', { status: 404 })
}
