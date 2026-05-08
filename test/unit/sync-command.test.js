import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sync } from '../../src/commands/sync.js'
import { normalizeList, validateRequestedSources, filterPages, filterPagesByRoots } from '../../src/commands/command-helpers.js'
import { DocsDatabase } from '../../src/storage/database.js'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('sync command', () => {
  test('rejects unknown source filters before running discovery', async () => {
    await expect(sync({
      sources: ['not-a-source'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('Unknown source type(s): not-a-source')
  })

  test('rejects multiple unknown sources with all names listed', async () => {
    await expect(sync({
      sources: ['fake-one', 'fake-two'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('fake-one')
  })

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

      expect(result.failedSources).toEqual([
        { source: 'bad-source', error: 'discover boom' },
      ])
      expect(result.crawlResults['good-root']).toEqual({ processed: 0, total: 0, skipped: 0 })
    } finally {
      db.close()
    }
  })

  test('runs fonts + symbols sync on a whole-corpus sync', async () => {
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

      // Fonts always index family metadata even with no DMG download.
      expect(result.fonts).toBeDefined()
      expect(result.fonts.families).toBeGreaterThan(0)
      // Symbols may or may not be available depending on host, but the
      // result key must be present so callers can inspect it.
      expect(result).toHaveProperty('symbols')
    } finally {
      db.close()
    }
  })

  test('skips fonts + symbols when sync is restricted via --sources', async () => {
    const dataDir = join(tmpdir(), `apple-docs-sync-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    try {
      const result = await sync({ sources: ['packages'] }, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [
          {
            constructor: { type: 'packages', displayName: 'Swift Package Catalog', syncMode: 'flat' },
            async discover() { return { roots: [], keys: [] } },
            validateNormalizeResult() {},
          },
        ],
      })

      expect(result.fonts).toBeNull()
      expect(result.symbols).toBeNull()
    } finally {
      db.close()
    }
  })

  test('skipFonts + skipSymbols flags opt out of resource sync on whole-corpus runs', async () => {
    const dataDir = join(tmpdir(), `apple-docs-sync-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    try {
      const result = await sync({ skipFonts: true, skipSymbols: true }, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [],
      })
      expect(result.fonts).toBeNull()
      expect(result.symbols).toBeNull()
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
