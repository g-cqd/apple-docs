import { describe, expect, test } from 'bun:test'
import { createEdgeRateGate, resolveRateGateConfig, DEFAULT_BURST, DEFAULT_RATE_PER_SECOND } from '../../../src/lib/edge-rate-gate.js'
import { isEdgeRequest, resolveClientIp } from '../../../src/lib/http-edge.js'
import { createRateLimiter } from '../../../src/lib/ip-rate-limiter.js'

const req = (path = '/api/search', headers = {}) => new Request(`http://127.0.0.1:3130${path}`, { headers })
const EDGE = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc-DUS' }

describe('isEdgeRequest', () => {
  test('is true when Cloudflare stamped either header', () => {
    expect(isEdgeRequest(req('/', { 'cf-ray': 'x' }))).toBe(true)
    expect(isEdgeRequest(req('/', { 'cf-connecting-ip': '1.1.1.1' }))).toBe(true)
  })
  test('is false for local traffic and for X-Forwarded-For alone', () => {
    expect(isEdgeRequest(req('/'))).toBe(false)
    expect(isEdgeRequest(req('/', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false)
  })
})

describe('resolveClientIp', () => {
  test('prefers CF-Connecting-IP over X-Forwarded-For and the socket', () => {
    const server = { requestIP: () => ({ address: '127.0.0.1' }) }
    const r = req('/', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '127.0.0.1' })
    expect(resolveClientIp(r, server)).toBe('203.0.113.9')
  })
  test('falls back to the first X-Forwarded-For hop, then the socket, then "unknown"', () => {
    expect(resolveClientIp(req('/', { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }))).toBe('10.0.0.1')
    expect(resolveClientIp(req('/'), { requestIP: () => ({ address: '9.9.9.9' }) })).toBe('9.9.9.9')
    expect(resolveClientIp(req('/'), { requestIP: () => { throw new Error('closed') } })).toBe('unknown')
    expect(resolveClientIp(req('/'))).toBe('unknown')
  })
})

describe('resolveRateGateConfig', () => {
  test('defaults to edge-only with the public defaults', () => {
    expect(resolveRateGateConfig({}, 'APPLE_DOCS_WEB')).toEqual({
      mode: 'edge', rate: DEFAULT_RATE_PER_SECOND, burst: DEFAULT_BURST,
    })
  })
  test.each([
    [{ APPLE_DOCS_WEB_RATE_LIMIT: '0' }, 'off'],
    [{ APPLE_DOCS_WEB_RATE_LIMIT: '1' }, 'all'],
    [{ APPLE_DOCS_WEB_RATE: '5' }, 'all'],
    [{ APPLE_DOCS_WEB_BURST: '9' }, 'all'],
    [{ APPLE_DOCS_WEB_RATE: '5', APPLE_DOCS_WEB_RATE_LIMIT: '0' }, 'off'],
  ])('env %p selects mode %s', (env, mode) => {
    expect(resolveRateGateConfig(env, 'APPLE_DOCS_WEB').mode).toBe(mode)
  })
  test('forceAll opts in programmatically', () => {
    expect(resolveRateGateConfig({}, 'APPLE_DOCS_WEB', { forceAll: true }).mode).toBe('all')
  })
  test('ignores non-positive and non-numeric overrides', () => {
    const cfg = resolveRateGateConfig({ APPLE_DOCS_MCP_RATE_LIMIT: '1', APPLE_DOCS_MCP_RATE: '-3', APPLE_DOCS_MCP_BURST: 'abc' }, 'APPLE_DOCS_MCP')
    expect(cfg).toEqual({ mode: 'all', rate: DEFAULT_RATE_PER_SECOND, burst: DEFAULT_BURST })
  })
})

describe('createEdgeRateGate', () => {
  const makeGate = (mode) => createEdgeRateGate({ mode, limiter: createRateLimiter({ rate: 0.001, burst: 1, name: 'test' }) })

  test('edge mode limits edge traffic per visitor and never touches local traffic', () => {
    const gate = makeGate('edge')
    const visitor = (ip) => req('/api/search', { ...EDGE, 'cf-connecting-ip': ip })
    expect(gate.check(visitor('203.0.113.1')).ok).toBe(true)
    expect(gate.check(visitor('203.0.113.1')).ok).toBe(false)
    expect(gate.check(visitor('203.0.113.2')).ok).toBe(true)
    for (let i = 0; i < 20; i++) expect(gate.check(req('/api/search')).ok).toBe(true)
  })
  test('all mode also limits local traffic', () => {
    const gate = makeGate('all')
    expect(gate.check(req('/api/search')).ok).toBe(true)
    expect(gate.check(req('/api/search')).ok).toBe(false)
  })
  test('off mode never limits', () => {
    const gate = makeGate('off')
    for (let i = 0; i < 5; i++) expect(gate.check(req('/api/search', EDGE)).ok).toBe(true)
  })
  test('health and readiness probes are exempt even from the edge', () => {
    const gate = makeGate('all')
    for (let i = 0; i < 5; i++) {
      expect(gate.check(req('/healthz', EDGE)).ok).toBe(true)
      expect(gate.check(req('/readyz', EDGE)).ok).toBe(true)
    }
  })
  test('a denied check reports a positive Retry-After', () => {
    const gate = makeGate('all')
    gate.check(req('/x'))
    const denied = gate.check(req('/x'))
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })
})
