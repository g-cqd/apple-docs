import { describe, expect, test } from 'bun:test'
import { classifyRpcPayload, startHttpServer } from '../../src/mcp/http-server.js'

function makeLogger() {
  const calls = []
  return {
    calls,
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  }
}

async function bootHarness({
  allowedOrigins = [],
  handleRequest,
  cacheRegistry,
  heavyConcurrency,
  heavyQueue,
  heavySemaphore,
  perRequestTransport = false,
} = {}) {
  const events = []
  const mcpServer = {
    async connect(transport) { events.push(['connect', transport]) },
    async close() { events.push(['server-close']) },
  }
  const transports = []
  const makeTransport = () => {
    const t = {
      handleRequest: handleRequest ?? (async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })),
      close: async () => { events.push(['transport-close']) },
    }
    transports.push(t)
    return t
  }
  const firstTransport = makeTransport()
  let serveConfig = null
  const fakeServer = {
    port: 31337,
    stop: () => { events.push(['server-stop']) },
  }
  const createServerCalls = []
  const handle = await startHttpServer(
    { port: 3031, host: '127.0.0.1', allowedOrigins },
    { logger: makeLogger() },
    {
      createServer: (ctx, deps) => { createServerCalls.push({ ctx, deps }); return mcpServer },
      createTransport: perRequestTransport ? makeTransport : () => firstTransport,
      serve: (cfg) => { serveConfig = cfg; return fakeServer },
      ...(cacheRegistry ? { cacheRegistry } : {}),
      ...(heavyConcurrency != null ? { heavyConcurrency } : {}),
      ...(heavyQueue != null ? { heavyQueue } : {}),
      ...(heavySemaphore != null ? { heavySemaphore } : {}),
    },
  )
  return {
    handle,
    events,
    fetch: (req) => serveConfig.fetch(req),
    fakeTransport: firstTransport,
    transports,
    createServerCalls,
  }
}

const rpcBody = (method, params) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })

