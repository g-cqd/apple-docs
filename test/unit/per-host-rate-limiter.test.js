import { describe, expect, test } from 'bun:test'
import { createHostBucketedLimiter } from '../../src/lib/per-host-rate-limiter.js'

describe('createHostBucketedLimiter', () => {
  test('serializes requests to the same host through the same bucket', async () => {
    const limiter = createHostBucketedLimiter({
      defaults: { rate: 50, burst: 1 },
    })

    const timestamps = []

    await Promise.all([
      limiter.acquire('https://developer.apple.com/documentation/swiftui').then(() => timestamps.push(Date.now())),
      limiter.acquire('https://developer.apple.com/documentation/uikit').then(() => timestamps.push(Date.now())),
    ])

    expect(timestamps.length).toBe(2)
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(10)
  })

  test('isolates different hosts from each other', async () => {
    const limiter = createHostBucketedLimiter({
      defaults: { rate: 50, burst: 1 },
    })

    const events = []

    const sameHost1 = limiter.acquire('https://developer.apple.com/documentation/swiftui').then(() => events.push('a1'))
    const sameHost2 = limiter.acquire('https://developer.apple.com/documentation/uikit').then(() => events.push('a2'))
    const otherHost = limiter.acquire('https://raw.githubusercontent.com/apple/swift/main/README.md').then(() => events.push('b1'))

    await Promise.all([sameHost1, sameHost2, otherHost])

    expect(events.slice(0, 2).sort()).toEqual(['a1', 'b1'])
    expect(events[2]).toBe('a2')
  })

  test('falls back to a shared bucket for missing or invalid URLs', async () => {
    const limiter = createHostBucketedLimiter({
      defaults: { rate: 50, burst: 1 },
    })

    const timestamps = []

    await Promise.all([
      limiter.acquire().then(() => timestamps.push(Date.now())),
      limiter.acquire('not-a-url').then(() => timestamps.push(Date.now())),
    ])

    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(10)
  })

  test('can enforce a shared global ceiling when a primary limiter is configured', async () => {
    const limiter = createHostBucketedLimiter({
      defaults: { rate: 1000, burst: 1000 },
      primary: { rate: 50, burst: 1 },
    })

    const timestamps = []

    await Promise.all([
      limiter.acquire('https://developer.apple.com/documentation/swiftui').then(() => timestamps.push(Date.now())),
      limiter.acquire('https://raw.githubusercontent.com/apple/swift/main/README.md').then(() => timestamps.push(Date.now())),
    ])

    expect(timestamps.length).toBe(2)
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(10)
  })
})
