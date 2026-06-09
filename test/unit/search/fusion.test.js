import { describe, test, expect } from 'bun:test'
import { weightedRRF, normalizeScores, hybridFusion, mmrSelect } from '../../../src/search/fusion.js'

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

describe('normalizeScores', () => {
  test('min-max maps to [0,1]', () => {
    const n = normalizeScores(new Map([['a', 10], ['b', 20], ['c', 30]]))
    expect(n.get('a')).toBeCloseTo(0)
    expect(n.get('b')).toBeCloseTo(0.5)
    expect(n.get('c')).toBeCloseTo(1)
  })

  test('all-equal (degenerate range) → all 0, no false signal', () => {
    const n = normalizeScores(new Map([['a', 5], ['b', 5]]))
    expect(n.get('a')).toBe(0)
    expect(n.get('b')).toBe(0)
  })

  test('empty → empty', () => {
    expect(normalizeScores(new Map()).size).toBe(0)
  })
})

describe('hybridFusion', () => {
  test('with no scores it degrades to rank-only (lexical stays on top)', () => {
    const f = hybridFusion([
      { ranked: ['lex'], weight: 1.0 },
      { ranked: ['sem'], weight: 0.6 },
    ])
    expect(f.get('lex')).toBeGreaterThan(f.get('sem'))
  })

  test('exact lexical match (normScore 1.0) outranks a top semantic-only hit', () => {
    const f = hybridFusion([
      { ranked: ['exact', 'weakLex'], weight: 1.0, scores: new Map([['exact', 300], ['weakLex', 10]]) },
      { ranked: ['semTop', 'exact'], weight: 0.6, scores: new Map([['semTop', 0.99], ['exact', 0.2]]) },
    ], { beta: 0.5 })
    expect(f.get('exact')).toBeGreaterThan(f.get('semTop'))
  })

  test('score magnitude lifts a strong semantic hit above a weak one at the same rank', () => {
    const strong = hybridFusion([
      { ranked: ['s'], weight: 0.6, scores: new Map([['s', 1], ['other', 0]]) },
    ], { beta: 1 }).get('s')
    const weak = hybridFusion([
      { ranked: ['s'], weight: 0.6, scores: new Map([['s', 0], ['other', 1]]) },
    ], { beta: 1 }).get('s')
    expect(strong).toBeGreaterThan(weak)
  })
})

describe('mmrSelect', () => {
  const sim = (a, b) => (a === b ? 1 : 0) // identical tag ⇒ duplicate
  const vecOf = (item) => item.vec

  test('keeps the top item first and demotes a near-duplicate of it', () => {
    const ranked = [
      { key: 'top', vec: 'A' },
      { key: 'dupOfTop', vec: 'A' },
      { key: 'diverse', vec: 'B' },
    ]
    const out = mmrSelect(ranked, vecOf, sim, { lambda: 0.7 })
    expect(out[0].key).toBe('top')
    expect(out[1].key).toBe('diverse') // the duplicate is pushed below the diverse item
    expect(out[2].key).toBe('dupOfTop')
  })

  test('items with no vector are never demoted for redundancy', () => {
    const ranked = [
      { key: 'top', vec: 'A' },
      { key: 'noVec', vec: null },
      { key: 'dupOfTop', vec: 'A' },
    ]
    const out = mmrSelect(ranked, vecOf, sim, { lambda: 0.7 })
    expect(out.map(x => x.key)).toEqual(['top', 'noVec', 'dupOfTop'])
  })

  test('≤2 items returned as-is', () => {
    const ranked = [{ key: 'a', vec: 'A' }, { key: 'b', vec: 'A' }]
    expect(mmrSelect(ranked, vecOf, sim).map(x => x.key)).toEqual(['a', 'b'])
  })
})
