import { describe, expect, test } from 'bun:test'
import { l2normalize, lastTokenPool, meanPool, truncate } from '../../../src/search/pooling.js'

describe('meanPool', () => {
  test('averages all tokens when unmasked', () => {
    // 2 tokens × 2 dims: [[1,2],[3,4]] → [2,3]
    const out = meanPool(new Float32Array([1, 2, 3, 4]), 2)
    expect(Array.from(out)).toEqual([2, 3])
  })

  test('honors the attention mask (ignores padding tokens)', () => {
    // 3 tokens, last is padding → mean of first two only
    const out = meanPool(new Float32Array([1, 1, 3, 3, 99, 99]), 2, [1, 1, 0])
    expect(Array.from(out)).toEqual([2, 2])
  })

  test('all-masked → zeros (no div-by-zero)', () => {
    expect(Array.from(meanPool(new Float32Array([1, 2, 3, 4]), 2, [0, 0]))).toEqual([0, 0])
  })
})

describe('lastTokenPool', () => {
  test('picks the final token when unmasked', () => {
    expect(Array.from(lastTokenPool(new Float32Array([1, 2, 3, 4]), 2))).toEqual([3, 4])
  })

  test('picks the last real token under a right-padding mask', () => {
    // tokens: a, b, pad → last real is b
    const out = lastTokenPool(new Float32Array([1, 1, 5, 6, 0, 0]), 2, [1, 1, 0])
    expect(Array.from(out)).toEqual([5, 6])
  })
})

describe('l2normalize', () => {
  test('produces a unit vector', () => {
    const out = l2normalize(new Float32Array([3, 4]))
    expect(out[0]).toBeCloseTo(0.6)
    expect(out[1]).toBeCloseTo(0.8)
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1)
  })

  test('zero vector passes through without NaN', () => {
    expect(Array.from(l2normalize(new Float32Array([0, 0])))).toEqual([0, 0])
  })
})

describe('truncate', () => {
  test('keeps the leading dims (Matryoshka)', () => {
    expect(Array.from(truncate(new Float32Array([1, 2, 3, 4]), 2))).toEqual([1, 2])
  })

  test('no-op when dims >= length', () => {
    expect(Array.from(truncate(new Float32Array([1, 2]), 4))).toEqual([1, 2])
  })

  test('truncate then normalize yields a unit vector at the smaller dim', () => {
    const v = truncate(new Float32Array([3, 4, 100, 100]), 2)
    const n = l2normalize(v)
    expect(Math.hypot(...n)).toBeCloseTo(1)
  })
})
