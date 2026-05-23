import { describe, expect, test } from 'bun:test'
import { publicConfidence } from '../../../src/output/confidence.js'

describe('publicConfidence', () => {
  test('exact matchQuality maps to exact', () => {
    expect(publicConfidence('exact')).toBe('exact')
  })

  test('fuzzy matchQuality maps to approximate', () => {
    expect(publicConfidence('fuzzy')).toBe('approximate')
  })

  test('every relaxed* matchQuality maps to approximate', () => {
    expect(publicConfidence('relaxed')).toBe('approximate')
    expect(publicConfidence('relaxed-or')).toBe('approximate')
    expect(publicConfidence('relaxed-token')).toBe('approximate')
  })

  test.each([
    'prefix',
    'contains',
    'match',
    'substring',
    'body',
  ])('non-exact strict tier %s maps to partial', (quality) => {
    expect(publicConfidence(quality)).toBe('partial')
  })

  test('unknown values fall through to partial', () => {
    expect(publicConfidence('something-new')).toBe('partial')
    expect(publicConfidence(undefined)).toBe('partial')
    expect(publicConfidence(null)).toBe('partial')
    expect(publicConfidence(42)).toBe('partial')
  })

  test('only the literal prefix "relaxed" qualifies', () => {
    // Defensive against false positives — must START with "relaxed".
    expect(publicConfidence('un-relaxed')).toBe('partial')
  })
})
