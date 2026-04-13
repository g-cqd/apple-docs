import { describe, expect, test } from 'bun:test'
import { search } from '../../src/commands/search.js'

function makeCtx(calls) {
  return {
    db: {
      resolveRoot: () => null,
      getFrameworkSynonyms: () => [],
      getBodyIndexCount: () => 0,
      searchPages: (_ftsQuery, _rawQuery, opts) => {
        calls.push(opts)
        return []
      },
      searchTrigram: () => [],
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
})
