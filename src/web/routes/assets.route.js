import { join } from 'node:path'
import { ENTRY_BUNDLES } from '../assets-manifest.js'
import { MIME_TYPES } from '../responses.js'
import { minifyJs } from '../asset-bundler.js'

// Per-server cache of bundled JS responses. Bun.build is cheap (~4 ms for
// the core bundle locally) but rerunning it on every request adds avoidable
// latency. The cache is invalidated implicitly via assetVersion in the
// rendered HTML — every server boot mints a new querystring suffix, so a
// stale bundle is never linked from a fresh page.
const bundleCache = new Map()

async function getBundledJs(bundleName, entryRel, srcWebDir) {
  const cached = bundleCache.get(bundleName)
  if (cached) return cached
  const code = await minifyJs(join(srcWebDir, 'assets', entryRel))
  bundleCache.set(bundleName, code)
  return code
}

/**
 * `/assets/<file>` — synthesises named bundles (`core.js`, `listing.js`)
 * on the fly via Bun.build so `apple-docs web serve` works without a
 * prior build, and rescues cases where Caddy falls through to Bun for
 * /assets/* (e.g. an old asset URL no longer on disk).
 *
 * In production behind Caddy, /assets/* is served from `dist/web/assets/`
 * directly via `file_server`; this branch never runs.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function assetsHandler(_request, ctx, url) {
  const file = url.pathname.replace('/assets/', '')
  if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })

  if (Object.prototype.hasOwnProperty.call(ENTRY_BUNDLES, file)) {
    const code = await getBundledJs(file, ENTRY_BUNDLES[file], ctx.srcWebDir)
    return new Response(code, {
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
    if (ext === '.js') {
      // Standalone JS files run through the same bundler so dev preview
      // matches production minified bytes exactly.
      return new Response(await getBundledJs(file, file, ctx.srcWebDir), {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          ...ctx.assetCacheHeaders,
        },
      })
    }
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
