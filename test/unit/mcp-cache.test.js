import { describe, expect, test } from 'bun:test'
import { cacheKey, createCacheRegistry, stableJson } from '../../src/mcp/cache.js'

describe('stableJson', () => {
  test('sorts object keys recursively', () => {
    const a = { b: 1, a: { y: 2, x: 1 } }
    const b = { a: { x: 1, y: 2 }, b: 1 }
    expect(stableJson(a)).toBe(stableJson(b))
  })

  test('distinguishes strings by casing and whitespace', () => {
    expect(stableJson({ q: 'View' })).not.toBe(stableJson({ q: 'view' }))
    expect(stableJson({ q: 'View' })).not.toBe(stableJson({ q: ' View' }))
  })

  test('handles arrays and primitives', () => {
    expect(stableJson([3, 2, 1])).toBe('[3,2,1]')
    expect(stableJson(null)).toBe('null')
    expect(stableJson(42)).toBe('42')
  })
})

describe('cacheKey', () => {
  test('argument order does not affect the key', () => {
    const k1 = cacheKey('search_docs', { b: 1, a: 2 }, 's1')
    const k2 = cacheKey('search_docs', { a: 2, b: 1 }, 's1')
    expect(k1).toBe(k2)
  })

  test('different tools produce different keys for same args', () => {
    const k1 = cacheKey('search_docs', { q: 'x' }, 's1')
    const k2 = cacheKey('read_doc', { q: 'x' }, 's1')
    expect(k1).not.toBe(k2)
  })

  test('stamp rotation changes the key', () => {
    const k1 = cacheKey('search_docs', { q: 'x' }, 's1')
    const k2 = cacheKey('search_docs', { q: 'x' }, 's2')
    expect(k1).not.toBe(k2)
  })
})

describe('createCacheRegistry', () => {
  function fakeCtx(schemaVersion = 7) {
    return {
      dataDir: '/tmp/does-not-exist',
      db: { getSchemaVersion: () => schemaVersion },
    }
  }

  test('caches identical calls per tool', async () => {
    const registry = createCacheRegistry(fakeCtx())
    let calls = 0
    const handler = registry.wrap('search_docs', async () => {
      calls++
      return { value: 'payload' }
    })
    await handler({ q: 'View' })
    await handler({ q: 'View' })
    expect(calls).toBe(1)
  })

  test('different args miss the cache', async () => {
    const registry = createCacheRegistry(fakeCtx())
    let calls = 0
    const handler = registry.wrap('search_docs', async () => {
      calls++
      return { value: 'payload' }
    })
    await handler({ q: 'View' })
    await handler({ q: 'view' })
    expect(calls).toBe(2)
  })

  test('invalidate clears all caches', async () => {
    const registry = createCacheRegistry(fakeCtx())
    let calls = 0
    const handler = registry.wrap('read_doc', async () => {
      calls++
      return {}
    })
    await handler({ path: 'x' })
    registry.invalidate()
    await handler({ path: 'x' })
    expect(calls).toBe(2)
  })

  test('unknown tool names bypass the cache (passthrough)', async () => {
    const registry = createCacheRegistry(fakeCtx())
    let calls = 0
    const handler = registry.wrap('unknown_tool', async () => {
      calls++
      return {}
    })
    await handler({})
    await handler({})
    expect(calls).toBe(2) // passthrough — no cache
  })

  test('disabled registry bypasses the cache', async () => {
    const registry = createCacheRegistry(fakeCtx(), { enabled: false })
    let calls = 0
    const handler = registry.wrap('search_docs', async () => {
      calls++
      return {}
    })
    await handler({ q: 'View' })
    await handler({ q: 'View' })
    expect(calls).toBe(2)
  })

  test('stats() reports per-tool hits, misses, size and aggregate hit ratio', async () => {
    const registry = createCacheRegistry(fakeCtx())
    const handler = registry.wrap('search_docs', async (args) => args)
    await handler({ q: 'a' }) // miss
    await handler({ q: 'a' }) // hit
    await handler({ q: 'b' }) // miss
    await handler({ q: 'a' }) // hit
    const stats = registry.stats()
    expect(stats.enabled).toBe(true)
    expect(stats.tools.search_docs.hits).toBe(2)
    expect(stats.tools.search_docs.misses).toBe(2)
    expect(stats.tools.search_docs.size).toBe(2)
    expect(stats.tools.search_docs.capacity).toBe(100)
    expect(stats.totalHits).toBe(2)
    expect(stats.totalMisses).toBe(2)
    expect(stats.hitRatio).toBe(0.5)
  })

  test('invalidate() resets hit/miss counters alongside entries', async () => {
    const registry = createCacheRegistry(fakeCtx())
    const handler = registry.wrap('search_docs', async (args) => args)
    await handler({ q: 'a' })
    await handler({ q: 'a' })
    registry.invalidate()
    const stats = registry.stats()
    expect(stats.totalHits).toBe(0)
    expect(stats.totalMisses).toBe(0)
    expect(stats.tools.search_docs.size).toBe(0)
  })

  test('LRU evicts oldest entry at capacity', async () => {
    const registry = createCacheRegistry(fakeCtx(), { sizes: { search_docs: 2 } })
    let calls = 0
    const handler = registry.wrap('search_docs', async (args) => {
      calls++
      return args
    })
    await handler({ q: 'a' })
    await handler({ q: 'b' })
    await handler({ q: 'c' }) // evicts 'a'
    await handler({ q: 'a' }) // miss
    expect(calls).toBe(4)
    await handler({ q: 'c' }) // still in cache
    expect(calls).toBe(4)
  })
})
