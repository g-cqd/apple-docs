import { describe, expect, test } from 'bun:test'
import { createEventLoopLagSampler, processMemorySnapshot } from '../../src/lib/event-loop-lag.js'

describe('createEventLoopLagSampler', () => {
  test('returns zeros before any sample is recorded', () => {
    const sampler = createEventLoopLagSampler({ intervalMs: 50 })
    try {
      const snap = sampler.snapshot()
      expect(snap.samples).toBe(0)
      expect(snap.p50).toBe(0)
      expect(snap.p95).toBe(0)
      expect(snap.p99).toBe(0)
      expect(snap.max).toBe(0)
    } finally {
      sampler.stop()
    }
  })

  test('records non-negative samples after a few ticks', async () => {
    const sampler = createEventLoopLagSampler({ intervalMs: 20 })
    try {
      // Wait for at least 4 ticks worth of cadence.
      await new Promise(r => setTimeout(r, 120))
      const snap = sampler.snapshot()
      expect(snap.samples).toBeGreaterThan(0)
      expect(snap.p50).toBeGreaterThanOrEqual(0)
      expect(snap.p95).toBeGreaterThanOrEqual(snap.p50)
      expect(snap.p99).toBeGreaterThanOrEqual(snap.p95)
      expect(snap.max).toBeGreaterThanOrEqual(snap.p99)
    } finally {
      sampler.stop()
    }
  })

  test('detects synthetic blocking work as elevated lag', async () => {
    const sampler = createEventLoopLagSampler({ intervalMs: 20 })
    try {
      // Block the loop synchronously for ~80 ms — should show up in p99/max.
      const blockStart = Date.now()
      while (Date.now() - blockStart < 80) { /* spin */ }
      // Then let the timer fire a few times after the block.
      await new Promise(r => setTimeout(r, 100))
      const snap = sampler.snapshot()
      // Floor: at least one sample should reflect the block (>= 50 ms is
      // a comfortable margin; some runtimes coalesce timers slightly).
      expect(snap.max).toBeGreaterThanOrEqual(50)
    } finally {
      sampler.stop()
    }
  })

  test('stop() clears the interval — no further samples accrue', async () => {
    const sampler = createEventLoopLagSampler({ intervalMs: 10 })
    await new Promise(r => setTimeout(r, 50))
    const before = sampler.snapshot().samples
    sampler.stop()
    await new Promise(r => setTimeout(r, 50))
    const after = sampler.snapshot().samples
    // Sample count is monotonically non-decreasing; since we stopped, it
    // should not have advanced.
    expect(after).toBe(before)
  })
})

describe('processMemorySnapshot', () => {
  test('returns rss / heap / external as numbers', () => {
    const snap = processMemorySnapshot()
    expect(typeof snap.rss).toBe('number')
    expect(typeof snap.heapUsed).toBe('number')
    expect(typeof snap.heapTotal).toBe('number')
    expect(typeof snap.external).toBe('number')
    expect(snap.rss).toBeGreaterThan(0)
    expect(snap.heapUsed).toBeGreaterThan(0)
    // Note: on Bun/JSC `heapTotal` can be smaller than `heapUsed` because
    // the two values reflect different allocator partitions. Don't assume
    // the Node-V8 ordering invariant — only that both are non-negative.
    expect(snap.heapTotal).toBeGreaterThanOrEqual(0)
  })
})
