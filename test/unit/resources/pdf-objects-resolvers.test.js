import { describe, test, expect } from 'bun:test'
import { resolveDict, resolveStreamObject } from '../../../src/resources/symbol-pdf-to-svg/pdf-objects.js'

/**
 * Counter-audit regression suite for the post-CodeQL rewrite of
 * resolveDict / resolveStreamObject. The pre-fix code had a redundant
 * `value !== null` check inside a branch that was only reachable when
 * value was already non-null, and used `typeof value === 'object'`
 * without a `value != null` guard first (so `null` would slip through
 * the type-check on the second variant). The rewrite collapses both
 * to `if (value == null || typeof value !== 'object') return null`.
 */
describe('resolveDict', () => {
  test('returns null for null / undefined / non-object inputs', () => {
    expect(resolveDict(null, new Map())).toBeNull()
    expect(resolveDict(undefined, new Map())).toBeNull()
    expect(resolveDict('a string', new Map())).toBeNull()
    expect(resolveDict(42, new Map())).toBeNull()
    expect(resolveDict(true, new Map())).toBeNull()
  })

  test('follows ref to the referenced object dict', () => {
    const objects = new Map([
      [42, { dict: { Type: '/Page' } }],
    ])
    expect(resolveDict({ ref: 42 }, objects)).toEqual({ Type: '/Page' })
  })

  test('returns null when the ref target is missing', () => {
    const objects = new Map()
    expect(resolveDict({ ref: 99 }, objects)).toBeNull()
  })

  test('returns the value verbatim when it is an inline dict', () => {
    const inline = { Type: '/Catalog' }
    expect(resolveDict(inline, new Map())).toBe(inline)
  })
})

describe('resolveStreamObject', () => {
  test('returns null for null / undefined / non-object inputs', () => {
    expect(resolveStreamObject(null, new Map())).toBeNull()
    expect(resolveStreamObject(undefined, new Map())).toBeNull()
    expect(resolveStreamObject('s', new Map())).toBeNull()
    expect(resolveStreamObject(7, new Map())).toBeNull()
  })

  test('returns null for an object without a ref (streams must be referenced)', () => {
    expect(resolveStreamObject({ Length: 100 }, new Map())).toBeNull()
  })

  test('returns the referenced object', () => {
    const obj = { dict: { Length: 100 }, stream: new Uint8Array([1, 2, 3]) }
    const objects = new Map([[7, obj]])
    expect(resolveStreamObject({ ref: 7 }, objects)).toBe(obj)
  })

  test('returns null when the ref is unresolved', () => {
    expect(resolveStreamObject({ ref: 12345 }, new Map())).toBeNull()
  })
})
