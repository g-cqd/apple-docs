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
