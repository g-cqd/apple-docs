import { join } from 'node:path'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server.js'
import { createCacheRegistry } from './cache.js'
import { createMarkdownCache } from './markdown-cache.js'
import { buildHealthBody, buildReadinessResponse } from './health-handlers.js'
import { createReaderPools } from '../storage/reader-pools.js'
import { BackpressureError, Semaphore } from '../lib/semaphore.js'
import { isLoopbackOrigin, readJsonRpcBodyCapped } from '../lib/http-body.js'
import { maybeStartMcpMetricsServer } from './metrics-provider.js'

// JSON-RPC over HTTP — no HTML, so CSP doesn't apply. Isolation +
// Permissions-Policy aligned with web/context.js for browser callers.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

const CORS_ALLOWED_HEADERS = 'content-type, mcp-session-id, mcp-protocol-version, last-event-id'
const CORS_EXPOSE_HEADERS = 'mcp-session-id'
const CORS_METHODS = 'GET, POST, DELETE, OPTIONS'

// Tool names whose handlers can saturate the Bun event loop (FTS + ranking +
// SQLite reads + markdown hydration). Gated through a bounded semaphore so
// that cheap protocol traffic (initialize, ping, tools/list) never waits
// behind a burst of heavy calls from another client.
//
// `list_frameworks` and `list_taxonomy` are intentionally NOT heavy: they are
// cache-wrapped with static/near-static payloads (taxonomy is invalidated
// only on `apple-docs update`) and their uncached miss path is a small bulk
// SQL read, not CPU-bound ranking work.
const HEAVY_TOOLS = new Set([
  'search_docs',
  'read_doc',
  'browse',
  'search_sf_symbols',
  'render_sf_symbol',
  'render_font_text',
])

// Active permits. Without a worker pool, heavy SQL work blocks the single
// Bun event loop regardless of permit count, so raising this buys you queued
// requests rather than parallelism. 8 is a small bump that absorbs typical
// burst fan-out while still serializing predictably. The setting only
// scales up meaningfully once the reader-worker pool is enabled.
const DEFAULT_HEAVY_CONCURRENCY = 8
// Waiting room depth before 503 backpressure kicks in. 64 is generous on
// purpose: most bursts drain in well under a second, and the cost of an
// oversize queue is only memory, while the cost of a 503 is a visible error
// to the caller. Tune down via APPLE_DOCS_MCP_QUEUE if upstream latency SLOs
// require shedding load sooner.
const DEFAULT_HEAVY_QUEUE = 64

/**
 * Start an MCP server exposing the corpus over Streamable HTTP.
 *
 * No authentication. Intended to run behind a private boundary — either
 * localhost or a tunnel whose public surface is gated upstream. Binds to
 * 127.0.0.1 by default; pass --host 0.0.0.0 to expose on the LAN.
 *
 * @param {object} opts - { port?, host?, allowedOrigins? }
 * @param {object} ctx - shared command context ({ db, dataDir, logger, ... })
 * @param {object} [deps] - dependency injection for tests
 * @returns {{ server: object, url: string, close: () => Promise<void> }}
 */
