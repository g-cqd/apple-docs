import { describe, expect, test } from 'bun:test'
import { search } from '../../src/commands/search.js'
import { fuzzyMatchTitles } from '../../src/lib/fuzzy.js'

function makeCtx(calls) {
  const db = {
    resolveRoot: () => null,
    getFrameworkSynonyms: () => [],
    getBodyIndexCount: () => 1,
    searchPages: (_ftsQuery, _rawQuery, opts) => {
      calls.push(opts)
      return []
    },
    searchTrigram: () => [],
    searchBody: () => [],
    getAllTitlesForFuzzy: () => [],
    getSearchRecordById: () => null,
    hasTable: () => false,
    getTier: () => 'standard',
    getDocumentSnippetData: () => new Map(),
    getRelatedDocCounts: () => new Map(),
  }
  // Mirror DocsDatabase.fuzzyMatchTitles — just delegates to the lib with
  // `this` as the db. Wired as a function so tests can override
  // getAllTitlesForFuzzy and see the change reflected.
  db.fuzzyMatchTitles = (query, opts) => fuzzyMatchTitles(query, db, opts)
  return {
    db,
    dataDir: '/tmp',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
}

describe('search command', () => {
  test('pushes a single source filter down into SQL options', async () => {
    const calls = []
    await search({
      query: 'ui',
      source: 'wwdc',
      noDeep: true,
      fuzzy: false,
    }, makeCtx(calls))

    expect(calls).toHaveLength(1)
    expect(calls[0].sourceType).toBe('wwdc')
  })

  test('keeps multi-source filtering as a JS post-filter', async () => {
    const calls = []
    await search({
      query: 'ui',
      source: 'wwdc,sample-code',
      noDeep: true,
      fuzzy: false,
    }, makeCtx(calls))

    expect(calls).toHaveLength(1)
    expect(calls[0].sourceType).toBeNull()
  })

  test('does not run body search when fast tiers already satisfy the limit', async () => {
    const calls = []
    const bodyCalls = []
    const ctx = makeCtx(calls)
    ctx.db.searchPages = (_ftsQuery, _rawQuery, opts) => {
      calls.push(opts)
      return [
        { path: 'swiftui/view', title: 'View', role_heading: 'Protocol', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
        { path: 'swiftui/text', title: 'Text', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
      ]
    }
    ctx.db.searchBody = () => {
      bodyCalls.push('body')
      return []
    }

    const result = await search({
      query: 'View',
      limit: 2,
      fuzzy: false,
    }, ctx)

    expect(result.results).toHaveLength(2)
    expect(bodyCalls).toHaveLength(0)
  })

  test('applies offset after ranking while preserving total count', async () => {
    const calls = []
    const ctx = makeCtx(calls)
    ctx.db.searchPages = () => ([
      { path: 'swiftui/a', title: 'A', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
      { path: 'swiftui/b', title: 'B', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
      { path: 'swiftui/c', title: 'C', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
    ])

    const result = await search({
      query: 'swiftui',
      limit: 1,
      offset: 1,
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.total).toBe(3)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].path).toBe('swiftui/b')
  })

  test('platform shorthand keeps rows that expose the requested platform', async () => {
    const calls = []
    const ctx = makeCtx(calls)
    ctx.db.searchPages = () => ([
      { path: 'swiftui/view', title: 'View', role_heading: 'Protocol', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1, min_ios: '13.0', platforms: JSON.stringify({ ios: '13.0', macos: '10.15' }) },
      { path: 'swiftui/macos-only', title: 'MacOnly', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1, min_macos: '12.0', platforms: JSON.stringify({ macos: '12.0' }) },
    ])

    const result = await search({
      query: 'View',
      platform: 'ios',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].path).toBe('swiftui/view')
  })

  test('matches displayed kinds case-insensitively on fast tiers', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => ([
      { path: 'documentation/testfw/testing-guide', title: 'Testing Guide', role_heading: 'Article', role: 'article', framework: 'TestFW', source_type: 'apple-docc', url_depth: 2 },
    ])

    const result = await search({
      query: 'Testing',
      kind: 'Article',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].kind).toBe('Article')
  })

  test('fuzzy fallback still respects displayed kind filters', async () => {
    const ctx = makeCtx([])
    ctx.db.getAllTitlesForFuzzy = () => [{ id: 1, title: 'Testing Guide' }]
    ctx.db.getSearchRecordById = () => ({
      path: 'documentation/testfw/testing-guide',
      title: 'Testing Guide',
      role_heading: 'Article',
      role: 'article',
      framework: 'TestFW',
      root_slug: 'testfw',
      source_type: 'apple-docc',
      url_depth: 2,
    })

    const result = await search({
      query: 'Testing Guide',
      kind: 'Article',
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].path).toBe('documentation/testfw/testing-guide')
  })

  test('applies numeric min-version filters in JS so older supported docs are kept', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => ([
      { path: 'foundation/urlsession', title: 'URLSession', role_heading: 'Class', role: 'symbol', framework: 'Foundation', source_type: 'apple-docc', url_depth: 2, min_ios: '7.0' },
    ])

    const result = await search({
      query: 'URLSession',
      platform: 'ios',
      minIos: '17.0',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].path).toBe('foundation/urlsession')
  })

  test('relaxes a long natural-language query when the strict cascade is empty', async () => {
    const calls = []
    const ctx = makeCtx(calls)
    let call = 0
    ctx.db.searchPages = (_ftsQuery, _rawQuery, opts) => {
      calls.push({ ftsQuery: _ftsQuery, opts })
      call += 1
      if (call === 1) return [] // strict pass
      return [
        { path: 'swiftui/sheet', title: 'Sheet', role_heading: 'Article', role: 'article', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 2 },
      ]
    }

    const result = await search({
      query: 'how do I present a sheet in SwiftUI',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].matchQuality).toBe('relaxed')
    expect(result.relaxed).toBe(true)
    expect(result.relaxationTier).toBe('pruned')
  })

  test('falls through to OR relaxation when the pruned AND pass still returns nothing', async () => {
    const ctx = makeCtx([])
    const queries = []
    let call = 0
    ctx.db.searchPages = (ftsQuery, _rawQuery) => {
      queries.push(ftsQuery)
      call += 1
      if (call <= 2) return [] // strict + pruned AND empty
      return [
        { path: 'swift/actors', title: 'Actors', role_heading: 'Article', role: 'article', framework: 'Swift', source_type: 'apple-docc', url_depth: 2 },
      ]
    }

    const result = await search({
      query: 'what is the difference between actor and class',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].matchQuality).toBe('relaxed-or')
    expect(result.relaxed).toBe(true)
    expect(result.relaxationTier).toBe('pruned-or')
    // The last query should be an OR composition.
    expect(queries.at(-1)).toMatch(/ OR /)
  })

  test('falls through to trigram relaxation on a single signal token', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => []
    const trigramQueries = []
    // The strict T2 trigram pass runs with the full raw query; relaxation runs
    // with a single high-signal token. Only return hits for the token form.
    ctx.db.searchTrigram = (query) => {
      trigramQueries.push(query)
      if (query === 'NavigationStack') {
        return [
          { path: 'swiftui/navigationstack', title: 'NavigationStack', role_heading: 'Structure', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 2 },
        ]
      }
      return []
    }

    const result = await search({
      query: 'how do I push a new screen with NavigationStack today',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].matchQuality).toBe('relaxed-token')
    expect(result.relaxationTier).toBe('trigram')
    expect(trigramQueries).toContain('NavigationStack')
  })

  test('does not relax when strict results are present', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => ([
      { path: 'swiftui/view', title: 'View', role_heading: 'Protocol', role: 'symbol', framework: 'SwiftUI', source_type: 'apple-docc', url_depth: 1 },
    ])

    const result = await search({
      query: 'how do I use View',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.relaxed).toBeFalsy()
    expect(result.relaxationTier).toBeUndefined()
    expect(result.results.some(r => String(r.matchQuality).startsWith('relaxed'))).toBe(false)
  })

  test('skips relaxation for short queries', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => []

    const result = await search({
      query: 'View',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.relaxed).toBeFalsy()
    expect(result.relaxationTier).toBeUndefined()
  })

  test('skips relaxation for explicit quoted phrases', async () => {
    const ctx = makeCtx([])
    ctx.db.searchPages = () => []

    const result = await search({
      query: '"sheet dismiss swiftui"',
      fuzzy: false,
      noDeep: true,
    }, ctx)

    expect(result.relaxed).toBeFalsy()
    expect(result.relaxationTier).toBeUndefined()
  })
})
