import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFilesSorted, writeSha256Sidecar } from '../lib/archive-7z.js'
import { createTarZstArchive } from '../lib/archive-native.js'
import { SnapshotIncompleteError, ValidationError } from '../lib/errors.js'
import { sha256File } from '../lib/hash.js'
import { keyPath } from '../lib/safe-path.js'
import { validateSymbolMatrixComplete } from '../resources/apple-symbols/validate.js'
import { copyTreeFast, ensureDir, writeJSON } from '../storage/files.js'
import { withFileTempStore } from '../storage/pragmas.js'
import { encodeSectionContent } from '../storage/section-codec.js'

// Operational tables are truncated rather than dropped — DocsDatabase
// reopens them at first run and crashes if they're missing entirely.
const OPERATIONAL_TRUNCATE = ['crawl_state', 'activity', 'update_log']

// Semantic vectors never ship: the per-chunk codes are ~0.5 GB of
// incompressible blobs that would eat the GitHub 2 GiB asset ceiling.
// They are regenerable offline — setup rebuilds them from the shipped
// sections + the shipped embedding model (see setup.js / --skip-semantic).
const REGENERABLE_TRUNCATE = ['document_chunks', 'document_vectors']

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
function deterministicCreatedAt(/** @type {any} */ tag) {
  const m = /^snapshot-(\d{4})(\d{2})(\d{2})$/.exec(tag)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
  return '1970-01-01T00:00:00.000Z'
}

// Seconds-since-epoch counterpart of {@link deterministicCreatedAt}.
// Used to clamp the mtimes of the two freshly-written files inside
// `buildDir` (apple-docs.db, manifest.json) — `cp -c -R` already
// preserves source mtimes for everything else, and tar embeds the
// integer-seconds mtime into each member header.
// `sw_vers -productVersion` on the build host (darwin only). Stable for
// a given host, so the determinism re-build gate is unaffected.
function buildHostMacosVersion() {
  if (process.platform !== 'darwin') return null
  try {
    const r = Bun.spawnSync(['sw_vers', '-productVersion'])
    const v = new TextDecoder().decode(r.stdout).trim()
    return /^\d+(\.\d+)*$/.test(v) ? v : null
  } catch {
    return null
  }
}

function deterministicMtimeSeconds(/** @type {any} */ tag) {
  const m = /^snapshot-(\d{4})(\d{2})(\d{2})$/.exec(tag)
  if (m) return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000)
  return 0
}

/**
 * Build a snapshot archive from the current corpus.
 *
 * The snapshot ships, as a single artifact: the SQLite DB (with
 * document_sections — the authoritative content — plus the raw upstream
 * payloads zstd-compressed in `document_raw`), every pre-rendered SF Symbol
 * variant, the extracted Apple fonts, and the offline embedding model.
 * Markdown and loose raw-json are NEVER shipped — they are regenerable on
 * device via `storage materialize`. Semantic vectors are NEVER shipped
 * either ({@link REGENERABLE_TRUNCATE}) — setup rebuilds them locally from
 * the shipped sections + model.
 *
 * Archive pipeline: the snapshot is packaged as `.tar.zst` (zstd `-9 -T3`).
 * zstd is ~15% smaller AND ~5× faster than `gzip -9` on this corpus shape and
 * multithreaded, so it fits the GH macos-26 runner (3-core M1 / 7 GB) budget
 * with headroom. macOS ships no zstd and Apple's bsdtar lacks libzstd, so
 * consumers do NOT `tar --zstd`: `apple-docs setup` decompresses with Bun's
 * built-in zstd to a temp tar and extracts that (no system zstd / p7zip
 * needed). See src/lib/archive-zstd.js.
 *
 * @param {{ out?: string, tag?: string, allowIncompleteSymbols?: boolean, embedModel?: string }} opts
 * @param {{ db: any, dataDir: any, logger: any }} ctx
 */
