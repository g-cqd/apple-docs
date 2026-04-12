import { describe, test, expect } from 'bun:test'
import { RateLimiter } from '../../src/lib/rate-limiter.js'

describe('RateLimiter', () => {
  test('allows burst requests immediately', async () => {
    const limiter = new RateLimiter(10, 3)
    const start = Date.now()

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()

    const elapsed = Date.now() - start
    // All 3 should be near-instant (within burst)
    expect(elapsed).toBeLessThan(50)
  })

  test('delays requests beyond burst', async () => {
    const limiter = new RateLimiter(10, 1) // 1 burst, 10/sec = 100ms between
    const start = Date.now()

    await limiter.acquire() // immediate
    await limiter.acquire() // should wait ~100ms

    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(80) // allow some variance
    expect(elapsed).toBeLessThan(300)
  })

  test('multiple concurrent acquires are serialized', async () => {
    const limiter = new RateLimiter(20, 2) // 2 burst, 20/sec = 50ms between
    const timestamps = []

    const tasks = Array.from({ length: 5 }, () =>
      limiter.acquire().then(() => timestamps.push(Date.now()))
    )

    await Promise.all(tasks)
    expect(timestamps.length).toBe(5)

    // First 2 should be near-instant (burst), remaining 3 spaced ~50ms apart
    const gaps = []
    for (let i = 1; i < timestamps.length; i++) {
      gaps.push(timestamps[i] - timestamps[i - 1])
    }
    // At least some gaps should exist after burst exhaustion
    const totalTime = timestamps[timestamps.length - 1] - timestamps[0]
    expect(totalTime).toBeGreaterThanOrEqual(100) // at least ~3 * 50ms
  })
})
