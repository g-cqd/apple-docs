import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server.js'
import { disposeHighlighter } from '../content/highlight.js'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

const CORS_ALLOWED_HEADERS = 'content-type, mcp-session-id, mcp-protocol-version, last-event-id'
const CORS_EXPOSE_HEADERS = 'mcp-session-id'
const CORS_METHODS = 'GET, POST, DELETE, OPTIONS'

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
  const disposeHighlighterImpl = deps.disposeHighlighter ?? disposeHighlighter
  const serveImpl = deps.serve ?? ((cfg) => Bun.serve(cfg))

  function originOk(request) {
    const origin = request.headers.get('origin')
    if (!origin) return true // native/non-browser clients omit Origin
    if (allowedOrigins.length === 0) return true
    return allowedOrigins.includes(origin)
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

  async function handle(request) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'apple-docs-mcp' })
    }

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

    // Per MCP SDK (webStandardStreamableHttp.js): in stateless mode each request
    // must use a fresh transport. Instantiate per-request so every client can
    // initialize independently.
    const mcpServer = createServerImpl(ctx)
    const transport = createTransport()
    await mcpServer.connect(transport)
    return transport.handleRequest(request)
  }

  const server = serveImpl({
    port,
    hostname: host,
    async fetch(request) {
      try {
        const response = await handle(request)
        applyCorsHeaders(request, response)
        return applySecurityHeaders(response)
      } catch (err) {
        logger?.error?.('MCP HTTP request failed', { err: err?.message, stack: err?.stack })
        const response = Response.json(
          { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } },
          { status: 500 },
        )
        return applySecurityHeaders(response)
      }
    },
  })

  const resolvedPort = server?.port ?? port
  const url = `http://${host}:${resolvedPort}/mcp`
  logger?.info?.(`MCP HTTP server listening at ${url}`)

  async function close() {
    try { server?.stop?.(true) } catch {}
    try { disposeHighlighterImpl() } catch {}
  }

  return { server, url, close }
}
