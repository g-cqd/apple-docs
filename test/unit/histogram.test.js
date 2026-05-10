import { describe, expect, test } from 'bun:test'
import { createHistogram, DEFAULT_LATENCY_BUCKETS_MS } from '../../src/lib/histogram.js'

describe('createHistogram', () => {
  test('records values into cumulative buckets', () => {
    const h = createHistogram({ buckets: [1, 5, 10] })
    h.record(0.5)   // → bucket le=1, le=5, le=10, +Inf
    h.record(3)     // → bucket le=5, le=10, +Inf
    h.record(7)     // → bucket le=10, +Inf
    h.record(20)    // → +Inf only
    const snap = h._snapshot()
    expect(snap.counts).toEqual([1, 2, 3, 4])
    expect(snap.total).toBe(4)
    expect(snap.sum).toBeCloseTo(30.5, 5)
  })

  test('skips non-numeric / non-finite / negative values', () => {
    const h = createHistogram()
    h.record(NaN)
    h.record(Infinity)
    h.record(-1)
    h.record('5')
    h.record(undefined)
    expect(h._snapshot().total).toBe(0)
  })

  test('exposition returns bucket / sum / count metrics with le labels', () => {
    const h = createHistogram({ buckets: [10, 100] })
    h.record(5)
    h.record(50)
    h.record(500)
    const metrics = h.exposition('test_latency_ms', 'Test latency.', { route: '/api' })
    expect(metrics).toHaveLength(3)
    const [bucket, sum, count] = metrics
    expect(bucket.name).toBe('test_latency_ms_bucket')
    // 3 buckets emitted: le=10, le=100, le=+Inf
    expect(bucket.samples).toHaveLength(3)
    expect(bucket.samples[0].labels).toEqual({ route: '/api', le: '10' })
    expect(bucket.samples[0].value).toBe(1)   // only `5` falls into le=10
    expect(bucket.samples[1].value).toBe(2)   // 5 + 50 fall into le=100
    expect(bucket.samples[2].labels.le).toBe('+Inf')
    expect(bucket.samples[2].value).toBe(3)
    expect(sum.samples[0].value).toBe(555)
    expect(count.name).toBe('test_latency_ms_count')
    expect(count.samples[0].value).toBe(3)
  })

  test('default bucket layout matches the documented contract', () => {
    expect(DEFAULT_LATENCY_BUCKETS_MS).toEqual([1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500])
  })
})
