import { notFoundResponse, finalizeResponse } from './responses.js'
import { createWebContext } from './context.js'
import { createRouteRegistry } from './route-registry.js'
import { healthHandler } from './routes/health.route.js'
import { filtersHandler } from './routes/filters.route.js'
import { symbolsIndexHandler } from './routes/symbols-index.route.js'
import {
  searchManifestHandler,
  searchHashedArtifactHandler,
  titleIndexLegacyHandler,
  aliasMapLegacyHandler,
} from './routes/search-data.route.js'
import { searchHandler } from './routes/search.route.js'
import {
  listFontsHandler,
  fontFileHandler,
  fontFamilyZipHandler,
  fontTextSvgHandler,
} from './routes/fonts.route.js'
import {
  symbolsSearchHandler,
  symbolMetadataHandler,
  symbolRenderHandler,
} from './routes/symbols.route.js'
import {
  searchPageHandler,
  fontsPageHandler,
  symbolsPageHandler,
  homepageHandler,
} from './routes/pages.route.js'
import { assetsHandler, workerHandler } from './routes/assets.route.js'
import { frameworkTreeHandler } from './routes/framework-tree.route.js'
import { docsHandler } from './routes/docs.route.js'

/**
 * Start a local dev server for previewing documentation.
 * @param {object} opts - { port?: number, baseUrl?: string }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ server: object, url: string }}
 */
export async function startDevServer(opts, ctx) {
  const port = opts.port ?? 3000
  const webCtx = await createWebContext(opts, ctx)
  const { logger, siteConfig, readerPool, securityHeaders, gzipCache } = webCtx

  const registry = createRouteRegistry()
  registry.register('/healthz', healthHandler)
  registry.register('/api/search', searchHandler)
  registry.register('/api/filters', filtersHandler)
  registry.register('/api/fonts', listFontsHandler)
  registry.register('/api/fonts/text.svg', fontTextSvgHandler)
  registry.register('/api/symbols/index.json', symbolsIndexHandler)
  registry.register('/api/symbols/search', symbolsSearchHandler)
  registry.registerPattern(/^\/api\/fonts\/file\/([^/]+)$/, fontFileHandler)
  registry.registerPattern(/^\/api\/fonts\/family\/([^/]+)\.zip$/, fontFamilyZipHandler)
  registry.registerPattern(/^\/api\/symbols\/(public|private)\/(.+)\.json$/, symbolMetadataHandler)
  registry.registerPattern(/^\/api\/symbols\/(public|private)\/(.+)\.(svg|png)$/, symbolRenderHandler)

  // Page renderers. /symbols, /fonts, /search, /, /index.html have stable
  // exact paths; /symbols/<name> shares the same shell so it goes through a
  // pattern and gets caught after the exact /symbols match.
  registry.register('/search', searchPageHandler)
  registry.register('/search/', searchPageHandler)
  registry.register('/fonts', fontsPageHandler)
  registry.register('/fonts/', fontsPageHandler)
  registry.register('/symbols', symbolsPageHandler)
  registry.register('/symbols/', symbolsPageHandler)
  registry.register('/', homepageHandler)
  registry.register('/index.html', homepageHandler)
  registry.registerPattern(/^\/symbols\/.+$/, symbolsPageHandler)
  registry.registerPattern(/^\/assets\//, assetsHandler)
  registry.registerPattern(/^\/worker\//, workerHandler)
  registry.registerPattern(/^\/data\/frameworks\/([^/]+)\/tree\.([0-9a-f]{10})\.json$/, frameworkTreeHandler)
  registry.registerPattern(/^\/docs\//, docsHandler)
  registry.register('/data/search/search-manifest.json', searchManifestHandler)
  registry.register('/data/search/title-index.json', titleIndexLegacyHandler)
  registry.register('/data/search/aliases.json', aliasMapLegacyHandler)
  registry.registerPattern(
    /^\/data\/search\/(?:title-index|aliases)\.[0-9a-f]{10}\.json$/,
    searchHashedArtifactHandler,
  )

  async function handleRequest(request) {
    const dispatched = await registry.dispatch(request, webCtx)
    return dispatched ?? notFoundResponse(siteConfig)
  }

  const server = Bun.serve({
    port,
    async fetch(request) {
      const response = await handleRequest(request)
      for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v)
      return finalizeResponse(request, response, { gzipCache })
    },
  })

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  const originalStop = server.stop?.bind(server)
  if (originalStop) {
    server.stop = (...args) => {
      const out = originalStop(...args)
      void readerPool?.close?.()
      return out
    }
  }

  async function close(deadlineMs) {
    try { originalStop?.(true) } catch {}
    try {
      // Forward the parent shutdown deadline as a soft-drain budget so the
      // reader pool waits for in-flight queries to settle before terminating
      // workers. Falsy / undefined → immediate close (legacy behavior).
      await readerPool?.close?.({ softDrainMs: deadlineMs ?? 0 })
    } catch {}
  }

  return { server, url: serverUrl, close, readerPool }
}
