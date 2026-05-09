import { describe, expect, test } from 'bun:test'
import { BackpressureError } from '../../src/lib/errors.js'
import { createOnDemandGate } from '../../src/web/middleware/on-demand-gate.js'

function fakeRequest(ip) {
  return new Request('http://localhost/docs/x', {
    headers: { 'x-forwarded-for': ip },
  })
}

describe('createOnDemandGate (A7)', () => {
  test('per-IP bucket allows the burst then denies further calls', () => {
    const gate = createOnDemandGate({ perIpRate: 5 / 60, perIpBurst: 5 })
    const req = fakeRequest('1.2.3.4')
    for (let i = 0; i < 5; i++) {
      expect(gate.checkPerIp(req).ok).toBe(true)
    }
    const denied = gate.checkPerIp(req)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  test('different IPs have independent buckets', () => {
    const gate = createOnDemandGate({ perIpRate: 5 / 60, perIpBurst: 1 })
    expect(gate.checkPerIp(fakeRequest('1.1.1.1')).ok).toBe(true)
    expect(gate.checkPerIp(fakeRequest('1.1.1.1')).ok).toBe(false)
    // Second IP gets its own burst.
    expect(gate.checkPerIp(fakeRequest('2.2.2.2')).ok).toBe(true)
  })

  test('negative cache: recorded miss is reported as cached', () => {
    const gate = createOnDemandGate({})
    expect(gate.isNegativelyCached('foo/bar')).toBe(false)
    gate.recordMiss('foo/bar')
    expect(gate.isNegativelyCached('foo/bar')).toBe(true)
  })

  test('negative cache TTL expires entries', async () => {
    const gate = createOnDemandGate({ negativeTtlMs: 50 })
    gate.recordMiss('foo')
    expect(gate.isNegativelyCached('foo')).toBe(true)
    await new Promise(r => setTimeout(r, 80))
    expect(gate.isNegativelyCached('foo')).toBe(false)
  })

  test('negative cache LRU caps size', () => {
    const gate = createOnDemandGate({ negativeLru: 3 })
    gate.recordMiss('a')
    gate.recordMiss('b')
    gate.recordMiss('c')
    gate.recordMiss('d') // evicts 'a' (oldest)
    expect(gate.isNegativelyCached('a')).toBe(false)
    expect(gate.isNegativelyCached('b')).toBe(true)
    expect(gate.isNegativelyCached('c')).toBe(true)
    expect(gate.isNegativelyCached('d')).toBe(true)
  })

  test('withFetchPermit gates concurrency', async () => {
    const gate = createOnDemandGate({
      fetchMaxConcurrent: 2,
      fetchMaxWaiters: 0,
    })
    let resolveA, resolveB
    const a = gate.withFetchPermit(() => new Promise(r => { resolveA = r }))
    const b = gate.withFetchPermit(() => new Promise(r => { resolveB = r }))
    // Both acquired. A third should overflow because maxWaiters=0.
    await expect(gate.withFetchPermit(async () => 'never')).rejects.toBeInstanceOf(BackpressureError)
    resolveA('done-a')
    resolveB('done-b')
    expect(await a).toBe('done-a')
    expect(await b).toBe('done-b')
  })

  test('withFetchPermit queues up to maxWaiters', async () => {
    const gate = createOnDemandGate({
      fetchMaxConcurrent: 1,
      fetchMaxWaiters: 2,
    })
    let resolveFirst
    const first = gate.withFetchPermit(() => new Promise(r => { resolveFirst = r }))
    const second = gate.withFetchPermit(async () => 'b')
    const third = gate.withFetchPermit(async () => 'c')
    // Fourth overflows the queue.
    await expect(gate.withFetchPermit(async () => 'd')).rejects.toBeInstanceOf(BackpressureError)
    resolveFirst('a')
    expect(await first).toBe('a')
    expect(await second).toBe('b')
    expect(await third).toBe('c')
  })
})
