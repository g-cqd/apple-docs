import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'
import { searchHandler } from '../../../src/web/routes/search.route.js'
import { createLru } from '../../../src/lib/lru.js'

let db
let ctx
let dataDir

const INFRA_BLACKLIST = new Set([
  'matchQuality', 'distance', 'score',
  'tier', 'tierLimitation', 'trigramAvailable', 'bodyIndexAvailable',
  'relaxed', 'relaxationTier', 'partial', 'partialReasons',
  'urlDepth', 'sourceMetadata', 'intent',
  'sectionKind', 'sortOrder', 'file_path',
])

const SEARCH_ALLOWED = new Set([
  'query', 'total', 'hasMore', 'results', 'approximate', 'truncated', 'pageInfo',
])

const HIT_ALLOWED = new Set([
  'path', 'title', 'framework', 'rootSlug', 'kind', 'sourceType',
  'abstract', 'declaration', 'platforms', 'language',
  'snippet', 'relatedCount', 'confidence',
  'isDeprecated', 'isBeta', 'isReleaseNotes',
])

function assertNoBlacklistedDeep(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoBlacklistedDeep(value[i], `${path}[${i}]`)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (INFRA_BLACKLIST.has(key)) {
        throw new Error(`web leak: "${key}" at ${path}`)
      }
      assertNoBlacklistedDeep(value[key], `${path}.${key}`)
    }
  }
}

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc', key: 'swiftui/view', title: 'View',
      kind: 'symbol', role: 'symbol', roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app\'s user interface.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app\'s user interface.', sortOrder: 0 },
    ],
    relationships: [],
  })

  // Use a real tmpdir so any markdown / raw-json writers don't create a
  // literal `:memory:/` tree at the repo root. (See the matching fix in
  // test/mcp/leak-guard.test.js.)
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-web-leak-guard-'))

  // Minimal ctx for /api/search — see src/web/routes/search.route.js for the
  // shape it expects.
  ctx = {
    db,
    searchCtx: { db, dataDir, logger: console },
    searchCache: createLru({ max: 64 }),
    corpusStamp: { get: () => 'stamp-1' },
  }
})

afterEach(() => {
  db?.close()
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* tolerate */ }
    dataDir = undefined
  }
})

async function callSearch(query, params = {}) {
  const url = new URL('http://x/api/search')
  if (query) url.searchParams.set('q', query)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const resp = await searchHandler(new Request(url), ctx, url)
  return resp.json()
}

describe('/api/search response respects public allowlist', () => {
  test('empty query returns clean empty shell', async () => {
    const out = await callSearch('')
    expect(out).toEqual({ query: '', total: 0, results: [] })
  })

  test('regular query returns projected shape', async () => {
    const out = await callSearch('View')
    for (const key of Object.keys(out)) {
      expect(SEARCH_ALLOWED.has(key)).toBe(true)
    }
    assertNoBlacklistedDeep(out)
    for (const hit of out.results ?? []) {
      for (const key of Object.keys(hit)) {
        expect(HIT_ALLOWED.has(key)).toBe(true)
      }
      expect(['exact', 'partial', 'approximate']).toContain(hit.confidence)
    }
  })

  test('cache-hit path also goes through projection', async () => {
    // First call seeds the cache.
    await callSearch('View')
    // Second call hits the cache; must still be projected.
    const out = await callSearch('View')
    for (const key of Object.keys(out)) {
      expect(SEARCH_ALLOWED.has(key)).toBe(true)
    }
    assertNoBlacklistedDeep(out)
  })
})
