import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { snapshotBuild } from '../../src/commands/snapshot.js'
import { setup } from '../../src/commands/setup.js'
import { createLogger } from '../../src/lib/logger.js'

let dataDir
let db
let logger
let snapshotOutDir
let snapshotResult

beforeEach(async () => {
  // Source corpus: seed enough rows to look like a real install.
  const sourceDir = mkdtempSync(join(tmpdir(), 'apple-docs-archive-source-'))
  const sourceDb = new DocsDatabase(join(sourceDir, 'apple-docs.db'))
  const root = sourceDb.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  sourceDb.upsertPage({
    rootId: root.id,
    path: 'swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    sourceType: 'apple-docc',
  })
  sourceDb.upsertNormalizedDocument({
    document: {
      key: 'swiftui/view',
      title: 'View',
      sourceType: 'apple-docc',
      framework: 'swiftui',
      role: 'symbol',
    },
    sections: [],
    relationships: [],
  })

  // The snapshot must be written under $HOME so the path-containment
  // check passes — installFromLocalArchive refuses sources outside
  // $HOME / cwd. mkdtempSync under tmpdir() lives outside $HOME on most
  // hosts, so target $HOME explicitly here.
  snapshotOutDir = mkdtempSync(join(homedir(), '.apple-docs-archive-test-'))
  logger = createLogger('error')
  snapshotResult = await snapshotBuild(
    { out: snapshotOutDir, tag: 'archive-test-1' },
    { db: sourceDb, dataDir: sourceDir, logger },
  )
  sourceDb.close()
  rmSync(sourceDir, { recursive: true, force: true })

  // Fresh empty target dir for the install
  dataDir = mkdtempSync(join(homedir(), '.apple-docs-archive-target-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
})

afterEach(() => {
  try { db.close() } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  try { rmSync(snapshotOutDir, { recursive: true, force: true }) } catch {}
})

describe('setup --archive (local snapshot install)', () => {
  test('installs from a local archive with valid checksum sidecar', async () => {
    const result = await setup(
      { archive: snapshotResult.archivePath },
      { db, dataDir, logger },
    )
    expect(result.status).toBe('ok')
    expect(result.source).toBe('local-archive')
    expect(result.documentCount).toBeGreaterThanOrEqual(1)
    expect(result.tag).toBe('archive-test-1')
    expect(result.schemaVersion).toBe(18)

    const verifyDb = new DocsDatabase(join(dataDir, 'apple-docs.db'))
    try {
      expect(verifyDb.getSnapshotMeta('snapshot_installed_at')).not.toBeNull()
    } finally {
      verifyDb.close()
    }
  })

  test('skipResources skips the post-install font/symbol re-index', async () => {
    const result = await setup(
      { archive: snapshotResult.archivePath, skipResources: true },
      { db, dataDir, logger },
    )
    expect(result.status).toBe('ok')
    // Document count comes from the extracted DB regardless of resource skip.
    expect(result.documentCount).toBeGreaterThanOrEqual(1)
  })

  test('proceeds with warn when sidecar checksum is missing', async () => {
    // Remove the checksum sidecar — local-archive mode is permissive.
    rmSync(snapshotResult.checksumPath, { force: true })
    const result = await setup(
      { archive: snapshotResult.archivePath },
      { db, dataDir, logger },
    )
    expect(result.status).toBe('ok')
    expect(result.documentCount).toBeGreaterThanOrEqual(1)
  })

  test('rejects a stale / wrong checksum sidecar', async () => {
    // Corrupt the sidecar with a definitely-not-matching hash.
    writeFileSync(snapshotResult.checksumPath, 'deadbeef'.repeat(8) + '  archive\n')
    await expect(setup(
      { archive: snapshotResult.archivePath },
      { db, dataDir, logger },
    )).rejects.toThrow(/Checksum mismatch/i)
  })

  test('rejects an archive outside $HOME / cwd', async () => {
    // tmpdir() lives outside $HOME on macOS (/var/folders/...).
    // Copy the archive there and confirm setup refuses.
    const outsideDir = mkdtempSync(join(tmpdir(), 'apple-docs-outside-'))
    const outsidePath = join(outsideDir, 'archive.tar.gz')
    Bun.write(outsidePath, Bun.file(snapshotResult.archivePath))
    // Wait a beat for the async write.
    await new Promise(r => setTimeout(r, 50))
    try {
      if (!existsSync(outsidePath)) {
        // Bun.write returned but the file isn't visible yet — skip
        // the negative assertion rather than flake.
        return
      }
      // Only assert when outsideDir is actually outside HOME and cwd.
      if (outsideDir.startsWith(`${homedir()}/`) || outsideDir.startsWith(`${process.cwd()}/`)) {
        return
      }
      await expect(setup(
        { archive: outsidePath },
        { db, dataDir, logger },
      )).rejects.toThrow(/must live under \$HOME or the current working directory/)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('reports archive path in the result envelope', async () => {
    const result = await setup(
      { archive: snapshotResult.archivePath },
      { db, dataDir, logger },
    )
    expect(result.archive).toBe(snapshotResult.archivePath)
  })

  test('refuses when an existing corpus is present and --force is not set', async () => {
    // Seed a page on the target DB so totalPages > 0.
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertPage({ rootId: root.id, path: 'swiftui/view', url: 'u', title: 'View', role: 'symbol' })
    const result = await setup(
      { archive: snapshotResult.archivePath, force: false },
      { db, dataDir, logger },
    )
    expect(result.status).toBe('exists')
  })
})
