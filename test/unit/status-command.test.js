import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { status } from '../../src/commands/status.js'

let db
let dataDir

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'status-test-'))
  mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
  mkdirSync(join(dataDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('status command', () => {
  test('returns basic structure for empty database', async () => {
    const result = await status({ skipUpdateCheck: true }, { db, dataDir })

    expect(result.dataDir).toBe(dataDir)
    expect(result.databaseSize).toBeGreaterThan(0)
    expect(result.rawJson).toEqual({ size: 0, files: 0 })
    expect(result.markdown).toEqual({ size: 0, files: 0 })
    expect(result.roots.total).toBe(0)
    expect(result.pages.active).toBe(0)
    expect(result.pages.deleted).toBe(0)
    expect(result.activity).toBeNull()
    expect(result.updateAvailable).toBeNull()
  })

  test('reports root and page counts', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui',
      url: 'https://developer.apple.com/documentation/swiftui',
      title: 'SwiftUI',
      role: 'collection',
      roleHeading: 'Framework',
      abstract: 'Build UI',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.roots.total).toBe(1)
    expect(result.pages.active).toBe(1)
  })

  test('freshness reports stale when no sync log', async () => {
    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.freshness.isStale).toBe(true)
    expect(result.freshness.lastSyncAt).toBeNull()
    expect(result.freshness.daysSinceSync).toBeNull()
  })

  test('freshness reports not stale after recent sync', async () => {
    // Insert a recent update_log entry
    db.db.run(
      'INSERT INTO update_log (action, timestamp, root_slug) VALUES (?, ?, ?)',
      ['sync', new Date().toISOString(), 'swiftui']
    )

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.freshness.isStale).toBe(false)
    expect(result.freshness.daysSinceSync).toBe(0)
    expect(result.freshness.staleRoots).toEqual([])
  })

  test('freshness detects stale roots', async () => {
    // Insert an old update_log entry (30 days ago)
    const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
    db.db.run(
      'INSERT INTO update_log (action, timestamp, root_slug) VALUES (?, ?, ?)',
      ['sync', oldDate, 'uikit']
    )
    // Insert a recent one for another root
    db.db.run(
      'INSERT INTO update_log (action, timestamp, root_slug) VALUES (?, ?, ?)',
      ['sync', new Date().toISOString(), 'swiftui']
    )

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.freshness.staleRoots.length).toBe(1)
    expect(result.freshness.staleRoots[0].slug).toBe('uikit')
    expect(result.freshness.staleRoots[0].daysSince).toBeGreaterThanOrEqual(29)
  })

  test('reports file counts for raw-json and markdown dirs', async () => {
    writeFileSync(join(dataDir, 'raw-json', 'test.json'), '{}')
    writeFileSync(join(dataDir, 'markdown', 'test.md'), '# Test')

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.rawJson.files).toBe(1)
    expect(result.rawJson.size).toBeGreaterThan(0)
    expect(result.markdown.files).toBe(1)
    expect(result.markdown.size).toBeGreaterThan(0)
  })

  test('crawl progress exists for empty database', async () => {
    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.crawlProgress).toBeDefined()
    expect(result.crawlProgress.total).toBe(0)
    expect(result.crawlProgress.processed).toBe(0)
    expect(result.crawlProgress.pending).toBe(0)
    expect(result.crawlProgress.failed).toBe(0)
  })

  test('lastSync and lastAction are null with no log', async () => {
    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.lastSync).toBeNull()
    expect(result.lastAction).toBeNull()
  })

  test('lastSync and lastAction from update_log', async () => {
    const ts = new Date().toISOString()
    db.db.run(
      'INSERT INTO update_log (action, timestamp) VALUES (?, ?)',
      ['sync', ts]
    )

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.lastSync).toBe(ts)
    expect(result.lastAction).toBe('sync')
  })

  test('skipUpdateCheck prevents update check', async () => {
    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.updateAvailable).toBeNull()
  })

  test('reports tier and capabilities', async () => {
    db.setSnapshotMeta('snapshot_tier', 'standard')

    const result = await status({ skipUpdateCheck: true }, { db, dataDir })
    expect(result.tier).toBe('standard')
    expect(result.capabilities).toEqual({
      search: true,
      searchTrigram: true,
      searchBody: false,
      readContent: true,
    })
  })
})
