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
})
