import { describe, expect, test } from 'bun:test'
import { safeJson } from '../../src/content/safe-json.js'

describe('safeJson', () => {
  test('memoizes parsed JSON by input string', () => {
    const first = safeJson('{"items":[{"name":"View"}]}')
    const second = safeJson('{"items":[{"name":"View"}]}')

    expect(first).toBe(second)
    expect(first.items).toBe(second.items)
  })

  test('deep-freezes parsed arrays and objects', () => {
    const parsed = safeJson('{"items":[{"name":"View"}]}')

    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.items)).toBe(true)
    expect(Object.isFrozen(parsed.items[0])).toBe(true)
  })

  test('returns null for invalid JSON', () => {
    expect(safeJson('{')).toBeNull()
  })

  test('handles deeply nested arrays without stack overflow (A28)', () => {
    // 60 deep — under the 64 cap, well past the recursive-implementation
    // comfort zone on Bun.
    let json = 'null'
    for (let i = 0; i < 60; i++) json = `[${json}]`
    const parsed = safeJson(json)
    // Walk to confirm the structure survived intact.
    let cursor = parsed
    for (let i = 0; i < 60; i++) {
      expect(Object.isFrozen(cursor)).toBe(true)
      expect(Array.isArray(cursor)).toBe(true)
      cursor = cursor[0]
    }
    expect(cursor).toBeNull()
  })

  test('rejects pathological depth (>64) with null (caught ParseError)', () => {
    // safeJson catches inner errors and returns null — the LRU memoization
    // means subsequent calls with the same string are also null.
    let json = 'null'
    for (let i = 0; i < 200; i++) json = `[${json}]`
    expect(safeJson(json)).toBeNull()
  })
})
