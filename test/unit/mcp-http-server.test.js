import { describe, expect, test } from 'bun:test'
import { startHttpServer } from '../../src/mcp/http-server.js'

function makeLogger() {
  const calls = []
  return {
    calls,
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  }
}

async function bootHarness({ allowedOrigins = [], handleRequest } = {}) {
  const events = []
  const mcpServer = {
    async connect(transport) { events.push(['connect', transport]) },
  }
  const fakeTransport = {
    handleRequest: handleRequest ?? (async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })),
    close: async () => { events.push(['transport-close']) },
  }
  let serveConfig = null
  const fakeServer = {
    port: 31337,
    stop: () => { events.push(['server-stop']) },
  }
  const handle = await startHttpServer(
    { port: 3031, host: '127.0.0.1', allowedOrigins },
    { logger: makeLogger() },
    {
      createServer: () => mcpServer,
      createTransport: () => fakeTransport,
      serve: (cfg) => { serveConfig = cfg; return fakeServer },
    },
  )
  return { handle, events, fetch: (req) => serveConfig.fetch(req), fakeTransport }
}

describe('startHttpServer', () => {
  test('exposes the advertised MCP URL without connecting until a request arrives', async () => {
    const { handle, events } = await bootHarness()
    expect(handle.url).toBe('http://127.0.0.1:31337/mcp')
    expect(events.map(e => e[0])).not.toContain('connect')
  })

  test('instantiates a fresh server + transport per MCP request (stateless mode)', async () => {
    const { fetch, events } = await bootHarness()
    const req = () => fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    await req()
    await req()
    const connects = events.filter(e => e[0] === 'connect')
    expect(connects.length).toBe(2)
  })

  test('healthz returns 200 without going through transport', async () => {
    const transportCalls = []
    const { fetch } = await bootHarness({
      handleRequest: async (req) => {
        transportCalls.push(req.url)
        return Response.json({})
      },
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, service: 'apple-docs-mcp' })
    expect(transportCalls).toEqual([])
  })

  test('unknown paths return 404', async () => {
    const { fetch } = await bootHarness()
    const res = await fetch(new Request('http://127.0.0.1:3031/other'))
    expect(res.status).toBe(404)
  })

  test('applies security headers to every response', async () => {
    const { fetch } = await bootHarness()
    const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  test('delegates POST /mcp to the transport when no allowlist is configured', async () => {
    const seen = []
    const { fetch } = await bootHarness({
      handleRequest: async (req) => {
        seen.push({ method: req.method, origin: req.headers.get('origin') })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://any.example' },
      body: '{}',
    }))
    expect(res.status).toBe(200)
    expect(seen).toEqual([{ method: 'POST', origin: 'https://any.example' }])
  })

  test('rejects browser Origin outside the allowlist with 403', async () => {
    const { fetch, fakeTransport } = await bootHarness({
      allowedOrigins: ['https://apple-docs-mcp.everest.mt'],
    })
    let reached = false
    fakeTransport.handleRequest = async () => { reached = true; return new Response('') }
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(403)
    expect(reached).toBe(false)
    const body = await res.json()
    expect(body.error.code).toBe(-32000)
  })

  test('allowlisted origin passes through and gets CORS headers echoed back', async () => {
    const { fetch } = await bootHarness({
      allowedOrigins: ['https://apple-docs-mcp.everest.mt'],
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { origin: 'https://apple-docs-mcp.everest.mt', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://apple-docs-mcp.everest.mt')
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe('mcp-session-id')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  test('native clients (no Origin header) are always allowed', async () => {
    const { fetch } = await bootHarness({
      allowedOrigins: ['https://apple-docs-mcp.everest.mt'],
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('OPTIONS preflight from allowed origin returns 204 with CORS headers', async () => {
    const { fetch } = await bootHarness({
      allowedOrigins: ['https://apple-docs-mcp.everest.mt'],
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://apple-docs-mcp.everest.mt',
        'access-control-request-method': 'POST',
      },
    }))
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://apple-docs-mcp.everest.mt')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('mcp-session-id')
  })

  test('OPTIONS preflight from disallowed origin returns 403', async () => {
    const { fetch } = await bootHarness({
      allowedOrigins: ['https://apple-docs-mcp.everest.mt'],
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    }))
    expect(res.status).toBe(403)
  })

  test('transport errors become JSON-RPC internal errors with 500', async () => {
    const { fetch } = await bootHarness({
      handleRequest: async () => { throw new Error('boom') },
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe(-32603)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('close() shuts down the Bun server', async () => {
    const { handle, events } = await bootHarness()
    await handle.close()
    expect(events.map(e => e[0])).toContain('server-stop')
  })
})
