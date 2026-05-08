import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sync } from '../../src/commands/sync.js'
import { normalizeList, validateRequestedSources, filterPages, filterPagesByRoots } from '../../src/commands/command-helpers.js'
import { DocsDatabase } from '../../src/storage/database.js'

const tempDirs = []
const originalSkipResources = process.env.APPLE_DOCS_SKIP_RESOURCES

beforeAll(() => {
  // Bypass the fonts + SF Symbols pass — pre-rendering ~9k symbols is
  // multi-minute work on a fresh corpus and would blow every test timeout.
  process.env.APPLE_DOCS_SKIP_RESOURCES = '1'
})

afterAll(() => {
  if (originalSkipResources === undefined) Reflect.deleteProperty(process.env, 'APPLE_DOCS_SKIP_RESOURCES')
  else process.env.APPLE_DOCS_SKIP_RESOURCES = originalSkipResources
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('sync command', () => {
  test('continues syncing other adapters when one discovery fails', async () => {
    const dataDir = join(tmpdir(), `apple-docs-sync-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    db.upsertRoot('good-root', 'Good Root', 'collection', 'test')
    const goodRoot = db.getRootBySlug('good-root')

    try {
      const result = await sync({}, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [
          {
            constructor: { type: 'bad-source', displayName: 'Bad Source', syncMode: 'flat' },
            async discover() {
              throw new Error('discover boom')
            },
            validateNormalizeResult() {},
          },
          {
            constructor: { type: 'good-source', displayName: 'Good Source', syncMode: 'flat' },
            async discover() {
              return { roots: [{ ...goodRoot, source_type: 'good-source' }], keys: [] }
            },
            validateNormalizeResult() {},
          },
        ],
      })

      expect(result.failedSources).toContainEqual(
        { source: 'bad-source', error: 'discover boom' },
      )
      expect(result.crawlResults['good-root']).toEqual({ processed: 0, total: 0, skipped: 0 })
    } finally {
      db.close()
    }
  })

  test('always returns fonts and symbols result keys on a whole-corpus sync', async () => {
    const dataDir = join(tmpdir(), `apple-docs-sync-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    try {
      const result = await sync({}, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [],
      })

      // Every whole-corpus sync covers fonts + SF Symbols + the doctor pass
      // (schema migrations, JSON minify, failure cleanup). The result keys
      // must always be present so callers can inspect them; concrete values
      // depend on the host. APPLE_DOCS_SKIP_RESOURCES=1 (set in this test
      // suite's beforeAll) leaves the fonts/symbols values null but still
      // populates the keys.
      expect(result).toHaveProperty('fonts')
      expect(result).toHaveProperty('symbols')
      expect(result).toHaveProperty('symbolsRender')
      expect(result).toHaveProperty('doctor')
    } finally {
      db.close()
    }
  })

  test('passes the full-sync hint to adapters during discovery', async () => {
    const dataDir = join(tmpdir(), `apple-docs-sync-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    let fullSyncSeen = false

    try {
      await sync({ full: true }, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [
          {
            constructor: { type: 'packages', displayName: 'Swift Package Catalog', syncMode: 'flat' },
            async discover(ctx) {
              fullSyncSeen = ctx.fullSync
              return { roots: [], keys: [] }
            },
            validateNormalizeResult() {},
          },
        ],
      })

      expect(fullSyncSeen).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('command helpers (used by sync)', () => {
  test('normalizeList returns null for undefined', () => {
    expect(normalizeList(undefined)).toBeNull()
    expect(normalizeList(null)).toBeNull()
  })

  test('normalizeList returns empty array for empty array', () => {
    expect(normalizeList([])).toEqual([])
  })

  test('normalizeList lowercases values', () => {
    expect(normalizeList(['SwiftUI', 'UIKit'])).toEqual(['swiftui', 'uikit'])
  })

  test('validateRequestedSources passes for null', () => {
    expect(() => validateRequestedSources(null)).not.toThrow()
  })

  test('validateRequestedSources passes for valid source types', () => {
    expect(() => validateRequestedSources(['apple-docc'])).not.toThrow()
  })

  test('validateRequestedSources throws for unknown source', () => {
    expect(() => validateRequestedSources(['fake-source'])).toThrow('Unknown source type(s)')
  })

  test('filterPages filters by root slug', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'uikit', source_type: 'apple-docc', path: 'b' },
    ]
    const result = filterPages(pages, ['swiftui'], null)
    expect(result.length).toBe(1)
    expect(result[0].path).toBe('a')
  })

  test('filterPages filters by source type', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'proposals', source_type: 'swift-evolution', path: 'b' },
    ]
    const result = filterPages(pages, null, ['swift-evolution'])
    expect(result.length).toBe(1)
    expect(result[0].path).toBe('b')
  })

  test('filterPages returns all when no filters', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'proposals', source_type: 'swift-evolution', path: 'b' },
    ]
    const result = filterPages(pages, null, null)
    expect(result.length).toBe(2)
  })

  test('filterPagesByRoots filters correctly', () => {
    const pages = [
      { root_slug: 'swiftui', path: 'a' },
      { root_slug: 'uikit', path: 'b' },
    ]
    expect(filterPagesByRoots(pages, ['swiftui']).length).toBe(1)
    expect(filterPagesByRoots(pages, null).length).toBe(2)
  })
})
