import { rm } from 'node:fs/promises'
import { notFoundResponse, finalizeResponse } from './responses.js'
import { createWebContext } from './context.js'
import { createRouteRegistry } from './route-registry.js'
import { createRateLimiter, tooManyRequestsResponse } from './middleware/rate-limit.js'
import { createObservability } from './middleware/observability.js'
import { maybeStartWebMetricsServer } from './metrics-provider.js'
import { createEventLoopLagSampler } from '../lib/event-loop-lag.js'
import { healthHandler, readinessHandler } from './routes/health.route.js'
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
 * @param {object} opts - { port?: number, host?: string, baseUrl?: string, rateLimit?: boolean }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ server: object, url: string }}
 */
export async function startDevServer(opts, ctx) {
  const port = opts.port ?? 3000
  // Default-deny LAN exposure. Bun.serve binds all interfaces when
  // hostname is omitted; loopback is the safer default for `web serve`,
  // which is documented as a local preview tool. Operators who want LAN
  // reach pass --host 0.0.0.0 (or APPLE_DOCS_WEB_HOST=0.0.0.0).
  const host = opts.host ?? process.env.APPLE_DOCS_WEB_HOST ?? '127.0.0.1'
  const webCtx = await createWebContext(opts, ctx)
  const { logger, siteConfig, readerPool, securityHeaders, gzipCache } = webCtx

  // Per-client-IP token-bucket gate. Disabled by default — most deployments
  // front the dev server with Caddy / Cloudflare, which handle abuse
  // controls upstream. Enable explicitly via:
  //   APPLE_DOCS_WEB_RATE_LIMIT=1
  //   APPLE_DOCS_WEB_RATE=<rps>   (also implies on)
  //   APPLE_DOCS_WEB_BURST=<n>    (also implies on)
  //   opts.rateLimit === true
  // The strict 5/min limit on the /docs/<key> on-demand-fetch path lives
  // inside docs.route.js (A7) and is independent — that's a specific SSRF
  // amplifier control, not general rate limiting.
  const rateLimitOptIn = opts.rateLimit === true
    || process.env.APPLE_DOCS_WEB_RATE_LIMIT === '1'
    || process.env.APPLE_DOCS_WEB_RATE != null
    || process.env.APPLE_DOCS_WEB_BURST != null
  const defaultLimiter = rateLimitOptIn
    ? createRateLimiter({
        rate: parsePositiveNumber(process.env.APPLE_DOCS_WEB_RATE) ?? 60,
        burst: parsePositiveNumber(process.env.APPLE_DOCS_WEB_BURST) ?? 120,
        name: 'web',
      })
    : null

  const registry = createRouteRegistry()
  registry.register('/healthz', healthHandler)
  registry.register('/readyz', readinessHandler)
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

  // Phase 1.1: per-request observability — latency histogram + per-route
  // counter. Cheap (one performance.now() at entry, one at exit, plus a
  // map write); surfaced via /metrics.
  const observability = createObservability()
  // Phase 1.2: event-loop lag sampler runs in the background and feeds
  // /metrics. Auto-detects synchronous blockers (gzipSync, sync regex,
  // recursive parsers) so they show up as p99 lag.
  const eventLoopLag = createEventLoopLagSampler()

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(request, srv) {
      const reqStart = performance.now()
      if (defaultLimiter) {
        const defaultGate = defaultLimiter.take(request, srv)
        if (!defaultGate.ok) return tooManyRequestsResponse(defaultGate.retryAfterMs, defaultLimiter.name)
      }
      // Stash srv on ctx so handlers can resolve client IP for their own
      // gates (A7 docs on-demand). webCtx is per-server, so this is safe
      // for the duration of the request — Bun re-enters fetch for each.
      webCtx._server = srv
      // A35: correlation IDs. Echo the inbound X-Request-Id when present
      // (so an upstream proxy / browser-injected header survives intact);
      // mint one with crypto.randomUUID() otherwise. Stash on webCtx for
      // the request scope so log records can pick it up.
      const incoming = request.headers.get('x-request-id')
      const requestId = incoming && /^[A-Za-z0-9._:+/=-]{1,128}$/.test(incoming)
        ? incoming
        : crypto.randomUUID()
      webCtx._requestId = requestId
      const response = await handleRequest(request)
      for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v)
      response.headers.set('X-Request-Id', requestId)
      const finalized = await finalizeResponse(request, response, { gzipCache })
      observability.record({
        pathname: new URL(request.url).pathname,
        status: finalized.status,
        ms: performance.now() - reqStart,
      })
      return finalized
    },
  })

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  // Phase D.2 / 1.1: optional Prometheus scrape endpoint on a separate
  // loopback listener. No-op when --metrics-port is absent. Bypasses the
  // main rate-limit + security-headers middleware on purpose — scrape
  // bursts would flap the limiter and Prometheus brings its own auth.
  const metricsHandle = maybeStartWebMetricsServer(opts, {
    logger,
    readerPool,
    rateLimiter: defaultLimiter,
    searchCache: webCtx.searchCache,
    renderCache: webCtx.renderCache,
    gzipCache,
    bundleCache: webCtx.bundleCache,
    observability,
    eventLoopLag,
  })

  // A1: render-cache prune cron. Runs every PRUNE_INTERVAL_MS so an
  // unbounded set of (size,color,weight,scale) param combinations on a
  // long-running server doesn't fill the disk. Both the TTL trim and the
  // byte-quota trim are best-effort — failures are logged once and the
  // next interval retries.
  const ttlDays = parsePositiveNumber(process.env.APPLE_DOCS_RENDER_CACHE_TTL_DAYS) ?? 30
  const quotaBytes = parsePositiveNumber(process.env.APPLE_DOCS_RENDER_CACHE_BYTES) ?? (5 * 1024 * 1024 * 1024)
  const pruneIntervalMs = 30 * 60 * 1000
  const pruneTimer = setInterval(() => { void pruneRenderCache() }, pruneIntervalMs)
  pruneTimer.unref?.()

  async function pruneRenderCache() {
    try {
      const cutoffIso = new Date(Date.now() - ttlDays * 86_400_000).toISOString()
      const ttlPrune = ctx.db.pruneSfSymbolRendersOlderThan(cutoffIso)
      const quotaPrune = ctx.db.pruneSfSymbolRendersToBytesQuota(quotaBytes)
      const allPaths = [...ttlPrune.paths, ...quotaPrune.paths]
      for (const filePath of allPaths) {
        await rm(filePath, { force: true }).catch(() => { /* best-effort */ })
      }
      const removed = ttlPrune.removed + quotaPrune.removed
      if (removed > 0) {
        logger?.info?.(`render-cache prune: removed ${removed} (ttl=${ttlPrune.removed}, quota=${quotaPrune.removed})`)
      }
    } catch (err) {
      logger?.warn?.(`render-cache prune failed: ${err.message}`)
    }
  }

  const originalStop = server.stop?.bind(server)
  if (originalStop) {
    server.stop = (...args) => {
      const out = originalStop(...args)
      void readerPool?.close?.()
      return out
    }
  }

  async function close(deadlineMs) {
    clearInterval(pruneTimer)
    try { eventLoopLag.stop() } catch {}
    try { originalStop?.(true) } catch {}
    try { await metricsHandle?.close?.() } catch {}
    try {
      // Forward the parent shutdown deadline as a soft-drain budget so the
      // reader pool waits for in-flight queries to settle before terminating
      // workers. Falsy / undefined → immediate close (legacy behavior).
      await readerPool?.close?.({ softDrainMs: deadlineMs ?? 0 })
    } catch {}
  }

  return { server, url: serverUrl, close, readerPool, metricsUrl: metricsHandle?.url ?? null }
}

function parsePositiveNumber(value) {
  if (value == null) return null
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

