import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { SnapshotIncompleteError } from '../lib/errors.js'
import { sha256 } from '../lib/hash.js'
import { validateSymbolMatrixComplete } from '../resources/apple-symbols/validate.js'
import { ensureDir, writeJSON } from '../storage/files.js'

// Operational tables are truncated rather than dropped — DocsDatabase
// reopens them at first run and crashes if they're missing entirely.
const OPERATIONAL_TRUNCATE = ['crawl_state', 'activity', 'update_log']

// `snapshot_tier` retained as a metadata key for forward compatibility
// and so old consumers that still inspect it see a sane value. The
// previous lite/standard tiers are gone — every snapshot ships the
// complete corpus + the full SF Symbols pre-render matrix + raw JSON +
// markdown + extracted fonts.
const SNAPSHOT_TIER = 'full'

/**
 * Build a snapshot archive from the current corpus.
 *
 * The lite/standard tiers were removed in commit (G.1). Every snapshot
 * now ships the same payload — the full corpus, every pre-rendered SF
 * Symbol variant, raw JSON, markdown, and the extracted Apple fonts.
 * The single tier rules out half-broken consumer experiences (lite
 * snapshots couldn't live-render symbols off-macOS, standard had a
 * partial story for raw JSON), and the audits flagged tier-aware code
 * paths as a maintenance tax with no proportional value.
 *
 * @param {{ out?: string, tag?: string, allowIncompleteSymbols?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function snapshotBuild(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const outDir = opts.out ?? 'dist'
  const tag = opts.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  // A22: tag is interpolated into archive / checksum / manifest filenames.
  // Without a strict allowlist, a tag like `../../etc/passwd` or one
  // containing shell-significant characters would land outside `outDir`.
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

    // 7. Create tar.gz archive — DB + manifest + the full asset set.
    ensureDir(outDir)
    const archiveName = `apple-docs-${SNAPSHOT_TIER}-${tag}.tar.gz`
    const archivePath = join(outDir, archiveName)

    const tarArgs = ['-czf', archivePath, '-C', buildDir, 'apple-docs.db', 'manifest.json']

    // SF Symbol pre-renders. Required for snapshot consumers without
    // the macOS SF Symbols system bundle — the runtime cannot live-
    // render off-macOS, so the matrix has to ride along. F.3b: refuse
    // to ship a partial matrix without --allow-incomplete-symbols.
    const symbolsDir = join(dataDir, 'resources', 'symbols')
    if (existsSync(symbolsDir)) {
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
      tarArgs.push('-C', dataDir, 'resources/symbols')
    }

    // Raw DocC JSON, rendered Markdown, extracted Apple fonts. These
    // make the snapshot a contributor-ready handoff: a fresh clone +
    // setup gives you everything needed to rebuild without re-syncing
    // from Apple's APIs.
    const rawJsonDir = join(dataDir, 'raw-json')
    const markdownDir = join(dataDir, 'markdown')
    const fontsExtractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
    if (existsSync(rawJsonDir)) tarArgs.push('-C', dataDir, 'raw-json')
    if (existsSync(markdownDir)) tarArgs.push('-C', dataDir, 'markdown')
    if (existsSync(fontsExtractedDir)) tarArgs.push('-C', dataDir, 'resources/fonts/extracted')

    const proc = Bun.spawn(['tar', ...tarArgs], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`tar failed (exit ${exitCode}): ${stderr}`)
    }

    const archiveBytes = await Bun.file(archivePath).arrayBuffer()
    const archiveSize = archiveBytes.byteLength
    const archiveChecksum = sha256(new Uint8Array(archiveBytes))
    manifest.archiveSize = archiveSize
    manifest.archiveChecksum = archiveChecksum

    // 8. Write checksum file (archive checksum for download verification)
    const checksumName = `apple-docs-${SNAPSHOT_TIER}-${tag}.sha256`
    await Bun.write(join(outDir, checksumName), `${archiveChecksum}  ${archiveName}\n`)

    // Also write manifest to output dir
    await writeJSON(join(outDir, `apple-docs-${SNAPSHOT_TIER}-${tag}.manifest.json`), manifest)

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
      checksumPath: join(outDir, checksumName),
      manifestPath: join(outDir, `apple-docs-${SNAPSHOT_TIER}-${tag}.manifest.json`),
    }
  } finally {
    // Cleanup build directory
    rmSync(buildDir, { recursive: true, force: true })
  }
}