const callBody = (toolName, args = {}) => rpcBody('tools/call', { name: toolName, arguments: args })

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

  test('shares one cache registry across every MCP request', async () => {
    const fakeRegistry = { stats: () => ({ marker: 'shared' }) }
    const { fetch, createServerCalls } = await bootHarness({ cacheRegistry: fakeRegistry })
    const req = () => fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    await req()
    await req()
    await req()
    const nonHealth = createServerCalls.filter(c => c.deps?.cacheRegistry)
    expect(nonHealth.length).toBe(3)
    for (const call of nonHealth) {
      expect(call.deps.cacheRegistry).toBe(fakeRegistry)
    }
  })

  test('/healthz omits cache stats by default', async () => {
    const { fetch } = await bootHarness({ cacheRegistry: { stats: () => ({ marker: 'should-not-leak' }) } })
    const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
    const body = await res.json()
    expect(body).toEqual({ ok: true, service: 'apple-docs-mcp' })
    expect(body.cache).toBeUndefined()
  })

  test('closes the per-request McpServer and transport after a POST', async () => {
    const { fetch, events } = await bootHarness()
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody('initialize'),
    }))
    expect(res.status).toBe(200)
    // Both lifecycle hooks fire exactly once for the single request.
    expect(events.filter(e => e[0] === 'server-close')).toHaveLength(1)
    expect(events.filter(e => e[0] === 'transport-close')).toHaveLength(1)
  })

  test('closes per-request McpServer and transport after a DELETE', async () => {
    const { fetch, events } = await bootHarness({
      handleRequest: async () => new Response(null, { status: 200 }),
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(events.filter(e => e[0] === 'server-close')).toHaveLength(1)
    expect(events.filter(e => e[0] === 'transport-close')).toHaveLength(1)
  })

  test('GET /mcp does NOT close the transport (SSE stream must stay open)', async () => {
    // Regression guard: the SDK returns a live text/event-stream ReadableStream
    // from GET /mcp. Calling transport.close() after handleRequest resolves
    // would EOF the stream before any event could flow.
    const { fetch, events } = await bootHarness({
      handleRequest: async () => new Response(
        new ReadableStream({ start(ctrl) { /* keep open */ void ctrl } }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(events.filter(e => e[0] === 'server-close')).toHaveLength(0)
    expect(events.filter(e => e[0] === 'transport-close')).toHaveLength(0)
  })

  test('cheap protocol methods bypass the heavy-tool semaphore', async () => {
    // Zero permits and zero queue would reject any gated request; initialize
    // and tools/list must still go through because they are classified light.
    const { fetch } = await bootHarness({ heavyConcurrency: 1, heavyQueue: 0 })
    const cheap = [
      rpcBody('initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
      rpcBody('ping'),
      rpcBody('tools/list'),
      rpcBody('resources/list'),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
    ]
    for (const body of cheap) {
      const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }))
      expect(res.status).toBe(200)
    }
  })

  test('heavy tool calls serialise through the semaphore', async () => {
    let firstResolve
    const firstHandled = new Promise((resolve) => { firstResolve = resolve })
    let handleCalls = 0
    const { fetch } = await bootHarness({
      heavyConcurrency: 1,
      heavyQueue: 8,
      handleRequest: async () => {
        handleCalls++
        if (handleCalls === 1) await firstHandled
        return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      },
    })
    const post = () => fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: callBody('search_docs', { query: 'view' }),
    }))
    const p1 = post()
    const p2 = post()
    // Let the first grab the permit and the second queue behind it.
    await new Promise((r) => setTimeout(r, 5))
    expect(handleCalls).toBe(1)
    firstResolve()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(handleCalls).toBe(2)
  })

  test('heavy overflow returns HTTP 503 with JSON-RPC -32003 and Retry-After', async () => {
    let release
    const block = new Promise((resolve) => { release = resolve })
    const { fetch } = await bootHarness({
      heavyConcurrency: 1,
      heavyQueue: 0,
      handleRequest: async () => {
        await block
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
      },
    })
    const post = () => fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: callBody('read_doc', { path: 'swiftui/view' }),
    }))
    const holding = post() // grabs the single permit
    await new Promise((r) => setTimeout(r, 5))
    const rejected = await post() // queue=0 → BackpressureError
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('Retry-After')).toBe('1')
    const body = await rejected.json()
    expect(body.error.code).toBe(-32003)
    expect(body.error.message).toMatch(/busy/i)
    release()
    const held = await holding
    expect(held.status).toBe(200)
  })

  test('cheap methods stay available even when heavy permits are exhausted', async () => {
    let release
    const block = new Promise((resolve) => { release = resolve })
    // Block only the heavy body; initialize (cheap) must resolve immediately.
    const { fetch } = await bootHarness({
      heavyConcurrency: 1,
      heavyQueue: 0,
      handleRequest: async (req) => {
        const text = await req.text()
        if (text.includes('"search_docs"')) await block
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
      },
    })
    const heavy = fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: callBody('search_docs', { query: 'view' }),
    }))
    await new Promise((r) => setTimeout(r, 5))
    // This initialize must not hang on the heavy permit.
    const cheap = fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody('initialize'),
    }))
    const cheapRes = await Promise.race([
      cheap,
      new Promise((_, rej) => setTimeout(() => rej(new Error('initialize was blocked')), 250)),
    ])
    expect(cheapRes.status).toBe(200)
    release()
    await heavy
  })

  test('forwards the original JSON-RPC body to the transport after classification', async () => {
    let seenBody = null
    const { fetch } = await bootHarness({
      handleRequest: async (req) => {
        seenBody = await req.text()
        return Response.json({ jsonrpc: '2.0', id: 7, result: { ok: true } })
      },
    })
    const payload = callBody('search_docs', { query: 'NavigationStack', limit: 3 })
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }))
    expect(res.status).toBe(200)
    expect(seenBody).toBe(payload)
  })

  test('/healthz reports concurrency stats when cache stats are exposed', async () => {
    const prev = process.env.APPLE_DOCS_MCP_CACHE_STATS
    process.env.APPLE_DOCS_MCP_CACHE_STATS = '1'
    try {
      const { fetch } = await bootHarness({
        cacheRegistry: { stats: () => ({ totalHits: 0, totalMisses: 0, hitRatio: 0 }) },
        heavyConcurrency: 2,
        heavyQueue: 7,
      })
      const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
      const body = await res.json()
      expect(body.concurrency).toEqual({
        heavyMax: 2,
        heavyQueue: 7,
        active: 0,
        waiting: 0,
        rejected: 0,
      })
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'APPLE_DOCS_MCP_CACHE_STATS')
      else process.env.APPLE_DOCS_MCP_CACHE_STATS = prev
    }
  })

  test('default concurrency is 8 permits / 64 queue when no override is set', async () => {
    const prev = process.env.APPLE_DOCS_MCP_CACHE_STATS
    const prevConc = process.env.APPLE_DOCS_MCP_CONCURRENCY
    const prevQueue = process.env.APPLE_DOCS_MCP_QUEUE
    process.env.APPLE_DOCS_MCP_CACHE_STATS = '1'
    Reflect.deleteProperty(process.env, 'APPLE_DOCS_MCP_CONCURRENCY')
    Reflect.deleteProperty(process.env, 'APPLE_DOCS_MCP_QUEUE')
    try {
      const { fetch } = await bootHarness({
        cacheRegistry: { stats: () => ({ totalHits: 0, totalMisses: 0, hitRatio: 0 }) },
      })
      const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
      const body = await res.json()
      expect(body.concurrency.heavyMax).toBe(8)
      expect(body.concurrency.heavyQueue).toBe(64)
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'APPLE_DOCS_MCP_CACHE_STATS')
      else process.env.APPLE_DOCS_MCP_CACHE_STATS = prev
      if (prevConc !== undefined) process.env.APPLE_DOCS_MCP_CONCURRENCY = prevConc
      if (prevQueue !== undefined) process.env.APPLE_DOCS_MCP_QUEUE = prevQueue
    }
  })

  test('/healthz exposes cache stats when APPLE_DOCS_MCP_CACHE_STATS=1', async () => {
    const prev = process.env.APPLE_DOCS_MCP_CACHE_STATS
    process.env.APPLE_DOCS_MCP_CACHE_STATS = '1'
    try {
      const { fetch } = await bootHarness({
        cacheRegistry: { stats: () => ({ totalHits: 4, totalMisses: 1, hitRatio: 0.8 }) },
      })
      const res = await fetch(new Request('http://127.0.0.1:3031/healthz'))
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.cache).toEqual({ totalHits: 4, totalMisses: 1, hitRatio: 0.8 })
    } finally {
      // Restore the env exactly — Reflect.deleteProperty because `delete` trips
      // the lint rule and `= undefined` would coerce to the string "undefined".
      if (prev === undefined) Reflect.deleteProperty(process.env, 'APPLE_DOCS_MCP_CACHE_STATS')
      else process.env.APPLE_DOCS_MCP_CACHE_STATS = prev
    }
  })

  test('rejects POST with Content-Length over the body cap', async () => {
    const { fetch, fakeTransport } = await bootHarness()
    let reached = false
    fakeTransport.handleRequest = async () => { reached = true; return new Response('') }
    const res = await fetch(new Request('http://127.0.0.1:3031/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2000000' },
      body: '{}',
    }))
    expect(res.status).toBe(413)
    expect(reached).toBe(false)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain('too large')
  })
})

describe('classifyRpcPayload', () => {
  test('tools/call on a heavy tool is heavy', () => {
    expect(classifyRpcPayload(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search_docs', arguments: { query: 'view' } },
    }))).toBe('heavy')
    expect(classifyRpcPayload(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_doc' },
    }))).toBe('heavy')
  })

  test('tools/call on list_frameworks (non-heavy) is light', () => {
    expect(classifyRpcPayload(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_frameworks' },
    }))).toBe('light')
  })

  test('initialize / ping / tools/list / notifications / resources are light', () => {
    for (const method of ['initialize', 'ping', 'tools/list', 'resources/list', 'notifications/cancelled']) {
      expect(classifyRpcPayload(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toBe('light')
    }
  })

  test('JSON-RPC batch is heavy if any sub-call is heavy', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_docs' } },
    ]
    expect(classifyRpcPayload(JSON.stringify(batch))).toBe('heavy')
  })

  test('malformed bodies fall back to light (transport will error)', () => {
    expect(classifyRpcPayload('')).toBe('light')
    expect(classifyRpcPayload('not json')).toBe('light')
    expect(classifyRpcPayload('null')).toBe('light')
    expect(classifyRpcPayload('123')).toBe('light')
  })
})
