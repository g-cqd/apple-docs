import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { DocsDatabase } from '../../../src/storage/database.js'
import { snapshotBuild } from '../../../src/commands/snapshot.js'
import { createLogger } from '../../../src/lib/logger.js'
// Snapshot archives are `.tar.zst`. Extract them exactly the way the real
// consumer (`apple-docs setup`) does — Bun's native zstd → `tar -xf -` — so
// the test passes on stock macOS too (Apple's bsdtar lacks zstd).
import { extractTarZst } from '../../../src/commands/setup/helpers.js'
import { indexEmbeddings } from '../../../src/commands/index-embeddings.js'
import { topicEmbedder } from '../../helpers/topic-embedder.js'

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
      await extractTarZst(result.archivePath, extractDir)

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
      await extractTarZst(result.archivePath, extractDir)

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
      await extractTarZst(result.archivePath, extractDir)
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

  // Determinism gate (mirrors .github/workflows/snapshot.yml). Two
  // consecutive snapshotBuild calls against the same tag and corpus
  // must produce bit-identical tar.gz archives — the workflow re-runs
  // the build into dist-check/ and compares sha256s before publishing.
  // Regressions here would surface as a failed Sunday cron with a
  // MISMATCH line and no release artefact.
  test('two builds of the same tag produce bit-identical archives', async () => {
    const outA = mkdtempSync(join(tmpdir(), 'apple-docs-det-a-'))
    const outB = mkdtempSync(join(tmpdir(), 'apple-docs-det-b-'))
    try {
      const a = await snapshotBuild({ out: outA, tag: 'snapshot-20260517' }, { db, dataDir, logger })
      // Force a wall-clock gap so any lingering Date.now() use would
      // diverge the second run.
      await new Promise(resolve => setTimeout(resolve, 1100))
      const b = await snapshotBuild({ out: outB, tag: 'snapshot-20260517' }, { db, dataDir, logger })

      expect(a.archiveChecksum).toBe(b.archiveChecksum)
      expect(a.dbChecksum).toBe(b.dbChecksum)
    } finally {
      rmSync(outA, { recursive: true, force: true })
      rmSync(outB, { recursive: true, force: true })
    }
  })

  // Regression for the determinism break that shipped once the 266k SF
  // Symbol renders were staged: the full snapshot CLONES resources into a
  // temp tree before archiving, and a cross-filesystem clone falls back to
  // a copy that re-stamps mtimes with the current time — so the dist/ and
  // dist-check/ builds disagreed on the cloned members even though the
  // bytes matched. The build must clamp EVERY staged file's mtime, making
  // the archive independent of the source files' mtimes. We prove that by
  // changing a staged source file's mtime between two builds of the same
  // tag and asserting the archives stay bit-identical.
  test('archive bytes are independent of staged source mtimes', async () => {
    const symBase = join(dataDir, 'resources', 'symbols', 'public', 'bold-large')
    mkdirSync(symBase, { recursive: true })
    const svg = join(symBase, 'heart.svg')
    writeFileSync(svg, '<svg/>')

    const outA = mkdtempSync(join(tmpdir(), 'apple-docs-mt-a-'))
    const outB = mkdtempSync(join(tmpdir(), 'apple-docs-mt-b-'))
    try {
      utimesSync(svg, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
      const a = await snapshotBuild({ out: outA, tag: 'snapshot-20260517' }, { db, dataDir, logger })

      // Simulate the clone re-stamping the staged file on the second build.
      utimesSync(svg, new Date('2024-06-06T12:34:56Z'), new Date('2024-06-06T12:34:56Z'))
      const b = await snapshotBuild({ out: outB, tag: 'snapshot-20260517' }, { db, dataDir, logger })

      expect(a.archiveChecksum).toBe(b.archiveChecksum)
    } finally {
      rmSync(outA, { recursive: true, force: true })
      rmSync(outB, { recursive: true, force: true })
    }
  })

  test('lean build omits markdown and raw-json from the archive', async () => {
    // Stage payloads that the lean snapshot must NOT ship.
    mkdirSync(join(dataDir, 'markdown', 'swiftui'), { recursive: true })
    writeFileSync(join(dataDir, 'markdown', 'swiftui', 'view.md'), '# View')
    mkdirSync(join(dataDir, 'raw-json', 'swiftui'), { recursive: true })
    writeFileSync(join(dataDir, 'raw-json', 'swiftui', 'view.json'), '{}')

    const result = await snapshotBuild({ out: outDir, tag: 'test-lean' }, { db, dataDir, logger })

    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-lean-'))
    try {
      await extractTarZst(result.archivePath, extractDir)
      expect(existsSync(join(extractDir, 'markdown'))).toBe(false)
      expect(existsSync(join(extractDir, 'raw-json'))).toBe(false)
      expect(existsSync(join(extractDir, 'apple-docs.db'))).toBe(true)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('ships ADMX instead of onnx for the default model (F4, Stage C)', async () => {
    const modelBase = join(dataDir, 'resources', 'models', 'minishlab', 'potion-retrieval-32M')
    mkdirSync(join(modelBase, 'onnx'), { recursive: true })
    writeFileSync(join(modelBase, 'tokenizer.json'), '{}')
    writeFileSync(join(modelBase, 'tokenizer_config.json'), '{}')
    writeFileSync(join(modelBase, 'onnx', 'model.onnx'), 'ONNX-BYTES')
    writeFileSync(join(modelBase, 'matrix-v1.admx'), 'ADMX-BYTES')
    writeFileSync(join(modelBase, 'matrix-v1.admx.sha256'), 'abc\n')

    const result = await snapshotBuild({ out: outDir, tag: 'test-model' }, { db, dataDir, logger })
    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-model-'))
    try {
      await extractTarZst(result.archivePath, extractDir)
      const shipped = join(extractDir, 'resources', 'models', 'minishlab', 'potion-retrieval-32M')
      expect(existsSync(join(shipped, 'tokenizer.json'))).toBe(true)
      expect(existsSync(join(shipped, 'matrix-v1.admx'))).toBe(true)
      expect(existsSync(join(shipped, 'matrix-v1.admx.sha256'))).toBe(true)
      expect(existsSync(join(shipped, 'onnx'))).toBe(false) // the kill
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('hard-fails when the default model dir lacks the ADMX artifact', async () => {
    const modelBase = join(dataDir, 'resources', 'models', 'minishlab', 'potion-retrieval-32M')
    mkdirSync(join(modelBase, 'onnx'), { recursive: true })
    writeFileSync(join(modelBase, 'tokenizer.json'), '{}')
    writeFileSync(join(modelBase, 'onnx', 'model.onnx'), 'ONNX-BYTES')
    await expect(snapshotBuild({ out: outDir, tag: 'test-noadmx' }, { db, dataDir, logger })).rejects.toThrow(
      /matrix-v1\.admx missing/,
    )
  })

  test('gated feature-extraction models keep their onnx (scope guard)', async () => {
    const prev = process.env.APPLE_DOCS_EMBED_MODEL
    process.env.APPLE_DOCS_EMBED_MODEL = 'bge-small-en-v1.5'
    const modelBase = join(dataDir, 'resources', 'models', 'Xenova', 'bge-small-en-v1.5')
    mkdirSync(join(modelBase, 'onnx'), { recursive: true })
    writeFileSync(join(modelBase, 'tokenizer.json'), '{}')
    writeFileSync(join(modelBase, 'onnx', 'model.onnx'), 'GATED-ONNX')
    try {
      const result = await snapshotBuild({ out: outDir, tag: 'test-gated' }, { db, dataDir, logger })
      const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-gated-'))
      try {
        await extractTarZst(result.archivePath, extractDir)
        const shipped = join(extractDir, 'resources', 'models', 'Xenova', 'bge-small-en-v1.5')
        expect(existsSync(join(shipped, 'onnx', 'model.onnx'))).toBe(true)
      } finally {
        rmSync(extractDir, { recursive: true, force: true })
      }
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_EMBED_MODEL
      else process.env.APPLE_DOCS_EMBED_MODEL = prev
    }
  })

  test('embeds raw payloads (zstd) into the snapshot DB, not as loose files', async () => {
    mkdirSync(join(dataDir, 'raw-json', 'swiftui'), { recursive: true })
    const payload = '{"metadata":{"title":"View"},"k":1}'
    writeFileSync(join(dataDir, 'raw-json', 'swiftui', 'view.json'), payload)

    const result = await snapshotBuild({ out: outDir, tag: 'test-rawembed' }, { db, dataDir, logger })
    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-rawembed-'))
    try {
      await extractTarZst(result.archivePath, extractDir)
      expect(existsSync(join(extractDir, 'raw-json'))).toBe(false)
      const edb = new DocsDatabase(join(extractDir, 'apple-docs.db'))
      try {
        expect(edb.getRawCount()).toBeGreaterThanOrEqual(1)
        expect(edb.getRawPayloadByKey('swiftui/view')).toBe(payload)
      } finally {
        edb.close()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  test('strips semantic vectors, chunks, and embed meta from the artifact DB', async () => {
    // A vectored source DB (an operator's live corpus) must still produce a
    // lean artifact: setup rebuilds the semantic index locally.
    await indexEmbeddings({ full: true, embedder: topicEmbedder() }, { db, dataDir, logger })
    expect(db.getChunkCount()).toBeGreaterThan(0)
    expect(db.getVectorCount()).toBeGreaterThan(0)
    db.setSnapshotMeta('embed_version', '2') // fakes don't stamp; the strip must cover it

    const result = await snapshotBuild({ out: outDir, tag: 'test-strip' }, { db, dataDir, logger })
    const extractDir = mkdtempSync(join(tmpdir(), 'apple-docs-extract-strip-'))
    try {
      await extractTarZst(result.archivePath, extractDir)
      const edb = new DocsDatabase(join(extractDir, 'apple-docs.db'))
      try {
        expect(edb.getChunkCount()).toBe(0)
        expect(edb.getVectorCount()).toBe(0)
        expect(edb.getSnapshotMeta('embed_dims')).toBeFalsy()
        expect(edb.getSnapshotMeta('embed_model')).toBeFalsy()
        expect(edb.getSnapshotMeta('embed_version')).toBeFalsy()
      } finally {
        edb.close()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

})
