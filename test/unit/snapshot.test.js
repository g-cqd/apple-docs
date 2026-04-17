import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { DocsDatabase } from '../../src/storage/database.js'
import { snapshotBuild } from '../../src/commands/snapshot.js'
import { createLogger } from '../../src/lib/logger.js'

let db
let dataDir
let outDir
let logger

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-snap-'))
  const dbPath = join(dataDir, 'apple-docs.db')
  db = new DocsDatabase(dbPath)
  outDir = mkdtempSync(join(tmpdir(), 'apple-docs-out-'))
  logger = createLogger('error')

  // Seed minimal corpus
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    abstract: 'A type that represents part of your app UI.',
    sourceType: 'apple-docc',
  })
  db.upsertNormalizedDocument({
    document: {
      key: 'swiftui/view',
      title: 'View',
      sourceType: 'apple-docc',
      framework: 'swiftui',
      role: 'symbol',
      abstractText: 'A type that represents part of your app UI.',
    },
    sections: [{ sectionKind: 'discussion', heading: 'Overview', contentText: 'Overview text', sortOrder: 0 }],
    relationships: [],
  })
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

describe('snapshotBuild', () => {
  test('produces archive, checksum, and manifest for standard tier', async () => {
    const result = await snapshotBuild({ tier: 'standard', out: outDir, tag: 'test-v1' }, { db, dataDir, logger })

    expect(result.tier).toBe('standard')
    expect(result.tag).toBe('test-v1')
    expect(result.documentCount).toBe(1)
    expect(result.dbSize).toBeGreaterThan(0)
    expect(result.dbChecksum).toMatch(/^[0-9a-f]{64}$/)
    expect(result.archiveSize).toBeGreaterThan(0)

    // Archive file exists
    expect(existsSync(result.archivePath)).toBe(true)
    // Checksum file exists
    expect(existsSync(result.checksumPath)).toBe(true)
    // Manifest file exists
    expect(existsSync(result.manifestPath)).toBe(true)

    // Checksum file contains the archive hash
    const checksumContent = await Bun.file(result.checksumPath).text()
    expect(checksumContent).toContain(result.archiveChecksum)
  })

  test('lite tier drops body/trigram/sections tables', async () => {
    const result = await snapshotBuild({ tier: 'lite', out: outDir, tag: 'test-lite' }, { db, dataDir, logger })

    // Extract and verify the DB
    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-'))
    try {
      const proc = Bun.spawn(['tar', '-xzf', result.archivePath, '-C', extractDir])
      await proc.exited

      const extractedDb = new Database(join(extractDir, 'apple-docs.db'), { readonly: true })
      try {
        // document_sections should be gone in lite tier
        const tables = extractedDb.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
        expect(tables).not.toContain('document_sections')

        // Operational tables should still exist (schema preserved) but be empty
        expect(tables).toContain('crawl_state')
        const crawlCount = extractedDb.query('SELECT COUNT(*) as c FROM crawl_state').get().c
        expect(crawlCount).toBe(0)

        // But documents should still exist
        expect(tables).toContain('documents')
        expect(tables).toContain('pages')
      } finally {
        extractedDb.close()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('writes snapshot_meta into copied DB', async () => {
    const result = await snapshotBuild({ tier: 'standard', out: outDir, tag: 'test-meta' }, { db, dataDir, logger })

    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-'))
    try {
      const proc = Bun.spawn(['tar', '-xzf', result.archivePath, '-C', extractDir])
      await proc.exited

      const extractedDb = new Database(join(extractDir, 'apple-docs.db'), { readonly: true })
      try {
        const tier = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_tier')
        expect(tier.value).toBe('standard')

        const docCount = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_document_count')
        expect(docCount.value).toBe('1')

        const schemaVer = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_schema_version')
        expect(schemaVer.value).toBe('8')
      } finally {
        extractedDb.close()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('rejects empty corpus', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'apple-docs-empty-'))
    const emptyDb = new DocsDatabase(join(emptyDir, 'apple-docs.db'))

    try {
      await expect(
        snapshotBuild({ tier: 'standard', out: outDir }, { db: emptyDb, dataDir: emptyDir, logger })
      ).rejects.toThrow('Corpus is empty')
    } finally {
      emptyDb.close()
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  test('rejects invalid tier', async () => {
    await expect(
      snapshotBuild({ tier: 'mega', out: outDir }, { db, dataDir, logger })
    ).rejects.toThrow('Invalid tier')
  })

  test('standard tier drops operational tables but keeps sections', async () => {
    const result = await snapshotBuild({ tier: 'standard', out: outDir, tag: 'test-std' }, { db, dataDir, logger })

    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-'))
    try {
      const proc = Bun.spawn(['tar', '-xzf', result.archivePath, '-C', extractDir])
      await proc.exited

      const extractedDb = new Database(join(extractDir, 'apple-docs.db'), { readonly: true })
      try {
        const tables = extractedDb.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
        expect(tables).toContain('document_sections')
        expect(tables).toContain('documents')

        // Operational tables exist but are empty
        expect(tables).toContain('crawl_state')
        const crawlCount = extractedDb.query('SELECT COUNT(*) as c FROM crawl_state').get().c
        expect(crawlCount).toBe(0)
      } finally {
        extractedDb.close()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })
})
