import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { SnapshotIncompleteError, ValidationError } from '../lib/errors.js'
import { sha256 } from '../lib/hash.js'
import { writeSha256Sidecar } from '../lib/archive-7z.js'
import { createTarGzArchive } from '../lib/archive-targz.js'
import { validateSymbolMatrixComplete } from '../resources/apple-symbols/validate.js'
import { copyTreeFast, ensureDir, writeJSON } from '../storage/files.js'
import { encodeSectionContent } from '../storage/section-codec.js'
import { keyPath } from '../lib/safe-path.js'

// Operational tables are truncated rather than dropped — DocsDatabase
// reopens them at first run and crashes if they're missing entirely.
const OPERATIONAL_TRUNCATE = ['crawl_state', 'activity', 'update_log']

// `snapshot_tier` is kept as a metadata key so consumers that inspect
// it see a sane value. The single shape rules out half-broken consumer
// experiences (a metadata-only snapshot can't live-render symbols
// off-macOS, a partial JSON snapshot leaves the raw view incomplete).
const SNAPSHOT_TIER = 'full'

// Derive a deterministic `createdAt` ISO string from `tag`. The Sunday
// cron passes `snapshot-YYYYMMDD`; we map that to midnight UTC of the
// same day so two consecutive runs against the same tag bake identical
// bytes into `manifest.json` and `snapshot_meta.snapshot_created_at`.
// The determinism gate in .github/workflows/snapshot.yml relies on this:
// without it, the timestamp drift between the dist/ and dist-check/
// builds (~few minutes) made the full-snapshot archives diverge while
// the symbols/fonts archives (no embedded build-time data) still
// matched. Non-cron tags (test fixtures, ad-hoc dispatches) fall back
// to the Unix epoch — still stable across reruns of the same tag.
function deterministicCreatedAt(tag) {
  const m = /^snapshot-(\d{4})(\d{2})(\d{2})$/.exec(tag)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
  return '1970-01-01T00:00:00.000Z'
}

// Seconds-since-epoch counterpart of {@link deterministicCreatedAt}.
// Used to clamp the mtimes of the two freshly-written files inside
// `buildDir` (apple-docs.db, manifest.json) — `cp -c -R` already
// preserves source mtimes for everything else, and tar embeds the
// integer-seconds mtime into each member header.
function deterministicMtimeSeconds(tag) {
  const m = /^snapshot-(\d{4})(\d{2})(\d{2})$/.exec(tag)
  if (m) return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000)
  return 0
}

