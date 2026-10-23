import { describe, expect, test } from 'bun:test'
import runSandbox, { verdictFrom } from '../../../ops/cmd/sandbox.js'

const ENV = (sandbox = 'on') => ({ vars: { SANDBOX_SERVE: sandbox, WEB_BACKEND_PORT: '3130', MCP_BACKEND_PORT: '3131' } })

function captureLogger() {
  const lines = []
  return { lines, say: m => lines.push(m), warn: m => lines.push(`W:${m}`), error: m => lines.push(`E:${m}`) }
}

const healthz = (body) => ({ ok: true, status: 200, body: JSON.stringify(body) })
const probeFor = (byPort) => async (url) => byPort[new URL(url).port]

describe('verdictFrom', () => {
  test.each([
    [healthz({ ok: true, sandboxed: true }), 'confined'],
    [healthz({ ok: true, sandboxed: false }), 'NOT confined'],
    [healthz({ ok: true, sandboxed: null }), 'unknown'],
    [healthz({ ok: true }), 'unknown'],
    [{ ok: true, status: 200, body: 'not json' }, 'unknown'],
    [{ ok: false, status: null, body: '' }, 'unreachable'],
    [{ ok: false, status: 503, body: '{"sandboxed":true}' }, 'unreachable'],
  ])('maps %j to %s', (result, verdict) => {
    expect(verdictFrom(result)).toBe(verdict)
  })
})

describe('sandbox status', () => {
  const run = (sandbox, byPort) => {
    const logger = captureLogger()
    return runSandbox({ args: ['status'], envLoader: () => ENV(sandbox), logger, deps: { probe: probeFor(byPort) } }).then(code => ({ code, logger }))
  }
  const confined = healthz({ sandboxed: true })

  test('exits 0 when both backends are confined', async () => {
    const { code, logger } = await run('on', { 3130: confined, 3131: confined })
    expect(code).toBe(0)
    expect(logger.lines.filter(l => l.includes('confined') && !l.includes('NOT'))).toHaveLength(2)
  })

  test('exits 1 and names the backend that is not confined', async () => {
    const { code, logger } = await run('on', { 3130: confined, 3131: healthz({ sandboxed: false }) })
    expect(code).toBe(1)
    expect(logger.lines.some(l => l.includes('mcp') && l.includes('NOT confined'))).toBe(true)
  })

  test('exits 1 when a backend is unreachable, rather than assuming it is confined', async () => {
    const { code } = await run('on', { 3130: confined, 3131: { ok: false, status: null, body: '' } })
    expect(code).toBe(1)
  })

  test('exits 1 for a server too old to report, since it cannot be verified', async () => {
    const { code } = await run('on', { 3130: healthz({ ok: true }), 3131: confined })
    expect(code).toBe(1)
  })

  test('with SANDBOX_SERVE=off it reports the choice and exits 0 even when not confined', async () => {
    const { code, logger } = await run('off', { 3130: healthz({ sandboxed: false }), 3131: healthz({ sandboxed: false }) })
    expect(code).toBe(0)
    expect(logger.lines[0]).toContain('disabled by configuration')
  })

  test('rejects an unknown verb with exit 64', async () => {
    const logger = captureLogger()
    expect(await runSandbox({ args: ['bogus'], envLoader: () => ENV(), logger, deps: { probe: async () => ({}) } })).toBe(64)
  })

  test('probes the loopback healthz of the web and MCP backends only', async () => {
    const urls = []
    await runSandbox({ args: [], envLoader: () => ENV(), logger: captureLogger(), deps: { probe: async (u) => { urls.push(u); return confined } } })
    expect(urls).toEqual(['http://127.0.0.1:3130/healthz', 'http://127.0.0.1:3131/healthz'])
  })
})
