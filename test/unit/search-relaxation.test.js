import { describe, expect, test } from 'bun:test'
import {
  SEARCH_STOPWORDS,
  pickHighSignalToken,
  pruneStopwords,
  tokenize,
} from '../../src/search/relaxation.js'

describe('tokenize', () => {
  test('splits a natural-language query on punctuation', () => {
    expect(tokenize('how do I use NavigationStack?')).toEqual([
      'how', 'do', 'I', 'use', 'NavigationStack',
    ])
  })

  test('drops empty tokens and single-digit noise', () => {
    expect(tokenize('  foo ,  bar  2 42 ')).toEqual(['foo', 'bar', '42'])
  })

  test('preserves dotted identifiers as a single token', () => {
    expect(tokenize('URLSession.shared')).toEqual(['URLSession.shared'])
  })

  test('returns empty for blank input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize(null)).toEqual([])
  })
})

describe('pruneStopwords', () => {
  test('drops filler words from a natural-language query', () => {
    expect(pruneStopwords(['how', 'do', 'I', 'use', 'NavigationStack'])).toEqual([
      'NavigationStack',
    ])
  })

  test('keeps CamelCase tokens even when their lowercased form matches a stopword', () => {
    // "WHERE" is not CamelCase but e.g. an imaginary CamelCase token that
    // lowercases to a stopword should still be kept.
    const input = ['How', 'Which', 'SomeToSome', 'MyView']
    const result = pruneStopwords(input)
    expect(result).toContain('SomeToSome')
    expect(result).toContain('MyView')
  })

  test('returns an empty array when every token is a stopword', () => {
    expect(pruneStopwords(['how', 'the', 'is'])).toEqual([])
  })

  test('is case-insensitive for stopword membership', () => {
    expect(pruneStopwords(['HOW', 'To', 'sheet'])).toEqual(['sheet'])
  })

  test('handles non-array input defensively', () => {
    expect(pruneStopwords(null)).toEqual([])
    expect(pruneStopwords(undefined)).toEqual([])
  })
})

describe('pickHighSignalToken', () => {
  test('returns the first CamelCase token when present', () => {
    expect(pickHighSignalToken(['foo', 'NavigationStack', 'bar'])).toBe('NavigationStack')
  })

  test('falls back to the longest token of length >= 4', () => {
    expect(pickHighSignalToken(['navigation', 'stack', 'foo'])).toBe('navigation')
  })

  test('returns null when no token meets the length threshold', () => {
    expect(pickHighSignalToken(['a', 'b', 'ab'])).toBeNull()
  })

  test('returns null for empty or missing input', () => {
    expect(pickHighSignalToken([])).toBeNull()
    expect(pickHighSignalToken(null)).toBeNull()
  })
})

describe('SEARCH_STOPWORDS', () => {
  test('includes common English filler words', () => {
    for (const word of ['the', 'is', 'how', 'to', 'what', 'why', 'with']) {
      expect(SEARCH_STOPWORDS.has(word)).toBe(true)
    }
  })

  test('does not include identifiers or domain terms', () => {
    for (const word of ['swift', 'view', 'actor', 'async']) {
      expect(SEARCH_STOPWORDS.has(word)).toBe(false)
    }
  })
})
