import { describe, test, expect } from 'bun:test'
import { rerank } from '../../src/search/ranking.js'

function makeResult(overrides = {}) {
  return {
    title: 'View',
    path: 'documentation/swiftui/view',
    matchQuality: 'match',
    sourceType: 'apple-docc',
    kind: 'Structure',
    docKind: 'symbol',
    urlDepth: 2,
    isReleaseNotes: false,
    language: 'swift',
    ...overrides,
  }
}

describe('rerank', () => {
  test('assigns base scores from match quality tiers', () => {
    const results = [
      makeResult({ matchQuality: 'exact' }),
      makeResult({ matchQuality: 'body', path: 'other/path' }),
    ]
    rerank(results, 'View', { type: 'symbol', confidence: 0.7 })
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  test('R1: exact title match gets 3x boost', () => {
    const results = [
      makeResult({ title: 'View', matchQuality: 'match' }),
      makeResult({ title: 'ViewModifier', matchQuality: 'match', path: 'documentation/swiftui/viewmodifier' }),
    ]
    rerank(results, 'View', { type: 'symbol', confidence: 0.7 })
    expect(results[0].title).toBe('View')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  test('R2: symbol kind boost when intent is symbol', () => {
    const symbol = makeResult({ kind: 'Protocol', matchQuality: 'match' })
    const article = makeResult({ kind: 'article', matchQuality: 'match', path: 'other' })
    rerank([symbol, article], 'View', { type: 'symbol', confidence: 0.9 })
    expect(symbol.score).toBeGreaterThan(article.score)
  })

  test('R3: guide boost when intent is howto', () => {
    const article = makeResult({ kind: 'article', sourceType: 'hig', matchQuality: 'match' })
    const symbol = makeResult({ kind: 'Structure', matchQuality: 'match', path: 'other' })
    rerank([symbol, article], 'how to layout', { type: 'howto', confidence: 0.8 })
    expect(article.score).toBeGreaterThan(symbol.score)
  })

  test('R4: release notes are penalized', () => {
    const normal = makeResult({ matchQuality: 'match' })
    const releaseNotes = makeResult({
      matchQuality: 'match',
      isReleaseNotes: true,
      path: 'documentation/swiftui/release-notes/ios17',
      title: 'SwiftUI Release Notes',
    })
    rerank([normal, releaseNotes], 'SwiftUI', { type: 'general', confidence: 0.5 })
    expect(normal.score).toBeGreaterThan(releaseNotes.score)
  })

  test('R5: archived content is penalized', () => {
    const fresh = makeResult({ matchQuality: 'match' })
    const archived = makeResult({ matchQuality: 'match', sourceType: 'apple-archive', path: 'other' })
    rerank([fresh, archived], 'memory', { type: 'general', confidence: 0.5 })
    expect(fresh.score).toBeGreaterThan(archived.score)
  })

  test('R6: sample code boosted for howto intent', () => {
    const sample = makeResult({ matchQuality: 'match', sourceType: 'sample-code', kind: 'sample-project', path: 'sample' })
    const doc = makeResult({ matchQuality: 'match', path: 'doc' })
    rerank([doc, sample], 'how to build app', { type: 'howto', confidence: 0.8 })
    expect(sample.score).toBeGreaterThan(doc.score)
  })

  test('R7: deep paths are penalized', () => {
    const shallow = makeResult({ matchQuality: 'match', urlDepth: 2 })
    const deep = makeResult({ matchQuality: 'match', urlDepth: 12, path: 'deep/nested/very/long/path/to/item' })
    rerank([shallow, deep], 'View', { type: 'symbol', confidence: 0.7 })
    expect(shallow.score).toBeGreaterThan(deep.score)
  })

  test('R8: fresh sources get a boost', () => {
    const fresh = makeResult({ matchQuality: 'match', sourceType: 'apple-docc' })
    const wwdc = makeResult({ matchQuality: 'match', sourceType: 'wwdc', path: 'other' })
    rerank([fresh, wwdc], 'View', { type: 'symbol', confidence: 0.7 })
    expect(fresh.score).toBeGreaterThan(wwdc.score)
  })

  test('combined: release notes of archived content get both penalties', () => {
    const normal = makeResult({ matchQuality: 'match' })
    const archivedReleaseNotes = makeResult({
      matchQuality: 'match',
      sourceType: 'apple-archive',
      isReleaseNotes: true,
      path: 'archive/release-notes',
    })
    rerank([normal, archivedReleaseNotes], 'SwiftUI', { type: 'general', confidence: 0.5 })
    // Normal apple-docc gets R8 boost (×1.1), archived release notes get R4 (×0.4) + R5 (×0.6)
    expect(normal.score).toBeGreaterThan(archivedReleaseNotes.score * 3)
  })

  test('sorts results by score descending', () => {
    const results = [
      makeResult({ matchQuality: 'body', path: 'a' }),
      makeResult({ matchQuality: 'exact', path: 'b' }),
      makeResult({ matchQuality: 'match', path: 'c' }),
    ]
    rerank(results, 'View', { type: 'symbol', confidence: 0.7 })
    expect(results[0].path).toBe('b') // exact has highest base score
  })
})
