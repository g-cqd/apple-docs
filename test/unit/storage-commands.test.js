import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { storageStats, storageGc, storageMaterialize } from '../../src/commands/storage.js'

let db
let dataDir
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-storage-'))

  mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
  mkdirSync(join(dataDir, 'markdown'), { recursive: true })
  mkdirSync(join(dataDir, 'html'), { recursive: true })

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app UI',
    platforms: null,
    declaration: null,
    etag: null,
    lastModified: null,
    contentHash: 'test',
    downloadedAt: new Date().toISOString(),
    sourceType: 'apple-docc',
  })
  const docId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
  db.db.run(
    `INSERT OR REPLACE INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
     VALUES (?, 'abstract', NULL, 'A type that represents part of your app UI', 0)`,
    [docId]
  )

  ctx = { db, dataDir, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('storageStats', () => {
  test('returns object with expected top-level keys', () => {
    const stats = storageStats({}, ctx)
    expect(stats).toHaveProperty('database')
    expect(stats).toHaveProperty('rawJson')
    expect(stats).toHaveProperty('markdown')
    expect(stats).toHaveProperty('html')
    expect(stats).toHaveProperty('tables')
    expect(stats).toHaveProperty('total')
  })

  test('tables.documents is greater than 0 after seeding', () => {
    const stats = storageStats({}, ctx)
    expect(stats.tables.documents).toBeGreaterThan(0)
  })

  test('rawJson.files is 0 for an empty raw-json directory', () => {
    const stats = storageStats({}, ctx)
    expect(stats.rawJson.files).toBe(0)
  })

  test('total is a non-negative number', () => {
    const stats = storageStats({}, ctx)
    expect(stats.total).toBeGreaterThanOrEqual(0)
    expect(typeof stats.total).toBe('number')
  })

  test('database.path points to the expected db file location', () => {
    const stats = storageStats({}, ctx)
    expect(stats.database.path).toBe(join(dataDir, 'apple-docs.db'))
  })

  test('tables contains all expected table names', () => {
    const stats = storageStats({}, ctx)
    expect(stats.tables).toHaveProperty('documents')
    expect(stats.tables).toHaveProperty('document_sections')
    expect(stats.tables).toHaveProperty('pages')
    expect(stats.tables).toHaveProperty('roots')
    expect(stats.tables).toHaveProperty('crawl_state')
    expect(stats.tables).not.toHaveProperty('refs') // dropped in v15
  })
})

describe('storageGc', () => {
  test('GC with drop markdown removes markdown directory contents', () => {
    const testFile = join(dataDir, 'markdown', 'test-doc.md')
    writeFileSync(testFile, '# Test')
    expect(existsSync(testFile)).toBe(true)

    storageGc({ drop: ['markdown'] }, ctx)

    expect(existsSync(testFile)).toBe(false)
    // The directory itself should still exist (recreated empty)
    expect(existsSync(join(dataDir, 'markdown'))).toBe(true)
  })

  test('GC with drop html removes html directory contents', () => {
    const testFile = join(dataDir, 'html', 'test-doc.html')
    writeFileSync(testFile, '<h1>Test</h1>')
    expect(existsSync(testFile)).toBe(true)

    storageGc({ drop: ['html'] }, ctx)

    expect(existsSync(testFile)).toBe(false)
    expect(existsSync(join(dataDir, 'html'))).toBe(true)
  })

  test('GC removes orphan crawl_state entries', () => {
    db.db.run(
      `INSERT INTO crawl_state (path, status, root_slug, depth)
       VALUES ('orphan/path', 'done', 'nonexistent-root', 0)`
    )
    const before = db.db.query('SELECT COUNT(*) as count FROM crawl_state').get().count
    expect(before).toBe(1)

    storageGc({}, ctx)

    const after = db.db.query('SELECT COUNT(*) as count FROM crawl_state').get().count
    expect(after).toBe(0)
  })

  test('GC with vacuum: true does not throw', () => {
    expect(() => storageGc({ vacuum: true }, ctx)).not.toThrow()
  })

  test('GC with vacuum: false skips VACUUM without error', () => {
    expect(() => storageGc({ vacuum: false }, ctx)).not.toThrow()
  })

  test('returns object with droppedDirs, orphansCleaned, and vacuumed', () => {
    const result = storageGc({ drop: ['markdown'], vacuum: true }, ctx)
    expect(result).toHaveProperty('droppedDirs')
    expect(result).toHaveProperty('orphansCleaned')
    expect(result).toHaveProperty('vacuumed')
    expect(result.droppedDirs).toContain('markdown')
    expect(result.vacuumed).toBe(true)
  })

  test('droppedDirs reflects only the requested dirs', () => {
    const result = storageGc({ drop: ['html'], vacuum: false }, ctx)
    expect(result.droppedDirs).toContain('html')
    expect(result.droppedDirs).not.toContain('markdown')
    expect(result.vacuumed).toBe(false)
  })

  test('--older-than purges stale activity row (regression: column was wrong)', () => {
    // The activity table column is `started_at` (v2 migration); earlier
    // code referenced a non-existent `timestamp` and threw on every
    // --older-than invocation. Activity is a single-row state table
    // (id CHECK(id=1)) so we seed one stale row and assert it's gone.
    db.db.run(
      "INSERT OR REPLACE INTO activity (id, action, started_at, pid) VALUES (1, 'test', datetime('now', '-3 days'), 0)",
    )
    expect(db.db.query('SELECT COUNT(*) as c FROM activity').get().c).toBe(1)

    expect(() => storageGc({ olderThan: 1, vacuum: false }, ctx)).not.toThrow()

    expect(db.db.query('SELECT COUNT(*) as c FROM activity').get().c).toBe(0)
  })

  test('--older-than does not throw when activity table is empty', () => {
    db.db.run('DELETE FROM activity')
    expect(() => storageGc({ olderThan: 7, vacuum: false }, ctx)).not.toThrow()
  })
})

describe('storageMaterialize', () => {
  test('materialize markdown writes .md file for seeded document', async () => {
    await storageMaterialize({ format: 'markdown' }, ctx)

    const expectedPath = join(dataDir, 'markdown', 'documentation/swiftui/view.md')
    expect(existsSync(expectedPath)).toBe(true)
  })

  test('materialized markdown file starts with YAML front matter (---)', async () => {
    await storageMaterialize({ format: 'markdown' }, ctx)

    const expectedPath = join(dataDir, 'markdown', 'documentation/swiftui/view.md')
    const file = Bun.file(expectedPath)
    const content = await file.text()
    expect(content.startsWith('---')).toBe(true)
  })

  test('materialize html writes .html file for seeded document', async () => {
    await storageMaterialize({ format: 'html' }, ctx)

    const expectedPath = join(dataDir, 'html', 'documentation/swiftui/view.html')
    expect(existsSync(expectedPath)).toBe(true)
  })

  test('returns { materialized: 1, format: "markdown" } for one seeded doc', async () => {
    const result = await storageMaterialize({ format: 'markdown' }, ctx)
    expect(result.materialized).toBe(1)
    expect(result.format).toBe('markdown')
  })

  test('materialize with roots filter for nonexistent framework returns materialized: 0', async () => {
    const result = await storageMaterialize({ format: 'markdown', roots: ['nonexistent'] }, ctx)
    expect(result.materialized).toBe(0)
  })

  test('materialize html returns correct format in result', async () => {
    const result = await storageMaterialize({ format: 'html' }, ctx)
    expect(result.format).toBe('html')
    expect(result.materialized).toBe(1)
  })

  test('materialize with matching roots filter materializes the document', async () => {
    const result = await storageMaterialize({ format: 'markdown', roots: ['swiftui'] }, ctx)
    expect(result.materialized).toBe(1)
  })
})
