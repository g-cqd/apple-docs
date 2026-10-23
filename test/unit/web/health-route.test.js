import { describe, expect, test } from 'bun:test'
import { healthHandler, readinessHandler } from '../../../src/web/routes/health.route.js'

const EDGE = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc-DUS' }
const req = (path, headers = {}) => new Request(`http://127.0.0.1:3130${path}`, { headers })

const readerStats = { active: 6, size: 6, timeouts: 0, backpressureRejects: 0, pools: { strict: { size: 6 }, deep: { size: 2 } } }

function makeCtx({ dbOk = true, readerActive = 6 } = {}) {
  return {
    db: { db: { query: () => ({ get: () => { if (!dbOk) throw new Error('db down'); return 1 } }) } },
    readerPool: { stats: () => ({ ...readerStats, active: readerActive }) },
    logger: { warn: () => {} },
  }
}

describe('GET /healthz', () => {
  test('local callers get the commit alongside the version', async () => {
    const body = await healthHandler(req('/healthz')).json()
    expect(body).toMatchObject({ ok: true, service: 'apple-docs-web' })
    expect(typeof body.version).toBe('string')
    expect(body).toHaveProperty('commit')
  })

  test('edge callers get only ok, service and version', async () => {
    const body = await healthHandler(req('/healthz', EDGE)).json()
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'version'])
  })
})

describe('GET /readyz', () => {
  test('local callers get db and reader-pool diagnostics', async () => {
    const res = readinessHandler(req('/readyz'), makeCtx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.db).toBe(true)
    expect(body.readerPool.stats.backpressureRejects).toBe(0)
  })

  test('edge callers get only {ok} and never pool sizes, timeouts or counters', async () => {
    const res = readinessHandler(req('/readyz', EDGE), makeCtx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test.each([
    ['database unreachable', { dbOk: false }],
    ['no live reader worker', { readerActive: 0 }],
  ])('returns 503 with a minimal body to the edge when %s', async (_name, opts) => {
    const res = readinessHandler(req('/readyz', EDGE), makeCtx(opts))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false })
  })

  test('local callers still see the failing component on 503', async () => {
    const res = readinessHandler(req('/readyz'), makeCtx({ dbOk: false }))
    expect(res.status).toBe(503)
    expect((await res.json()).db).toBe(false)
  })
})