export async function snapshotBuild(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const outDir = opts.out ?? 'dist'
  const tag = opts.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  // A non-default embedder produces a SEPARATE artifact variant
  // (`apple-docs-full-<model>-<tag>.tar.zst`) so the default download stays
  // byte-stable and out of the transformer's determinism risk. The default
  // (potion) keeps the unsuffixed name.
  const embedModel = typeof opts.embedModel === 'string' ? opts.embedModel : null
  const modelSlug = embedModel && embedModel !== 'potion-retrieval-32M' ? `${embedModel.replace(/[^a-z0-9._-]/gi, '-')}-` : ''
  // The tag is interpolated into archive / checksum / manifest
  // filenames. Without a strict allowlist, a tag like
  // `../../etc/passwd` or one containing shell-significant characters
  // would land outside `outDir`.
  if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
    throw new ValidationError(`Invalid --tag "${tag}": must match [a-z0-9._-]{1,64}`)
  }
  const schemaVersion = db.getSchemaVersion()
  const createdAt = deterministicCreatedAt(tag)
  const buildMacos = buildHostMacosVersion()

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
    withFileTempStore(db.db, () => db.db.run(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`))

    // 3. Truncate operational tables (keep schema so DocsDatabase can open)
    const copyDb = new Database(copyPath)
    let documentCount = 0
    try {
      for (const table of [...OPERATIONAL_TRUNCATE, ...REGENERABLE_TRUNCATE]) {
        copyDb.run(`DELETE FROM ${table}`)
      }
      // Vector meta describes rows we just stripped — drop it so the
      // installed DB's embed_* meta always comes from the local build.
      copyDb.run("DELETE FROM snapshot_meta WHERE key IN ('embed_dims', 'embed_model', 'embed_version')")

      // 4. Write snapshot_meta
      documentCount = copyDb.query('SELECT COUNT(*) as c FROM documents').get().c
      const pageCount = copyDb.query("SELECT COUNT(*) as c FROM pages WHERE status = 'active'").get().c

      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_version', tag])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_tier', SNAPSHOT_TIER])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_created_at', createdAt])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_schema_version', String(schemaVersion)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_document_count', String(documentCount)])
      copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['snapshot_page_count', String(pageCount)])
      // Build-host macOS provenance: the SF Symbols catalog (CoreGlyphs)
      // is whatever the building OS ships, so a snapshot from macOS 27
      // carries symbols a macOS 26 build cannot. The beta update channel
      // compares this to avoid regressing coverage.
      if (buildMacos) {
        copyDb.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['build_macos', buildMacos])
      }

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

      // copyDb is a raw handle with no pragmas applied — be explicit so
      // the rebuild temp never lands in RAM regardless of compile defaults.
      withFileTempStore(copyDb, () => copyDb.run('VACUUM'))
    } finally {
      copyDb.close()
    }

    // 5. Compute DB checksum (streamed — the copy can be many GB)
    const dbChecksum = await sha256File(copyPath)
    const dbSize = Bun.file(copyPath).size

    // 6. Build manifest
    /** @type {Record<string, any>} */
    const manifest = {
      version: tag,
      schemaVersion,
      tier: SNAPSHOT_TIER,
      createdAt,
      documentCount,
      dbChecksum,
      dbSize,
      ...(buildMacos ? { buildMacos } : {}),
      ...(embedModel ? { embedModel } : {}),
    }

    await writeJSON(join(buildDir, 'manifest.json'), manifest)

    // SF Symbol pre-renders. Required for snapshot consumers without
    // the macOS SF Symbols system bundle — the runtime cannot live-
    // render off-macOS, so the matrix has to ride along. F.3b: refuse
    // to ship a partial matrix without --allow-incomplete-symbols.
    const symbolsDir = join(dataDir, 'resources', 'symbols')
    const includeSymbols = existsSync(symbolsDir)
    // Validate against the DB catalog ALWAYS — not only when the dir exists.
    // A populated catalog with no `resources/symbols/` means the prerender
    // step was skipped or crashed (e.g. snapshot-20260607 shipped empty after
    // a ReferenceError in prerenderSfSymbols). An empty catalog validates
    // clean. This refuses to silently ship a symbol-less snapshot.
    const validation = validateSymbolMatrixComplete(ctx)
    if (!validation.complete) {
      if (!opts.allowIncompleteSymbols) {
        const head = validation.missing.slice(0, 10).join(', ')
        throw new SnapshotIncompleteError(
          `Snapshot: ${validation.missingCount} pre-rendered SF Symbol variants missing` +
            `${includeSymbols ? '' : ' (resources/symbols is absent — the prerender step did not run)'}` +
            ` (e.g., ${head}). Run \`apple-docs sync\` to bake the missing renders, or pass --allow-incomplete-symbols to override.`,
          { missingCount: validation.missingCount, missing: validation.missing },
        )
      }
      logger.warn(`Snapshot: shipping with ${validation.missingCount} missing pre-renders (--allow-incomplete-symbols set)`)
    }

    // 7. Stage the snapshot payload into a single tree, then archive it as
    // a deterministic .tar.zst. Staging into buildDir keeps member paths
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
    // Offline query-embedding model. Ships so a fresh install runs the
    // semantic tier with no network. Absent → tier dormant (lexical-only).
    // Static files → deterministic.
    //
    // ONLY the active pinned model ships: the models dir doubles as the
    // transformers download cache (bake-off and gated-variant models land
    // there too — a cached 1.2 GB gemma once pushed a beta archive over
    // the 2 GiB GitHub asset ceiling). Gated variants build their own
    // artifacts when promoted (model-integrity.js).
    const { resolveActiveSpec } = await import('../search/embedder.js')
    const activeSpec = resolveActiveSpec()
    const activeModelDir = join(dataDir, 'resources', 'models', activeSpec.hfId)
    if (existsSync(activeModelDir)) {
      copyTreeFast(activeModelDir, join(buildDir, 'resources', 'models', activeSpec.hfId))
      // Stage C (RFC 0002 §6f): the DEFAULT model ships the deterministic
      // ADMX weights artifact INSTEAD of model.onnx (−124 MB; the native
      // embedder consumes ADMX directly, and ensureEmbeddingModel derives
      // it for older onnx-bearing snapshots). Gated feature-extraction
      // variants still need their onnx — the inversion is scoped.
      if (activeSpec.backend !== 'feature-extraction') {
        const shippedAdmx = join(buildDir, 'resources', 'models', activeSpec.hfId, 'matrix-v1.admx')
        if (!existsSync(shippedAdmx)) {
          // Neither onnx nor admx would leave the semantic tier dead for
          // every fresh install of this snapshot.
          throw new ValidationError(
            'snapshot build: matrix-v1.admx missing from the models dir — the build host must derive it (native embed / ensureEmbeddingModel) before archiving',
          )
        }
        rmSync(join(buildDir, 'resources', 'models', activeSpec.hfId, 'onnx'), { recursive: true, force: true })
      }
    }

    ensureDir(outDir)
    const archiveName = `apple-docs-${SNAPSHOT_TIER}-${modelSlug}${tag}.tar.zst`
    const archivePath = join(outDir, archiveName)

    // Clamp the mtime of EVERY staged file to a tag-derived constant so the
    // archive is byte-identical across reruns. tar embeds each member's
    // integer-seconds mtime, so any drift fails the determinism gate. We
    // can't trust the staged corpus files to keep their source mtimes:
    // `copyTreeFast` clones via `cp -c -R` (clonefile preserves mtime), but
    // a cross-filesystem or otherwise-failed clone falls back to `cpSync`,
    // which stamps the copy with the current time. That diverged the dist/
    // and dist-check/ builds once the 266k SF Symbol renders were staged —
    // the in-place symbols archive matched while the cloned full tree did
    // not. `listFilesSorted` enumerates exactly the set tar will archive.
    const stableMtime = deterministicMtimeSeconds(tag)
    for (const rel of listFilesSorted(buildDir)) {
      utimesSync(join(buildDir, rel), stableMtime, stableMtime)
    }

    await createTarZstArchive({
      sourceDir: buildDir,
      outputPath: archivePath,
      name: archiveName,
      logger,
    })

    const archiveSize = Bun.file(archivePath).size
    const archiveChecksum = await sha256File(archivePath)
    manifest.archiveSize = archiveSize
    manifest.archiveChecksum = archiveChecksum

    // 8. Sidecar checksum (the .tar.zst.sha256 file used for download verification).
    // Use the shared sidecar helper so the format matches `shasum -a 256`
    // output and aligns with the symbols / fonts archive sidecars.
    const { sidecarPath: checksumPath } = await writeSha256Sidecar(archivePath)

    // Also write manifest to output dir
    const manifestPath = join(outDir, `apple-docs-${SNAPSHOT_TIER}-${modelSlug}${tag}.manifest.json`)
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
