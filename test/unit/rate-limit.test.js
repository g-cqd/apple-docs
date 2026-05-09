import { describe, test, expect } from 'bun:test'
import { createRateLimiter, tooManyRequestsResponse } from '../../src/web/middleware/rate-limit.js'

function makeReq({ ip = '1.2.3.4', forwarded = null } = {}) {
  const headers = forwarded ? { 'x-forwarded-for': forwarded } : {}
  return new Request('http://test.local/x', { headers })
}

function makeServer(ip = '1.2.3.4') {
  return { requestIP: () => ({ address: ip }) }
}

describe('createRateLimiter', () => {
  test('first request always passes when bursts > 1', () => {
    const limiter = createRateLimiter({ rate: 60, burst: 5 })
    expect(limiter.take(makeReq(), makeServer()).ok).toBe(true)
  })

  test('exhausts the bucket after `burst` immediate requests', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 3 })
    const server = makeServer('5.6.7.8')
    expect(limiter.take(makeReq(), server).ok).toBe(true)
    expect(limiter.take(makeReq(), server).ok).toBe(true)
    expect(limiter.take(makeReq(), server).ok).toBe(true)
    const denied = limiter.take(makeReq(), server)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  test('different IPs are independent', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1 })
    expect(limiter.take(makeReq(), makeServer('1.1.1.1')).ok).toBe(true)
    // Same IP exhausted
    expect(limiter.take(makeReq(), makeServer('1.1.1.1')).ok).toBe(false)
    // Different IP unaffected
    expect(limiter.take(makeReq(), makeServer('2.2.2.2')).ok).toBe(true)
  })

  test('X-Forwarded-For wins over server.requestIP', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1 })
    const server = makeServer('direct-ip')
    expect(limiter.take(makeReq({ forwarded: 'cf-ip' }), server).ok).toBe(true)
    // Same forwarded IP exhausted regardless of remote address
    expect(limiter.take(makeReq({ forwarded: 'cf-ip' }), server).ok).toBe(false)
    // Different forwarded IP unaffected
    expect(limiter.take(makeReq({ forwarded: 'other-ip' }), server).ok).toBe(true)
  })

  test('handles X-Forwarded-For with multiple hops', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1 })
    const server = makeServer('intermediate')
    // Should key on the FIRST IP (the original client)
    limiter.take(makeReq({ forwarded: 'client, proxy1, proxy2' }), server)
    expect(limiter.take(makeReq({ forwarded: 'client, different-proxy' }), server).ok).toBe(false)
  })

  test('token regeneration over time', async () => {
    const limiter = createRateLimiter({ rate: 100, burst: 1 })
    const server = makeServer('test-ip')
    expect(limiter.take(makeReq(), server).ok).toBe(true)
    expect(limiter.take(makeReq(), server).ok).toBe(false)
    // Wait long enough for the bucket to refill (rate=100/s → 10ms / token)
    await new Promise(r => setTimeout(r, 30))
    expect(limiter.take(makeReq(), server).ok).toBe(true)
  })

  test('LRU caps the bucket count', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1, lruCap: 3 })
    for (let i = 0; i < 10; i++) {
      limiter.take(makeReq(), makeServer(`ip-${i}`))
    }
    expect(limiter._size()).toBeLessThanOrEqual(3)
  })

  test('falls back gracefully when neither header nor server is available', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1 })
    expect(limiter.take(makeReq(), undefined).ok).toBe(true)
  })
})

describe('tooManyRequestsResponse', () => {
  test('returns 429 with Retry-After in seconds', () => {
    const res = tooManyRequestsResponse(1500, 'web')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('2')
  })

  test('floors retry-after to at least 1 second', () => {
    const res = tooManyRequestsResponse(50, 'web')
    expect(res.headers.get('retry-after')).toBe('1')
  })
})
