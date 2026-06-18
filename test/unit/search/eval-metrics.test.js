import { describe, expect, test } from 'bun:test'
import { mean, mrr, ndcgAtK, recallAtK } from '../../../src/search/eval-metrics.js'

describe('recallAtK', () => {
  test('all relevant found within k → 1', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'b'], 10)).toBe(1)
  })

  test('partial recall is the found fraction', () => {
    expect(recallAtK(['a', 'x', 'y'], ['a', 'b'], 10)).toBe(0.5)
  })

  test('honors k — a relevant hit past k does not count', () => {
    expect(recallAtK(['x', 'x', 'a'], ['a'], 2)).toBe(0)
    expect(recallAtK(['x', 'x', 'a'], ['a'], 3)).toBe(1)
  })

  test('no relevant set → 0', () => {
    expect(recallAtK(['a'], [], 10)).toBe(0)
  })

  test('accepts a Set for relevant', () => {
    expect(recallAtK(['a', 'b'], new Set(['b']), 10)).toBe(1)
  })
})

describe('ndcgAtK', () => {
  test('perfect ranking → 1', () => {
    expect(ndcgAtK(['a', 'b'], ['a', 'b'], 10)).toBeCloseTo(1)
  })

  test('rank position matters — relevant lower scores < relevant on top', () => {
    const top = ndcgAtK(['a', 'x'], ['a'], 10)
    const low = ndcgAtK(['x', 'a'], ['a'], 10)
    expect(top).toBeGreaterThan(low)
    expect(top).toBeCloseTo(1)
  })

  test('single relevant at rank 2 → 1/log2(3) normalized by ideal 1', () => {
    expect(ndcgAtK(['x', 'a'], ['a'], 10)).toBeCloseTo(1 / Math.log2(3))
  })

  test('empty relevant → 0', () => {
    expect(ndcgAtK(['a'], [], 10)).toBe(0)
  })
})

describe('mrr', () => {
  test('first relevant at rank 1 → 1', () => {
    expect(mrr(['a', 'b'], ['a'])).toBe(1)
  })

  test('first relevant at rank 3 → 1/3', () => {
    expect(mrr(['x', 'y', 'a'], ['a'])).toBeCloseTo(1 / 3)
  })

  test('no relevant retrieved → 0', () => {
    expect(mrr(['x', 'y'], ['a'])).toBe(0)
  })
})

describe('mean', () => {
  test('averages and handles empty', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([])).toBe(0)
  })
})