export async function startHttpServer(opts, ctx, deps = {}) {
  const { logger } = ctx
  const port = opts.port ?? 3031
  const host = opts.host ?? '127.0.0.1'
  const allowedOrigins = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : []
  const createServerImpl = deps.createServer ?? createServer
  // Stateless transport; enableJsonResponse so POSTs return plain
  // application/json instead of a one-event text/event-stream. The SSE
  // framing confuses some Streamable HTTP clients (notably rmcp/Codex),
  // and we never push server-initiated messages for a POST request, so
  // the stream offers no benefit here.
  const createTransport = deps.createTransport ?? (() =>
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    }))
  const serveImpl = deps.serve ?? ((cfg) => Bun.serve(cfg))

  // `APPLE_DOCS_MCP_CACHE_SCALE` uniformly multiplies every default cache
  // capacity (response cache + markdown cache). Default 1 keeps the laptop
  // footprint unchanged. Public instances with headroom typically run 5–10.
  // Parses as a positive float; anything invalid falls back to 1.
  const cacheScale = parsePositiveNumber(process.env.APPLE_DOCS_MCP_CACHE_SCALE) ?? 1
  // One cache registry for the lifetime of the HTTP process. Each request
  // instantiates a fresh McpServer (required by the stateless SDK transport)
  // but reuses the same registry, so hits survive across requests.
  const cacheRegistry = deps.cacheRegistry ?? createCacheRegistry(ctx, { scale: cacheScale })
  // Separate LRU keyed by page path alone, so read_doc variants that differ
  // only by section/maxChars/match share a single `renderMarkdown()` run.
  // Plumbed through `ctx.markdownCache` — lookup() consults it when present.
  const markdownCache = deps.markdownCache ?? createMarkdownCache(ctx, { scale: cacheScale })
  // Worker-thread reader pool. Opt-in via APPLE_DOCS_MCP_READERS=on.
  // When active, heavy read-only SQL work routes to dedicated worker
  // threads each holding their own bun:sqlite handle, genuinely
  // parallelizing the FTS/trigram/body search paths. When absent,
  // `runRead()` falls through to the main-thread handle.
  const readerPool = await resolveReaderPool(ctx, opts, deps, logger)
  const ctxWithCaches = { ...ctx, markdownCache, ...(readerPool ? { readerPool } : {}) }
  const exposeCacheStats = process.env.APPLE_DOCS_MCP_CACHE_STATS === '1'

  // Bound in-flight heavy-tool work so a burst from one client can't starve
  // the event loop and block cheap protocol messages (initialize, ping,
  // tools/list) from any other client. Overflow returns JSON-RPC -32003 +
  // HTTP 503 so the caller can retry rather than hanging on a silent queue.
  const heavyMax = deps.heavyConcurrency
    ?? parsePositiveInt(process.env.APPLE_DOCS_MCP_CONCURRENCY)
    ?? DEFAULT_HEAVY_CONCURRENCY
  const heavyQueue = deps.heavyQueue
    ?? parseNonNegativeInt(process.env.APPLE_DOCS_MCP_QUEUE)
    ?? DEFAULT_HEAVY_QUEUE
  const heavySemaphore = deps.heavySemaphore
    ?? new Semaphore(heavyMax, { maxWaiters: heavyQueue })
  const concurrencyStats = { rejected: 0 }

  // When no --allow-origin is set, deny browser origins except loopback.
  function originOk(request) {
    const origin = request.headers.get('origin')
    if (!origin) return true
    if (allowedOrigins.length > 0) return allowedOrigins.includes(origin)
    return isLoopbackOrigin(origin)
  }

  function applySecurityHeaders(response) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v)
    return response
  }

  function applyCorsHeaders(request, response) {
    const origin = request.headers.get('origin')
    if (!origin) return response
    if (!originOk(request)) return response
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS)
    response.headers.set('Vary', 'Origin')
    return response
  }

  function corsPreflight(request) {
    const origin = request.headers.get('origin') ?? ''
    const allowed = originOk(request)
    const headers = new Headers({
      'Access-Control-Allow-Methods': CORS_METHODS,
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
      'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    })
    if (allowed && origin) headers.set('Access-Control-Allow-Origin', origin)
    return new Response(null, { status: allowed ? 204 : 403, headers })
  }

  async function handle(request, meta) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json(buildHealthBody({
        exposeCacheStats, cacheRegistry, markdownCache,
        heavyMax, heavyQueue, heavySemaphore,
        concurrencyStats, readerPool,
      }))
    }
    if (url.pathname === '/readyz') return buildReadinessResponse({ ctx, readerPool })

    if (url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 })
    }

    if (request.method === 'OPTIONS') return corsPreflight(request)

    if (!originOk(request)) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' } },
        { status: 403 },
      )
    }

    // Peek JSON-RPC method so heavy tool calls can be gated without making
    // initialize/ping/tools/list/notifications/resources wait behind them.
    // Body is buffered once (size-capped via readJsonRpcBodyCapped) and
    // forwarded to the transport via a cloned Request.
    let forwardRequest = request
    let priority = 'light'
    if (request.method === 'POST') {
      const result = await readJsonRpcBodyCapped(request)
      if (!result.ok) return result.response
      priority = classifyRpcPayload(result.body)
      forwardRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: result.body,
      })
    }

    meta.priority = priority

    const dispatch = async () => {
      // Per MCP SDK (webStandardStreamableHttp.js): in stateless mode each
      // request must use a fresh transport + server. The shared cacheRegistry
      // injected here is what makes the LRU effective across requests.
      const mcpServer = createServerImpl(ctxWithCaches, { cacheRegistry })
      const transport = createTransport()
      await mcpServer.connect(transport)
      const response = await transport.handleRequest(forwardRequest)
      // Safe to close only when the Response is buffered end-to-end, i.e. a
      // POST handled with enableJsonResponse:true or a DELETE (status-only
      // body). GET returns a live text/event-stream ReadableStream; closing
      // the transport here would tear the stream down before the client
      // reads a single event. We accept the pre-existing leak on GET for
      // now — GET SSE is rarely used with stateless transports.
      if (forwardRequest.method === 'POST' || forwardRequest.method === 'DELETE') {
        try { await mcpServer.close?.() } catch {}
        try { await transport.close?.() } catch {}
      }
      return response
    }

    if (priority !== 'heavy') return dispatch()

    const waitStart = Date.now()
    try {
      return await heavySemaphore.run(async () => {
        meta.waitMs = Date.now() - waitStart
        const holdStart = Date.now()
        try {
          return await dispatch()
        } finally {
          meta.holdMs = Date.now() - holdStart
        }
      })
    } catch (err) {
      if (err instanceof BackpressureError) {
        concurrencyStats.rejected++
        meta.rejected = true
        return busyResponse()
      }
      throw err
    }
  }

  function busyResponse() {
    return Response.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'Server busy: too many concurrent tool calls. Retry shortly.',
        },
        id: null,
      },
      { status: 503, headers: { 'Retry-After': '1' } },
    )
  }

  const server = serveImpl({
    port,
    hostname: host,
    async fetch(request) {
      const started = Date.now()
      const url = new URL(request.url)
      const ua = request.headers.get('user-agent') ?? '-'
      const cfRay = request.headers.get('cf-ray') ?? '-'
      const accept = request.headers.get('accept') ?? '-'
      // A35: echo sane inbound X-Request-Id; mint a UUID otherwise.
      const incomingId = request.headers.get('x-request-id')
      const requestId = incomingId && /^[A-Za-z0-9._:+/=-]{1,128}$/.test(incomingId)
        ? incomingId : crypto.randomUUID()
      const meta = { requestId }
      try {
        const response = await handle(request, meta)
        applyCorsHeaders(request, response)
        applySecurityHeaders(response)
        response.headers.set('X-Request-Id', requestId)
        const tag = buildPriorityTag(meta)
        logger?.info?.(`${request.method} ${url.pathname} -> ${response.status} ${Date.now() - started}ms${tag} req=${requestId} ua="${ua}" cf-ray=${cfRay} accept="${accept}"`)
        return response
      } catch (err) {
        logger?.error?.(`${request.method} ${url.pathname} -> 500 ${Date.now() - started}ms req=${requestId} err="${err?.message}" ua="${ua}" cf-ray=${cfRay}`, { stack: err?.stack })
        const response = Response.json(
          { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } },
          { status: 500 },
        )
        applySecurityHeaders(response)
        response.headers.set('X-Request-Id', requestId)
        return response
      }
    },
  })

  const resolvedPort = server?.port ?? port
  const url = `http://${host}:${resolvedPort}/mcp`
  logger?.info?.(`MCP HTTP server listening at ${url}`)
  const metricsHandle = maybeStartMcpMetricsServer(opts, { logger, serve: deps.serveMetrics, cacheRegistry, markdownCache, heavySemaphore, concurrencyStats, readerPool })
  const close = async (deadlineMs) => {
    try { server?.stop?.(true) } catch {}
    try { await Promise.all([metricsHandle?.close?.(), readerPool?.close?.({ softDrainMs: deadlineMs ?? 0 })]) } catch {}
  }
  return { server, url, close, metricsUrl: metricsHandle?.url ?? null }
}

