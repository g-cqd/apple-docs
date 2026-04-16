import { describe, expect, test } from 'bun:test'
import { search } from '../../src/commands/search.js'

function makeCtx(calls) {
  return {
    db: {
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
    },
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
})
