import { describe, test, expect } from 'bun:test'
import runSmokeTest from '../../../ops/cmd/smoke-test.js'

function captureLogger() {
  const out = []
  return {
    out,
    say: (m) => out.push(m),
    warn: (m) => out.push('WARN:' + m),
    error: (m) => out.push('ERROR:' + m),
  }
}

function fakeEnv() {
  return {
    vars: {
      WEB_PORT: '3130',
      MCP_PORT: '3131',
      PUBLIC_WEB_HOST: 'web.example',
      PUBLIC_MCP_HOST: 'mcp.example',
      SMOKE_BURST_SIZE: '4',
      SMOKE_BURST_STAGGER_MS: '0',
      SMOKE_HEALTHZ_SAMPLES: '2',
    },
  }
}

function makeBody(json) { return JSON.stringify(json) }

function makeResp(status, body = '{"ok":true}') {
  const bytes = new TextEncoder().encode(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: new ReadableStream({
      pull(c) { c.enqueue(bytes); c.close() },
    }),
    text: () => Promise.resolve(body),
  }
}

describe('runSmokeTest', () => {
  test('returns 0 when every probe + burst succeeds', async () => {
    const calls = []
    const fetcher = (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      return Promise.resolve(makeResp(200, makeBody({ ok: true })))
    }
    const logger = captureLogger()
    const code = await runSmokeTest({
      envLoader: () => fakeEnv(),
      logger,
      deps: { fetcher, sleep: async () => {} },
    })
    expect(code).toBe(0)
    // 4 healthz + 1 warmup + 4 burst + 2 healthz mid-burst = 11
    expect(calls.length).toBeGreaterThanOrEqual(11)
    expect(logger.out.some(m => m.includes('burst: 4 requests, 0 failures'))).toBe(true)
  })

  test('returns 1 when an edge healthz returns 503', async () => {
    const fetcher = (url) => {
      if (url.includes('https://web.example')) return Promise.resolve(makeResp(503))
      return Promise.resolve(makeResp(200))
    }
    const logger = captureLogger()
    const code = await runSmokeTest({
      envLoader: () => fakeEnv(),
      logger,
      deps: { fetcher, sleep: async () => {} },
    })
    expect(code).toBe(1)
    expect(logger.out.some(m => m.includes('edge  web') && m.includes('HTTP 503'))).toBe(true)
  })

  test('returns 1 when MCP burst requests fail', async () => {
    const fetcher = (url) => {
      if (url.endsWith('/mcp')) return Promise.resolve(makeResp(500))
      return Promise.resolve(makeResp(200))
    }
    const logger = captureLogger()
    const code = await runSmokeTest({
      envLoader: () => fakeEnv(),
      logger,
      deps: { fetcher, sleep: async () => {} },
    })
    expect(code).toBe(1)
    expect(logger.out.some(m => /burst: 4 requests, [1-9]\d* failures/.test(m))).toBe(true)
  })

  test('returns 1 when all healthz samples during burst are non-2xx', async () => {
    const fetcher = (url, init) => {
      if (url.includes('/healthz') && init === undefined) {
        // initial healthz fixed
        return Promise.resolve(makeResp(200))
      }
      if (url.endsWith('/healthz')) return Promise.resolve(makeResp(503))
      return Promise.resolve(makeResp(200))
    }
    // Force the burst-mid healthz probes to return 503 by making EVERY
    // /healthz return 503 except the initial four healthz probes via
    // their URL prefix discrimination above.
    const fetcher2 = (url) => {
      if (url.includes('/healthz')) return Promise.resolve(makeResp(503))
      return Promise.resolve(makeResp(200))
    }
    const logger = captureLogger()
    const code = await runSmokeTest({
      envLoader: () => fakeEnv(),
      logger,
      deps: { fetcher: fetcher2, sleep: async () => {} },
    })
    expect(code).toBe(1)
    expect(logger.out.some(m => /healthz during burst -> 0\/2 2xx/.test(m))).toBe(true)
    void fetcher
  })

  test('warmup fetch failure does not count against smoke', async () => {
    // The warmup is the FIRST POST to /mcp; everything before it (4
    // healthz probes) is GET. We fail only that very first POST and
    // expect the smoke to still pass (4 burst calls + 2 mid-healthz +
    // 4 initial healthz all succeed).
    let mcpPosts = 0
    const fetcher = (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/mcp')) {
        mcpPosts++
        if (mcpPosts === 1) return Promise.reject(new Error('warmup ECONNREFUSED'))
      }
      return Promise.resolve(makeResp(200))
    }
    const code = await runSmokeTest({
      envLoader: () => fakeEnv(),
      logger: captureLogger(),
      deps: { fetcher, sleep: async () => {} },
    })
    expect(code).toBe(0)
    // Warmup attempt fired, then 4 burst requests = 5 POSTs total.
    expect(mcpPosts).toBe(5)
  })
})
