import { describe, expect, test } from 'bun:test'
import { createLru } from '../../src/lib/lru.js'

describe('createLru', () => {
  test('returns undefined for cache misses', () => {
    const cache = createLru({ max: 2 })
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('stores and retrieves values', () => {
    const cache = createLru({ max: 2 })
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    expect(cache.size).toBe(1)
  })

  test('evicts the least recently used entry', () => {
    const cache = createLru({ max: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)

    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
  })

  test('does not retain entries when max is zero', () => {
    const cache = createLru({ max: 0 })
    cache.set('a', 1)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('clear removes all retained entries', () => {
    const cache = createLru({ max: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.size).toBe(0)
  })
})

describe('createLru (A20: byte cap)', () => {
  test('evicts entries when total bytes exceed maxBytes', () => {
    const cache = createLru({ max: 100, maxBytes: 50 })
    cache.set('a', 'x'.repeat(20))
    cache.set('b', 'y'.repeat(20))
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBe(40)
    cache.set('c', 'z'.repeat(20))
    // 60 bytes > 50 cap, oldest 'a' evicted
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('y'.repeat(20))
    expect(cache.get('c')).toBe('z'.repeat(20))
    expect(cache.bytes).toBe(40)
  })

  test('replacing a key updates the running byte total', () => {
    const cache = createLru({ max: 10, maxBytes: 100 })
    cache.set('k', 'small')
    expect(cache.bytes).toBe(5)
    cache.set('k', 'a-much-longer-value')
    expect(cache.bytes).toBe(19)
  })

  test('count cap still enforced when maxBytes is unset', () => {
    const cache = createLru({ max: 2 })
    cache.set('a', 'aaaaaaaaaaaaaaaaaaaaaaaa')
    cache.set('b', 'b')
    cache.set('c', 'c')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.bytes).toBe(0) // not tracking when maxBytes is unset
  })

  test('non-stringifiable values fall through to size 0', () => {
    const cache = createLru({ max: 5, maxBytes: 100 })
    const circular = {}
    circular.self = circular
    cache.set('k', circular)
    expect(cache.size).toBe(1)
    // Default sizeFn catches the throw and returns 0
    expect(cache.bytes).toBe(0)
  })
})
