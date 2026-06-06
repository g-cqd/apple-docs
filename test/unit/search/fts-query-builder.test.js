import { describe, test, expect } from 'bun:test'
import { buildFtsQuery, sanitizeTrigramQuery } from '../../../src/search/fts-query-builder.js'

describe('buildFtsQuery', () => {
  test('single plain word → prefix term', () => {
    expect(buildFtsQuery('View')).toBe('"view"*')
  })

  test('CamelCase word → OR of whole-word prefix + exact sub-words', () => {
    expect(buildFtsQuery('NavigationStack')).toBe('("navigationstack"* OR "navigation" OR "stack")')
  })

  test('multiple words AND their groups (each a prefix)', () => {
    expect(buildFtsQuery('async await')).toBe('"async"* "await"*')
  })

  test('hyphens are NOT separators (in-app / SE-0296 stay intact)', () => {
    expect(buildFtsQuery('in-app')).toBe('"in-app"*')
    expect(buildFtsQuery('SE-0296')).toBe('"se-0296"*')
  })

  test('escape hatch: AND/OR/NOT and quotes pass through verbatim', () => {
    expect(buildFtsQuery('foo AND bar')).toBe('foo AND bar')
    expect(buildFtsQuery('"already quoted"')).toBe('"already quoted"')
  })

  test('empty / separator-only input yields an empty FTS query', () => {
    expect(buildFtsQuery('')).toBe('""')
    expect(buildFtsQuery('   ')).toBe('""')
    expect(buildFtsQuery('...')).toBe('""')
  })

  describe('dotted / qualified identifiers (the AVAudioSession… bug)', () => {
    const q = 'AVAudioSessionRouteSelection.AVAudioSessionRouteSelectionExternal'
    const built = buildFtsQuery(q)

    test('produces an OR group, not a hard AND of unmatchable phrases', () => {
      expect(built.startsWith('(')).toBe(true)
      expect(built).toContain(' OR ')
    })

    test('includes the first segment as a prefix (matches the concatenated title token)', () => {
      expect(built).toContain('"avaudiosessionrouteselection"*')
    })

    test('includes the most-specific last segment as a prefix', () => {
      expect(built).toContain('"avaudiosessionrouteselectionexternal"*')
    })

    test('never emits a token containing the raw "." separator', () => {
      expect(built).not.toContain('.')
    })
  })
})

describe('sanitizeTrigramQuery', () => {
  test('clean alphanumeric/space queries pass through as barewords', () => {
    expect(sanitizeTrigramQuery('view')).toBe('view')
    expect(sanitizeTrigramQuery('NavigationStack')).toBe('NavigationStack')
    expect(sanitizeTrigramQuery('navigation stack')).toBe('navigation stack')
  })

  test('special-char queries are wrapped as a literal quoted phrase', () => {
    expect(sanitizeTrigramQuery('A.B.C')).toBe('"A.B.C"')
    expect(sanitizeTrigramQuery('foo(bar)')).toBe('"foo(bar)"')
  })

  test('embedded double-quotes are escaped by doubling', () => {
    expect(sanitizeTrigramQuery('he said "hi"')).toBe('"he said ""hi"""')
  })

  test('empty input yields an empty phrase', () => {
    expect(sanitizeTrigramQuery('')).toBe('""')
    expect(sanitizeTrigramQuery('   ')).toBe('""')
  })
})