/**
 * Classify a JSON-RPC POST payload as 'heavy' (a tools/call that may saturate
 * the event loop) or 'light' (everything else: initialize, ping, tools/list,
 * resources/*, notifications/*, malformed). Unknown or unparseable payloads
 * are treated as light — the transport will produce the right error, and we
 * would rather not throttle on data we can't interpret.
 */
export function classifyRpcPayload(bodyText) {
  if (!bodyText) return 'light'
  let parsed
  try { parsed = JSON.parse(bodyText) } catch { return 'light' }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch: throttle if any sub-call is heavy.
    return parsed.some(item => isHeavyRpc(item)) ? 'heavy' : 'light'
  }
  return isHeavyRpc(parsed) ? 'heavy' : 'light'
}

function isHeavyRpc(message) {
  if (!message || typeof message !== 'object') return false
  if (message.method !== 'tools/call') return false
  const name = message?.params?.name
  return typeof name === 'string' && HEAVY_TOOLS.has(name)
}

function buildPriorityTag(meta) {
  const parts = []
  if (meta.priority === 'heavy') {
    parts.push(`prio=heavy wait=${meta.waitMs ?? 0}ms hold=${meta.holdMs ?? 0}ms`)
    if (meta.rejected) parts.push('rejected=1')
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

/**
 * Resolve an optional reader-thread pool for this HTTP server.
 *
 * Returns:
 *   - `deps.readerPool` verbatim when tests inject one (null-safe: `null`
 *     means "explicitly disabled", `undefined` means "fall through to env").
 *   - `null` when `APPLE_DOCS_MCP_READERS !== 'on'`. The pool is opt-in.
 *   - `null` when `ctx.dataDir` is missing or the DB is in-memory. Workers
 *     need a real file path; `:memory:` handles do not survive a thread
 *     boundary.
 *   - A started pool instance otherwise.
 *
 * Errors during `start()` are logged and downgraded to `null` — the HTTP
 * server stays usable on the main-thread handle rather than failing to boot.
 */
async function resolveReaderPool(ctx, _opts, deps, logger) {
  if (deps && 'readerPool' in deps) return deps.readerPool ?? null
  if (process.env.APPLE_DOCS_MCP_READERS !== 'on') return null
  const dataDir = ctx?.dataDir
  if (!dataDir) {
    logger?.warn?.('reader-pool: ctx.dataDir missing, skipping')
    return null
  }
  const dbPath = join(dataDir, 'apple-docs.db')
  // Strict + deep pools so heavy fuzzy/body work doesn't poison the
  // SLO read path.
  const strictSize = parsePositiveInt(process.env.APPLE_DOCS_MCP_READER_WORKERS) ?? undefined
  const deepSize = parsePositiveInt(process.env.APPLE_DOCS_MCP_DEEP_READERS) ?? undefined
  try {
    const pool = createReaderPools({
      dbPath,
      strictSize,
      deepSize,
      log: (level, msg) => logger?.[level]?.(`reader-pool: ${msg}`),
    })
    await pool.start()
    const snap = pool.stats()
    logger?.info?.(
      `reader-pool: ready strict=${snap.pools.strict.size} deep=${snap.pools.deep.size} spawns=${snap.spawns}`,
    )
    return pool
  } catch (err) {
    logger?.error?.(`reader-pool: failed to start (${err?.message ?? err}); falling back to main-thread reads`)
    return null
  }
}

// Three flavors of "parse env into a usable number" + a shared helper.
function parseNumber(value, parser, predicate) {
  const n = value == null ? Number.NaN : parser(value, 10)
  return Number.isFinite(n) && predicate(n) ? n : null
}
const parsePositiveInt = (v) => parseNumber(v, Number.parseInt, n => n > 0)
const parseNonNegativeInt = (v) => parseNumber(v, Number.parseInt, n => n >= 0)
const parsePositiveNumber = (v) => parseNumber(v, Number.parseFloat, n => n > 0)
