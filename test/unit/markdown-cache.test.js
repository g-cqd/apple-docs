import { describe, expect, test } from 'bun:test'
import { createMarkdownCache } from '../../src/mcp/markdown-cache.js'

function stubStamper(initial = 's1') {
  let value = initial
  return {
    get: () => value,
    refresh: () => { value = `${value}!` },
    rotate(next) { value = next },
  }
}

describe('createMarkdownCache', () => {
  test('returns undefined on miss', () => {
    const cache = createMarkdownCache({}, { stamper: stubStamper() })
    expect(cache.get('swiftui/view')).toBeUndefined()
    expect(cache.stats()).toEqual({ size: 0, capacity: 512, hits: 0, misses: 1, evictions: 0, hitRatio: 0 })
  })

  test('stores and retrieves a full payload, keyed only by path', () => {
    const cache = createMarkdownCache({}, { stamper: stubStamper() })
    cache.set('swiftui/view', { content: '# View', sections: [{ heading: 'Overview' }], fallback: true })
    const hit = cache.get('swiftui/view')
    expect(hit.content).toBe('# View')
    expect(hit.sections).toEqual([{ heading: 'Overview' }])
    expect(hit.fallback).toBe(true)
  })

  test('invalidates entries whose stamp no longer matches', () => {
    const stamper = stubStamper('s1')
    const cache = createMarkdownCache({}, { stamper })
    cache.set('swiftui/view', { content: 'before', sections: [], fallback: false })
    stamper.rotate('s2') // simulate `apple-docs update`
    expect(cache.get('swiftui/view')).toBeUndefined()
    expect(cache.stats().size).toBe(0)
  })

  test('LRU evicts oldest entry past capacity', () => {
    const cache = createMarkdownCache({}, { capacity: 2, stamper: stubStamper() })
    cache.set('a', { content: 'A' })
    cache.set('b', { content: 'B' })
    cache.set('c', { content: 'C' }) // evicts 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b').content).toBe('B')
    expect(cache.get('c').content).toBe('C')
    expect(cache.stats().evictions).toBe(1)
  })

  test('accessing an entry promotes it to MRU', () => {
    const cache = createMarkdownCache({}, { capacity: 2, stamper: stubStamper() })
    cache.set('a', { content: 'A' })
    cache.set('b', { content: 'B' })
    // Touch 'a' — makes 'b' the LRU.
    expect(cache.get('a').content).toBe('A')
    cache.set('c', { content: 'C' }) // should evict 'b', not 'a'
    expect(cache.get('a').content).toBe('A')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c').content).toBe('C')
  })

  test('invalidate() clears entries and resets counters', () => {
    const cache = createMarkdownCache({}, { stamper: stubStamper() })
    cache.set('x', { content: 'X' })
    cache.get('x')
    cache.get('missing')
    cache.invalidate()
    expect(cache.stats()).toEqual({ size: 0, capacity: 512, hits: 0, misses: 0, evictions: 0, hitRatio: 0 })
  })

  test('hitRatio reflects observed traffic', () => {
    const cache = createMarkdownCache({}, { stamper: stubStamper() })
    cache.set('a', { content: 'A' })
    cache.get('a') // hit
    cache.get('a') // hit
    cache.get('b') // miss
    expect(cache.stats().hitRatio).toBeCloseTo(2 / 3, 5)
  })
})
