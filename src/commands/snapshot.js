import { join, } from 'node:path'
import { existsSync, } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { sha256 } from '../lib/hash.js'
import { ensureDir, writeJSON } from '../storage/files.js'

const LITE_DROP = [
  'document_sections',
  'documents_body_fts',
  'documents_body_fts_config',
  'documents_body_fts_content',
  'documents_body_fts_data',
  'documents_body_fts_docsize',
  'documents_body_fts_idx',
  'documents_trigram',
  'documents_trigram_config',
  'documents_trigram_content',
  'documents_trigram_data',
  'documents_trigram_docsize',
  'documents_trigram_idx',
  'pages_body_fts',
  'pages_body_fts_config',
  'pages_body_fts_content',
  'pages_body_fts_data',
  'pages_body_fts_docsize',
  'pages_body_fts_idx',
]

const OPERATIONAL_TRUNCATE = [
  'crawl_state',
  'activity',
  'update_log',
]

/**
 * Build a snapshot archive from the current corpus.
 *
 * @param {{ tier?: string, out?: string, tag?: string }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function snapshotBuild(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const tier = opts.tier ?? 'full'
  const outDir = opts.out ?? 'dist'
  const tag = opts.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  // A22: tag is interpolated into archive / checksum / manifest filenames.
  // Without a strict allowlist, a tag like `../../etc/passwd` or one
  // containing shell-significant characters would land outside `outDir`.
  // The format we accept matches valid filename stems on every fs we
  // ship to (including SMB/NTFS mounts via Caddy mirroring).
  if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
    throw new Error(`Invalid --tag "${tag}": must match [a-z0-9._-]{1,64}`)
  }
  const schemaVersion = db.getSchemaVersion()

  if (!['lite', 'standard', 'full'].includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Must be one of: lite, standard, full`)
  }

  // 1. Validate corpus health
  const stats = db.getStats()
  if (stats.totalPages === 0 && stats.totalRoots === 0) {
    throw new Error('Corpus is empty. Run `apple-docs sync` first.')
  }

  logger.info(`Building ${tier} snapshot (tag: ${tag})...`)

  // 2. Copy database via VACUUM INTO (avoids WAL issues)
  const buildDir = mkdtempSync(join(tmpdir(), 'apple-docs-snapshot-'))
  const copyPath = join(buildDir, 'apple-docs.db')

  try {
    db.db.run(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`)

    // 3. Strip per tier
    const copyDb = new Database(copyPath)
    let documentCount = 0
    try {
      const tablesToDrop = tier === 'lite' ? [...LITE_DROP] : []

      for (const table of tablesToDrop) {
        copyDb.run(`DROP TABLE IF EXISTS ${table}`)
      }

      // Truncate operational tables (keep schema so DocsDatabase can open)
      for (const table of OPERATIONAL_TRUNCATE) {
        copyDb.run(`DELETE FROM ${table}`)
      }

      // Drop triggers that reference removed tables
      if (tier === 'lite') {
        copyDb.run('DROP TRIGGER IF EXISTS documents_ai')
        copyDb.run('DROP TRIGGER IF EXISTS documents_ad')
        copyDb.run('DROP TRIGGER IF EXISTS documents_au')
      }

      // 4. Write snapshot_meta
      documentCount = copyDb.query('SELECT COUNT(*) as c FROM documents').get().c
      const pageCount = copyDb.query("SELECT COUNT(*) as c FROM pages WHERE status = 'active'").get().c

      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_version', tag])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_tier', tier])
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
      tier,
      createdAt: new Date().toISOString(),
      documentCount,
      dbChecksum,
      dbSize,
    }

    await writeJSON(join(buildDir, 'manifest.json'), manifest)

    // 7. Create tar.gz archive
    ensureDir(outDir)
    const archiveName = `apple-docs-${tier}-${tag}.tar.gz`
    const archivePath = join(outDir, archiveName)

    const tarArgs = ['-czf', archivePath, '-C', buildDir, 'apple-docs.db', 'manifest.json']

    // For full tier, include raw-json, markdown, and the typography/symbols
    // resource directories. The latter let users skip the long `apple-docs
    // fonts sync --download` and `apple-docs symbols render` steps after a
    // setup — they extract straight into the same `~/.apple-docs/resources/...`
    // path the runtime expects.
    if (tier === 'full') {
      const rawJsonDir = join(dataDir, 'raw-json')
      const markdownDir = join(dataDir, 'markdown')
      const symbolsDir = join(dataDir, 'resources', 'symbols')
      const fontsExtractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
      if (existsSync(rawJsonDir)) {
        tarArgs.push('-C', dataDir, 'raw-json')
      }
      if (existsSync(markdownDir)) {
        tarArgs.push('-C', dataDir, 'markdown')
      }
      if (existsSync(symbolsDir)) {
        tarArgs.push('-C', dataDir, 'resources/symbols')
      }
      if (existsSync(fontsExtractedDir)) {
        tarArgs.push('-C', dataDir, 'resources/fonts/extracted')
      }
    }

    const proc = Bun.spawn(['tar', ...tarArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
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
    const checksumName = `apple-docs-${tier}-${tag}.sha256`
    await Bun.write(join(outDir, checksumName), `${archiveChecksum}  ${archiveName}\n`)

    // Also write manifest to output dir
    await writeJSON(join(outDir, `apple-docs-${tier}-${tag}.manifest.json`), manifest)

    logger.info(`Snapshot built: ${archivePath} (${(archiveSize / 1e6).toFixed(1)} MB)`)

    return {
      tier,
      tag,
      documentCount: manifest.documentCount,
      dbSize,
      dbChecksum,
      archiveChecksum,
      archivePath,
      archiveSize,
      checksumPath: join(outDir, checksumName),
      manifestPath: join(outDir, `apple-docs-${tier}-${tag}.manifest.json`),
    }
  } finally {
    // Cleanup build directory
    rmSync(buildDir, { recursive: true, force: true })
  }
}