/**
 * Build a snapshot archive from the current corpus.
 *
 * The snapshot ships, as a single artifact: the SQLite DB (with
 * document_sections — the authoritative content — plus the raw upstream
 * payloads zstd-compressed in `document_raw` and the optional semantic
 * vectors in `document_vectors`), every pre-rendered SF Symbol variant, the
 * extracted Apple fonts, and the offline query-embedding model. Markdown and
 * loose raw-json are NEVER shipped — they are regenerable on device via
 * `storage materialize` (markdown/html from document_sections; raw-json by
 * decompressing document_raw).
 *
 * Archive pipeline: the snapshot is packaged as `.tar.gz` with `gzip -9`
 * (max DEFLATE). The .7z migration in a5a0244 traded a 2x size win for
 * 5x slower pack time; on the GH macos-26 runner (3-core M1 / 7 GB RAM)
 * the corpus outgrew the LZMA2 budget — multiple snapshot attempts
 * timed out at the 7zz spawn deadline. tar.gz finishes inside the
 * workflow time budget for the same corpus and decompresses with stock
 * `tar -xzf` everywhere, so consumers no longer need p7zip installed.
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
    throw new ValidationError(`Invalid --tag "${tag}": must match [a-z0-9._-]{1,64}`)
  }
  const schemaVersion = db.getSchemaVersion()
  const createdAt = deterministicCreatedAt(tag)

  // 1. Validate corpus health
  const stats = db.getStats()
  if (stats.totalPages === 0 && stats.totalRoots === 0) {
    throw new ValidationError('Corpus is empty. Run `apple-docs sync` first.')
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
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_created_at', createdAt])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_schema_version', String(schemaVersion)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_document_count', String(documentCount)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_page_count', String(pageCount)])

      // 4b. Embed raw upstream payloads (zstd) into the snapshot DB so the
      // single artifact carries everything; loose raw-json files are not
      // shipped. Deterministic (zstd is stable for a fixed input), preserving
      // the determinism gate. `storage materialize raw-json` unpacks them.
      const rawJsonDir = join(dataDir, 'raw-json')
      if (existsSync(rawJsonDir)) {
        // document_raw exists in copyDb already (v23 ran before the VACUUM INTO).
        const ins = copyDb.query('INSERT OR REPLACE INTO document_raw(document_id, raw) VALUES (?, ?)')
        let packed = 0
        copyDb.run('BEGIN')
        for (const d of copyDb.query('SELECT id, key FROM documents').all()) {
          const p = keyPath(dataDir, 'raw-json', d.key, '.json')
          if (!existsSync(p)) continue
          ins.run(d.id, encodeSectionContent(readFileSync(p, 'utf8')))
          packed++
        }
        copyDb.run('COMMIT')
        logger.info(`Embedded ${packed} raw payloads into the snapshot DB.`)
      }

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
      createdAt,
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
    // a deterministic .tar.gz. Staging into buildDir keeps member paths
    // in the archive flat (no `dataDir`-leak / no `../` games) and lets
    // the archive helper sort the entire tree as one input.
    //
    // `copyTreeFast` uses APFS `clonefile(2)` on macOS so the ~946k file
    // entries (most of them being SF Symbol pre-renders) materialise in
    // seconds via copy-on-write extent sharing. The previous `cpSync`
    // path read+wrote every byte once, which on the GH macos-26 runner
    // alone took 15-20 minutes before compression could start.
    //
    // Layout inside the archive:
    //   apple-docs.db
    //   manifest.json
    //   resources/symbols/...
    //   resources/fonts/extracted/...
    if (includeSymbols) {
      copyTreeFast(symbolsDir, join(buildDir, 'resources', 'symbols'))
    }
    // Markdown/HTML are never staged — they're regenerable from
    // document_sections on device (`storage materialize`). raw-json (Apple's
    // upstream payloads) is shipped compressed inside the DB (see F2) and
    // unpacked on demand, not staged here as loose files.
    const fontsExtractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
    if (existsSync(fontsExtractedDir)) {
      copyTreeFast(fontsExtractedDir, join(buildDir, 'resources', 'fonts', 'extracted'))
    }
    // Offline query-embedding model (q8 ONNX, ~23 MB). Ships so a fresh
    // install runs the semantic tier with no network. Absent → tier dormant
    // (lexical-only). Static files → deterministic.
    const modelsDir = join(dataDir, 'resources', 'models')
    if (existsSync(modelsDir)) {
      copyTreeFast(modelsDir, join(buildDir, 'resources', 'models'))
    }

    ensureDir(outDir)
    const archiveName = `apple-docs-${SNAPSHOT_TIER}-${tag}.tar.gz`
    const archivePath = join(outDir, archiveName)

    // Clamp the mtimes of the two files we just wrote into `buildDir`
    // to a tag-derived constant. `cp -c -R` (clonefile) already preserves
    // source mtimes for every staged corpus file, so those are stable
    // across reruns of the same corpus; manifest.json and apple-docs.db
    // are the only fresh writes, and tar embeds their integer-seconds
    // mtimes into the archive header. Without this step the dist/ and
    // dist-check/ builds disagree on those two members even though the
    // file contents are identical.
    const stableMtime = deterministicMtimeSeconds(tag)
    utimesSync(copyPath, stableMtime, stableMtime)
    utimesSync(join(buildDir, 'manifest.json'), stableMtime, stableMtime)

    await createTarGzArchive({
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

    // 8. Sidecar checksum (the .tar.gz.sha256 file used for download verification).
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
