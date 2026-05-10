import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { startHttpServer } from '../../src/mcp/http-server.js'
import { DocsDatabase } from '../../src/storage/database.js'

let db
let handle

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(async () => {
  try { await handle?.close?.() } catch {}
  db.close()
})

describe('MCP HTTP — Prometheus /metrics endpoint (D.2)', () => {
  test('--metrics-port spawns a separate /metrics listener with apple_docs_mcp_ metrics', async () => {
    handle = await startHttpServer(
      { port: 0, host: '127.0.0.1', metricsPort: 0 },
      { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } },
    )
    expect(handle.metricsUrl).toBeTruthy()
    expect(handle.metricsUrl).not.toBe(handle.url) // distinct listener

    const res = await fetch(handle.metricsUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
    const body = await res.text()
    // Heavy-semaphore series is always present (the semaphore is constructed
    // unconditionally), so the exposition body is non-empty for an MCP
    // server even with a fresh DB and no traffic.
    expect(body).toContain('apple_docs_heavy_semaphore_active')
    expect(body).toMatch(/^# HELP /m)
    expect(body).toMatch(/^# TYPE /m)
  })

  test('main MCP port returns 404 for /metrics (telemetry must not leak on the public listener)', async () => {
    handle = await startHttpServer(
      { port: 0, host: '127.0.0.1', metricsPort: 0 },
      { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } },
    )
    const mainBase = handle.url.replace(/\/mcp$/, '')
    const res = await fetch(`${mainBase}/metrics`)
    expect(res.status).toBe(404)
  })

  test('omitting --metrics-port leaves metricsUrl null and no listener running', async () => {
    handle = await startHttpServer(
      { port: 0, host: '127.0.0.1' },
      { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } },
    )
    expect(handle.metricsUrl).toBeNull()
  })

  test('HEAD /metrics returns 200 with no body (Prometheus health probes)', async () => {
    handle = await startHttpServer(
      { port: 0, host: '127.0.0.1', metricsPort: 0 },
      { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } },
    )
    const res = await fetch(handle.metricsUrl, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
  })

  test('POST /metrics returns 405 with Allow header', async () => {
    handle = await startHttpServer(
      { port: 0, host: '127.0.0.1', metricsPort: 0 },
      { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } },
    )
    const res = await fetch(handle.metricsUrl, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('GET')
  })
})
