import { describe, test, expect } from 'bun:test'
import { weightedRRF } from '../../../src/search/fusion.js'

describe('weightedRRF', () => {
  test('lexical rank-0 outranks semantic rank-0 (weights favor lexical)', () => {
    const f = weightedRRF([
      { ranked: ['lex'], weight: 1.0 },
      { ranked: ['sem'], weight: 0.6 },
    ])
    expect(f.get('lex')).toBeGreaterThan(f.get('sem'))
  })

  test('a key present in both lists scores above a key in only one', () => {
    const f = weightedRRF([
      { ranked: ['both', 'lexOnly'], weight: 1.0 },
      { ranked: ['both', 'semOnly'], weight: 0.6 },
    ])
    expect(f.get('both')).toBeGreaterThan(f.get('lexOnly'))
    expect(f.get('both')).toBeGreaterThan(f.get('semOnly'))
  })

  test('empty input → empty map', () => {
    expect(weightedRRF([]).size).toBe(0)
  })

  test('honors k', () => {
    expect(weightedRRF([{ ranked: ['x'], weight: 1 }], { k: 0 }).get('x')).toBeCloseTo(1)
  })
})
