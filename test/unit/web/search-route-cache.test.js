import { describe, expect, test } from 'bun:test'
import { searchResponseCacheKey } from '../../../src/web/routes/search.route.js'

// The /api/search response cache is keyed by (search opts, corpus stamp). These
// guard the cache-coherency invariants the route relies on: a corpus re-sync
// bumps the stamp and must invalidate every cached response, while logically
// equal opts must collide regardless of key order.
describe('searchResponseCacheKey', () => {
  const opts = { query: 'navigationstack', limit: 25, fast: false }

  test('is deterministic for the same opts + stamp', () => {
    expect(searchResponseCacheKey(opts, 'stamp-1')).toBe(searchResponseCacheKey(opts, 'stamp-1'))
  })

  test('a changed corpus stamp invalidates the key (no stale serve after re-sync)', () => {
    expect(searchResponseCacheKey(opts, 'stamp-1')).not.toBe(searchResponseCacheKey(opts, 'stamp-2'))
  })

  test('different opts produce different keys under the same stamp', () => {
    expect(searchResponseCacheKey({ query: 'a' }, 'stamp-1')).not.toBe(searchResponseCacheKey({ query: 'b' }, 'stamp-1'))
  })

  test('key-insertion order does not change the key (stableJson)', () => {
    const a = searchResponseCacheKey({ query: 'x', limit: 10, fast: true }, 'stamp-1')
    const b = searchResponseCacheKey({ fast: true, query: 'x', limit: 10 }, 'stamp-1')
    expect(a).toBe(b)
  })
})
