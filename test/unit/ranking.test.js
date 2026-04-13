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

  test('R6b: packages are penalized for general queries', () => {
    const doc = makeResult({ matchQuality: 'match', path: 'doc' })
    const pkg = makeResult({
      matchQuality: 'match',
      sourceType: 'packages',
      title: 'apple/swift-argument-parser',
      path: 'packages/apple/swift-argument-parser',
    })
    rerank([doc, pkg], 'argument parser', { type: 'general', confidence: 0.5 })
    expect(doc.score).toBeGreaterThan(pkg.score)
  })

  test('R6b: exact package-name queries still surface packages', () => {
    const doc = makeResult({ matchQuality: 'match', path: 'doc' })
    const pkg = makeResult({
      matchQuality: 'exact',
      sourceType: 'packages',
      title: 'apple/swift-argument-parser',
      path: 'packages/apple/swift-argument-parser',
      urlDepth: 3,
    })
    rerank([doc, pkg], 'apple/swift-argument-parser', { type: 'general', confidence: 0.5 })
    expect(pkg.score).toBeGreaterThan(doc.score)
  })

  test('R7: deep paths are penalized', () => {
    const shallow = makeResult({ matchQuality: 'match', urlDepth: 2 })
    const deep = makeResult({ matchQuality: 'match', urlDepth: 12, path: 'deep/nested/very/long/path/to/item' })
    rerank([shallow, deep], 'View', { type: 'symbol', confidence: 0.7 })
    expect(shallow.score).toBeGreaterThan(deep.score)
  })

  test('R8: preferred sources sort in the requested order when matches are comparable', () => {
    const results = [
      makeResult({ matchQuality: 'match', sourceType: 'wwdc', path: 'other/wwdc' }),
      makeResult({ matchQuality: 'match', sourceType: 'guidelines', path: 'other/guidelines', framework: 'app-store-review' }),
      makeResult({ matchQuality: 'match', sourceType: 'sample-code', path: 'other/sample' }),
      makeResult({ matchQuality: 'match', sourceType: 'hig', path: 'other/hig', framework: 'design' }),
      makeResult({ matchQuality: 'match', sourceType: 'apple-docc', path: 'other/docc' }),
    ]
    rerank(results, 'layout', { type: 'general', confidence: 0.5 })
    expect(results.map(r => r.sourceType)).toEqual([
      'apple-docc',
      'hig',
      'sample-code',
      'guidelines',
      'wwdc',
    ])
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
    // Normal apple-docc gets the preferred-source boost, archived release notes get R4 + R5 penalties.
    expect(normal.score).toBeGreaterThan(archivedReleaseNotes.score * 3)
  })

  test('R9: error intent boosts troubleshooting articles', () => {
    const article = makeResult({ matchQuality: 'match', kind: 'article', path: 'a', title: 'Troubleshooting Core Data' })
    const symbol = makeResult({ matchQuality: 'match', kind: 'structure', path: 'b' })
    rerank([symbol, article], 'core data crash', { type: 'error', confidence: 0.8 })
    expect(article.score).toBeGreaterThan(symbol.score)
  })

  test('R10: concept intent boosts HIG and Swift Book articles', () => {
    const hig = makeResult({ matchQuality: 'match', sourceType: 'hig', path: 'a' })
    const docc = makeResult({ matchQuality: 'match', sourceType: 'apple-docc', path: 'b' })
    rerank([docc, hig], 'what is typography', { type: 'concept', confidence: 0.7 })
    expect(hig.score).toBeGreaterThan(docc.score)
  })

  test('R11: WWDC intent boosts WWDC sessions', () => {
    const wwdc = makeResult({ matchQuality: 'match', sourceType: 'wwdc', path: 'wwdc/2024/10144' })
    const docc = makeResult({ matchQuality: 'match', sourceType: 'apple-docc', path: 'other/swiftui' })
    rerank([docc, wwdc], 'wwdc 2024 swiftui', { type: 'wwdc', confidence: 0.8 })
    expect(wwdc.score).toBeGreaterThan(docc.score)
  })

  test('WWDC intent does not boost non-WWDC sources', () => {
    const docc = makeResult({ matchQuality: 'match', sourceType: 'apple-docc', path: 'a' })
    const hig = makeResult({ matchQuality: 'match', sourceType: 'hig', path: 'b' })
    rerank([docc, hig], 'wwdc 2024', { type: 'wwdc', confidence: 0.8 })
    // apple-docc still beats hig via preferred source multiplier
    expect(docc.score).toBeGreaterThan(hig.score)
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
