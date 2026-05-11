import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { DocsDatabase } from '../../src/storage/database.js'
import { snapshotBuild } from '../../src/commands/snapshot.js'
import { createLogger } from '../../src/lib/logger.js'
import { resolveSevenZipBinary } from '../../src/lib/archive-7z.js'

// Snapshot archives are native .7z (P2 archive pipeline). Tests extract via
// the same 7zz/7z binary the runtime uses, discovered on PATH at call time.
async function extract7z(archivePath, destDir) {
  const binary = resolveSevenZipBinary()
  const proc = Bun.spawn([binary, 'x', '-y', `-o${destDir}`, archivePath], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`7z extraction failed (exit ${code}): ${stderr}`)
  }
}

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
  test('produces archive, checksum, and manifest', async () => {
    const result = await snapshotBuild({ out: outDir, tag: 'test-v1' }, { db, dataDir, logger })

    expect(result.tier).toBe('full')
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

  test('writes snapshot_meta into copied DB', async () => {
    const result = await snapshotBuild({ out: outDir, tag: 'test-meta' }, { db, dataDir, logger })

    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-'))
    try {
      await extract7z(result.archivePath, extractDir)

      const extractedDb = new Database(join(extractDir, 'apple-docs.db'), { readonly: true })
      try {
        const tier = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_tier')
        expect(tier.value).toBe('full')

        const docCount = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_document_count')
        expect(docCount.value).toBe('1')

        const schemaVer = extractedDb.query('SELECT value FROM snapshot_meta WHERE key = ?').get('snapshot_schema_version')
        // Schema version moves over time — assert shape, not a fixed value.
        expect(schemaVer.value).toMatch(/^\d+$/)
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
        snapshotBuild({ out: outDir }, { db: emptyDb, dataDir: emptyDir, logger })
      ).rejects.toThrow('Corpus is empty')
    } finally {
      emptyDb.close()
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  test('keeps every table; only operational tables are truncated', async () => {
    const result = await snapshotBuild({ out: outDir, tag: 'test-tables' }, { db, dataDir, logger })

    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-'))
    try {
      await extract7z(result.archivePath, extractDir)

      const extractedDb = new Database(join(extractDir, 'apple-docs.db'), { readonly: true })
      try {
        const tables = extractedDb.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
        // Body / trigram / sections all preserved (G.1: lite-tier drops gone).
        expect(tables).toContain('document_sections')
        expect(tables).toContain('documents')
        expect(tables).toContain('documents_trigram')
        expect(tables).toContain('documents_body_fts')

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

  test('ships pre-rendered SF Symbols (F.3a)', async () => {
    // Stage a couple of pre-rendered SVGs so the snapshot tar has
    // something to pick up.
    const symBase = join(dataDir, 'resources', 'symbols')
    mkdirSync(join(symBase, 'public', 'bold-large'), { recursive: true })
    writeFileSync(join(symBase, 'public', 'bold-large', 'heart.svg'), '<svg/>')
    mkdirSync(join(symBase, 'private'), { recursive: true })
    writeFileSync(join(symBase, 'private', 'pencil.and.sparkles.svg'), '<svg/>')

    const result = await snapshotBuild({ out: outDir, tag: 'test-sym' }, { db, dataDir, logger })
    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-sym-'))
    try {
      await extract7z(result.archivePath, extractDir)
      expect(existsSync(join(extractDir, 'resources', 'symbols', 'public', 'bold-large', 'heart.svg'))).toBe(true)
      expect(existsSync(join(extractDir, 'resources', 'symbols', 'private', 'pencil.and.sparkles.svg'))).toBe(true)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('refuses build when symbol matrix is incomplete (F.3b)', async () => {
    // Catalog the public symbol; do NOT stage any of its pre-renders.
    db.upsertSfSymbol({
      scope: 'public',
      name: 'heart',
      categories: [],
      keywords: [],
      orderIndex: 0,
    })
    // Create the symbols dir so the include branch fires; leave it
    // empty so validation finds 27 missing variants.
    mkdirSync(join(dataDir, 'resources', 'symbols', 'public'), { recursive: true })

    await expect(
      snapshotBuild({ out: outDir, tag: 'test-incomplete' }, { db, dataDir, logger }),
    ).rejects.toThrow(/SnapshotIncompleteError|missing/i)
  })

  test('--allow-incomplete-symbols overrides the matrix gate (F.3b)', async () => {
    db.upsertSfSymbol({
      scope: 'public',
      name: 'heart',
      categories: [],
      keywords: [],
      orderIndex: 0,
    })
    mkdirSync(join(dataDir, 'resources', 'symbols', 'public'), { recursive: true })

    const result = await snapshotBuild(
      { out: outDir, tag: 'test-allow-incomp', allowIncompleteSymbols: true },
      { db, dataDir, logger: { ...logger, warn: () => {} } },
    )
    expect(existsSync(result.archivePath)).toBe(true)
  })
})
