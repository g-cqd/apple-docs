import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { SnapshotIncompleteError } from '../lib/errors.js'
import { sha256 } from '../lib/hash.js'
import { createSevenZipArchive, writeSha256Sidecar } from '../lib/archive-7z.js'
import { validateSymbolMatrixComplete } from '../resources/apple-symbols/validate.js'
import { ensureDir, writeJSON } from '../storage/files.js'

// Operational tables are truncated rather than dropped — DocsDatabase
// reopens them at first run and crashes if they're missing entirely.
const OPERATIONAL_TRUNCATE = ['crawl_state', 'activity', 'update_log']

// `snapshot_tier` is kept as a metadata key so consumers that inspect
// it see a sane value. The single shape rules out half-broken consumer
// experiences (a metadata-only snapshot can't live-render symbols
// off-macOS, a partial JSON snapshot leaves the raw view incomplete).
const SNAPSHOT_TIER = 'full'

/**
 * Build a snapshot archive from the current corpus.
 *
 * Every snapshot ships the same payload: the full corpus, every
 * pre-rendered SF Symbol variant, raw JSON, markdown, and the extracted
 * Apple fonts. A single shape keeps the install path simple and avoids
 * tier-aware code paths.
 *
 * P2 archive pipeline (this revision): the snapshot is now packaged as a
 * native LZMA2 `.7z` instead of `.tar.gz`. Decisions and bake-off numbers:
 * docs/spikes/archive-format.md. Consumers must have `7zz` (Homebrew
 * `sevenzip`) or `7z` (Debian `p7zip-full`) on PATH; `apple-docs setup`
 * surfaces a clear error when neither is installed.
 *
 * @param {{ out?: string, tag?: string, allowIncompleteSymbols?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function snapshotBuild(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const outDir = opts.out ?? 'dist'
  const tag = opts.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  // The tag is interpolated into archive / checksum / manifest
  // filenames. Without a strict allowlist, a tag like
  // `../../etc/passwd` or one containing shell-significant characters
  // would land outside `outDir`.
  if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
    throw new Error(`Invalid --tag "${tag}": must match [a-z0-9._-]{1,64}`)
  }
  const schemaVersion = db.getSchemaVersion()

  // 1. Validate corpus health
  const stats = db.getStats()
  if (stats.totalPages === 0 && stats.totalRoots === 0) {
    throw new Error('Corpus is empty. Run `apple-docs sync` first.')
  }

  logger.info(`Building snapshot (tag: ${tag})...`)

  // 2. Copy database via VACUUM INTO (avoids WAL issues)
  const buildDir = mkdtempSync(join(tmpdir(), 'apple-docs-snapshot-'))
  const copyPath = join(buildDir, 'apple-docs.db')

  try {
    db.db.run(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`)

    // 3. Truncate operational tables (keep schema so DocsDatabase can open)
    const copyDb = new Database(copyPath)
    let documentCount = 0
    try {
      for (const table of OPERATIONAL_TRUNCATE) {
        copyDb.run(`DELETE FROM ${table}`)
      }

      // 4. Write snapshot_meta
      documentCount = copyDb.query('SELECT COUNT(*) as c FROM documents').get().c
      const pageCount = copyDb.query("SELECT COUNT(*) as c FROM pages WHERE status = 'active'").get().c

      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_version', tag])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_tier', SNAPSHOT_TIER])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_created_at', new Date().toISOString()])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_schema_version', String(schemaVersion)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_document_count', String(documentCount)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_page_count', String(pageCount)])

      copyDb.run('VACUUM')
    } finally {
      copyDb.close()
    }

    // 5. Compute DB checksum
    const dbBytes = await Bun.file(copyPath).arrayBuffer()
    const dbChecksum = sha256(new Uint8Array(dbBytes))
    const dbSize = dbBytes.byteLength

    // 6. Build manifest
    const manifest = {
      version: tag,
      schemaVersion,
      tier: SNAPSHOT_TIER,
      createdAt: new Date().toISOString(),
      documentCount,
      dbChecksum,
      dbSize,
    }

    await writeJSON(join(buildDir, 'manifest.json'), manifest)

    // SF Symbol pre-renders. Required for snapshot consumers without
    // the macOS SF Symbols system bundle — the runtime cannot live-
    // render off-macOS, so the matrix has to ride along. F.3b: refuse
    // to ship a partial matrix without --allow-incomplete-symbols.
    const symbolsDir = join(dataDir, 'resources', 'symbols')
    const includeSymbols = existsSync(symbolsDir)
    if (includeSymbols) {
      const validation = validateSymbolMatrixComplete(ctx)
      if (!validation.complete) {
        if (!opts.allowIncompleteSymbols) {
          const head = validation.missing.slice(0, 10).join(', ')
          throw new SnapshotIncompleteError(
            `Snapshot: ${validation.missingCount} pre-rendered SF Symbol variants missing (e.g., ${head}). ` +
            'Run `apple-docs sync` to bake the missing renders, or pass --allow-incomplete-symbols to override.',
            { missingCount: validation.missingCount, missing: validation.missing },
          )
        }
        logger.warn(`Snapshot: shipping with ${validation.missingCount} missing pre-renders (--allow-incomplete-symbols set)`)
      }
    }

    // 7. Stage the snapshot payload into a single tree, then archive it as
    // a deterministic .7z. Staging into buildDir keeps member paths in the
    // archive flat (no `dataDir`-leak / no `../` games) and lets the 7z
    // helper sort the entire tree as one input.
    //
    // Layout inside the archive:
    //   apple-docs.db
    //   manifest.json
    //   resources/symbols/...
    //   raw-json/...
    //   markdown/...
    //   resources/fonts/extracted/...
    if (includeSymbols) {
      cpSync(symbolsDir, join(buildDir, 'resources', 'symbols'), { recursive: true })
    }
    const rawJsonDir = join(dataDir, 'raw-json')
    if (existsSync(rawJsonDir)) {
      cpSync(rawJsonDir, join(buildDir, 'raw-json'), { recursive: true })
    }
    const markdownDir = join(dataDir, 'markdown')
    if (existsSync(markdownDir)) {
      cpSync(markdownDir, join(buildDir, 'markdown'), { recursive: true })
    }
    const fontsExtractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
    if (existsSync(fontsExtractedDir)) {
      cpSync(fontsExtractedDir, join(buildDir, 'resources', 'fonts', 'extracted'), { recursive: true })
    }

    ensureDir(outDir)
    const archiveName = `apple-docs-${SNAPSHOT_TIER}-${tag}.7z`
    const archivePath = join(outDir, archiveName)

    await createSevenZipArchive({
      sourceDir: buildDir,
      outputPath: archivePath,
      name: archiveName,
      logger,
    })

    const archiveBytes = await Bun.file(archivePath).arrayBuffer()
    const archiveSize = archiveBytes.byteLength
    const archiveChecksum = sha256(new Uint8Array(archiveBytes))
    manifest.archiveSize = archiveSize
    manifest.archiveChecksum = archiveChecksum

    // 8. Sidecar checksum (the .7z.sha256 file used for download verification).
    // Use the shared sidecar helper so the format matches `shasum -a 256`
    // output and aligns with the symbols / fonts archive sidecars.
    const { sidecarPath: checksumPath } = await writeSha256Sidecar(archivePath)

    // Also write manifest to output dir
    const manifestPath = join(outDir, `apple-docs-${SNAPSHOT_TIER}-${tag}.manifest.json`)
    await writeJSON(manifestPath, manifest)

    logger.info(`Snapshot built: ${archivePath} (${(archiveSize / 1e6).toFixed(1)} MB)`)

    return {
      tier: SNAPSHOT_TIER,
      tag,
      documentCount: manifest.documentCount,
      dbSize,
      dbChecksum,
      archiveChecksum,
      archivePath,
      archiveSize,
      archiveName,
      checksumPath,
      manifestPath,
    }
  } finally {
    // Cleanup build directory
    rmSync(buildDir, { recursive: true, force: true })
  }
}
