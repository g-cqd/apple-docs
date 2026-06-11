import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { HttpError, NotFoundError, ValidationError } from '../lib/errors.js'
import { sha256File } from '../lib/hash.js'
import { spawnWithDeadline } from '../lib/spawn-with-deadline.js'
import { resolveSevenZipBinary } from '../lib/archive-7z.js'
import { ensureDir } from '../storage/files.js'
import { DocsDatabase } from '../storage/database.js'
import { syncAppleFonts, syncSfSymbols } from '../resources/apple-assets.js'
import { validateArchive, validate7zArchive, validateZstArchive } from './setup/validate-archive.js'
import { installFromLocalArchive } from './setup/local-archive.js'
import {
  extractTarZst,
  fetchLatestRelease,
  formatSize,
  USER_AGENT,
} from './setup/helpers.js'
import { getProfile, setProfile } from '../storage/profiles.js'
import { resolveStorageProfile } from './setup/profile.js'

// Snapshot asset filename component — every snapshot ships the full
// payload, so this is fixed.
const SNAPSHOT_TIER = 'full'

// setup: install a pre-built snapshot from GitHub releases (default) or
// a local --archive path. Both routes converge on
// validateArchive → tar extract → post-install resource re-index.
// Local archives verify a sibling .sha256 when present, warn when absent.
export async function setup(opts, ctx) {
  const { db } = ctx
  const force = opts.force ?? false

  const stats = db.getStats()
  if (stats.totalPages > 0 && !force) {
    // `setup --native` on an existing install fetches just the native
    // bundle for the release the channel resolves — no corpus touch.
    let native
    if (opts.native) {
      const channel = opts.beta ? 'beta' : 'stable'
      let localBuildMacos = null
      if (channel === 'beta') {
        try { localBuildMacos = db.getSnapshotMeta('build_macos') ?? null } catch {}
      }
      const release = await fetchLatestRelease({ channel, localBuildMacos })
      const { installNativeBundle } = await import('./setup/native.js')
      native = await installNativeBundle(release, { logger: ctx.logger })
    }
    return {
      status: 'exists',
      dataDir: ctx.dataDir,
      pages: stats.totalPages,
      ...(native ? { native: native.status } : {}),
    }
  }

  if (opts.archive) {
    return installFromLocalArchive(ctx, opts, { extractAndIndex, snapshotTier: SNAPSHOT_TIER })
  }
  return installFromGithubRelease(ctx, opts)
}

// Local-archive installs live in setup/local-archive.js; extractAndIndex
// is injected so the shared pipeline stays defined in one place here.

/**
 * Install from the latest GitHub release.
 * Pulled out of the previous monolithic setup() so the local-archive
 * path can short-circuit before any network call.
 */
async function installFromGithubRelease(ctx, opts) {
  const { db, dataDir, logger } = ctx

  // Beta installs refuse to regress to a stable built on an older macOS
  // (the snapshot inherits the builder's SF Symbols catalog) — the
  // installed corpus carries its build-host version in snapshot_meta.
  const channel = opts.beta ? 'beta' : 'stable'
  let localBuildMacos = null
  if (channel === 'beta') {
    try { localBuildMacos = db.getSnapshotMeta('build_macos') ?? null } catch {}
  }
  logger.info(channel === 'beta' ? 'Fetching latest release (beta channel)...' : 'Fetching latest release...')
  const release = await fetchLatestRelease({ channel, localBuildMacos })
  logger.info(`Found release: ${release.tag} (${release.date})${release.prerelease ? ' [beta]' : ''}`)

  // Prefer `.tar.zst` (current format — zstd -9 is faster to build and
  // smaller than gzip -9, decompressed in-process via Bun's native zstd so
  // no system zstd is needed). Accept `.tar.gz` then legacy `.7z` so a host
  // pulling an older release still installs.
  const findAsset = ext => release.assets.find(a => a.name.includes(`-${SNAPSHOT_TIER}-`) && a.name.endsWith(ext))
  const archiveAsset = findAsset('.tar.zst') ?? findAsset('.tar.gz') ?? findAsset('.7z')
  if (!archiveAsset) {
    throw new NotFoundError(`release/${release.tag}`, `No snapshot found in release ${release.tag}. Available: ${release.assets.map(a => a.name).join(', ')}`)
  }
  const isSevenZip = archiveAsset.name.endsWith('.7z')

  // Checksum is mandatory on the release path. Skipping verification when the
  // .sha256 sidecar is missing is a supply-chain hole: a compromised release
  // flow could omit the sidecar and still ship arbitrary bytes.
  const expectedSidecar = `${archiveAsset.name}.sha256`
  const checksumAsset = release.assets.find(a => a.name === expectedSidecar)
    // Legacy shape: `<base>.sha256` (no double extension). Accept on the
    // tar.gz path only.
    ?? (isSevenZip
      ? null
      : release.assets.find(a => a.name.includes(`-${SNAPSHOT_TIER}-`) && a.name.endsWith('.sha256')))
  if (!checksumAsset) {
    throw new ValidationError(
      `Refusing to install: release ${release.tag} ships ${archiveAsset.name} without a matching .sha256 sidecar. ` +
      'Snapshot integrity cannot be verified.',
      { field: 'checksum' },
    )
  }

  // Keep the real extension on the temp file so extractAndIndex detects the
  // format the same way the local-archive path does.
  const tmpExt = isSevenZip ? '.7z' : (archiveAsset.name.endsWith('.tar.zst') ? '.tar.zst' : '.tar.gz')
  const tmpPath = join(dataDir, `.setup-download${tmpExt}`)
  ensureDir(dataDir)

  try {
    logger.info(`Downloading ${archiveAsset.name} (${formatSize(archiveAsset.size)})...`)
    const archiveRes = await fetch(archiveAsset.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
      redirect: 'follow',
    })
    if (!archiveRes.ok) throw new HttpError(archiveRes.status, archiveAsset.browser_download_url, `Download failed: HTTP ${archiveRes.status}`)
    if (!archiveRes.body) throw new HttpError(0, archiveAsset.browser_download_url, 'Download failed: response has no body')
    // Stream to disk via an explicit reader loop. Bun.write(path, response)
    // hangs on large responses behind HTTP/2 redirects (e.g. GitHub release
    // asset downloads), so pull chunks manually and feed a FileSink.
    const sink = Bun.file(tmpPath).writer()
    const reader = archiveRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sink.write(value)
      }
    } finally {
      await sink.end()
    }
    logger.info('Download complete.')

    logger.info('Verifying checksum...')
    const checksumRes = await fetch(checksumAsset.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    })
    if (!checksumRes.ok) throw new HttpError(checksumRes.status, checksumAsset.browser_download_url, `Checksum download failed: HTTP ${checksumRes.status}`)
    const checksumText = await checksumRes.text()
    const expectedHash = checksumText.trim().split(/\s+/)[0]
    const actualHash = await sha256File(tmpPath) // streamed: full-corpus archives are multi-GB
    if (actualHash !== expectedHash) {
      throw new ValidationError(`Checksum mismatch! Expected ${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`, { field: 'checksum' })
    }
    logger.info('Checksum verified.')

    const result = await extractAndIndex(ctx, tmpPath, { skipResources: opts.skipResources, skipSemantic: opts.skipSemantic, embedder: opts.embedder, tag: release.tag, profile: opts.profile, yes: opts.yes })
    let native
    if (opts.native) {
      const { installNativeBundle } = await import('./setup/native.js')
      native = await installNativeBundle(release, { logger })
    }
    return {
      status: 'ok',
      source: 'github-release',
      tag: release.tag,
      tier: SNAPSHOT_TIER,
      documentCount: result.documentCount,
      schemaVersion: result.schemaVersion,
      storageProfile: result.storageProfile,
      ...(native ? { native: native.status } : {}),
      dataDir,
    }
  } finally {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true })
  }
}

/**
 * Shared post-archive flow used by both install sources:
 *   1. tar-member validator (rejects symlinks, traversal, etc.).
 *   2. Close the live DB, wipe per-install paths, extract.
 *   3. Open the extracted DB, optionally re-index fonts + symbols.
 *   4. Record snapshot install metadata.
 *
 * Source-specific concerns (network fetch, sidecar discovery, manifest
 * parsing) stay in the calling function.
 */
async function extractAndIndex(ctx, archivePath, { skipResources, skipSemantic, embedder, tag = null, profile = null, yes = false } = {}) {
  const { db, dataDir, logger } = ctx
  const dbPath = join(dataDir, 'apple-docs.db')
  const isSevenZip = archivePath.endsWith('.7z')
  const isZst = archivePath.endsWith('.tar.zst')

  // Native 7z requires p7zip on PATH. Fail early with an install hint
  // instead of letting Bun.spawn surface a `ENOENT 7zz` later.
  if (isSevenZip) {
    try {
      resolveSevenZipBinary()
    } catch (err) {
      throw new ValidationError(
        `${err.message}\nThe snapshot is shipped as a .7z archive; p7zip is required to install it.`,
      )
    }
  }

  logger.info('Validating archive members...')
  const validation = isSevenZip
    ? await validate7zArchive(archivePath, dataDir)
    : isZst
      ? await validateZstArchive(archivePath, dataDir)
      : await validateArchive(archivePath, dataDir)
  logger.info(`Archive validated (${validation.entries.length} entries).`)

  // Preserve the operator's storage profile across a re-install (snapshot
  // swap). The new snapshot DB doesn't carry a storage_profile, so without
  // this a `--force` deploy would silently reset a prebuilt host to the
  // default. Only inherit when there's an existing corpus (a true re-install);
  // a fresh install still prompts / defaults. An explicit --profile wins.
  let priorProfile = null
  try {
    if (db.getStats().totalPages > 0) priorProfile = getProfile(db)
  } catch { /* fresh or unreadable db — no profile to inherit */ }

  db.close()

  // Remove old extracted payloads before installing the fresh snapshot.
  // Stale markdown / raw-json / pre-rendered symbols from an older release
  // should not leak into the new corpus.
  const installPaths = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    join(dataDir, 'manifest.json'),
    join(dataDir, 'raw-json'),
    join(dataDir, 'markdown'),
    join(dataDir, 'resources', 'symbols'),
    join(dataDir, 'resources', 'fonts', 'extracted'),
    join(dataDir, 'resources', 'symbol-renders'),
  ]
  for (const target of installPaths) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }

  if (isSevenZip) {
    // Native 7z extract. `x` preserves paths; `-y` answers "yes" to
    // overwrite prompts (we just wiped the destination above so prompts
    // shouldn't fire, but the flag is defence-in-depth for ad-hoc reruns).
    // `-o<dir>` sets the output directory. The validator already rejected
    // anything that would escape `dataDir`, so the on-disk safety is in
    // line with the tar path.
    const binary = resolveSevenZipBinary()
    const { stderr, exitCode } = await spawnWithDeadline(
      [binary, 'x', '-y', `-o${dataDir}`, archivePath],
      { deadlineMs: 10 * 60_000 },
    )
    if (exitCode !== 0) throw new ValidationError(`Extraction failed (${binary} exit ${exitCode}): ${stderr}`)
  } else if (isZst) {
    // macOS ships no zstd and Apple's bsdtar lacks libzstd, so we can't
    // `tar --zstd`. Decompress in-process with Bun's native zstd and pipe
    // plain tar to `tar -xf -` — streaming keeps memory bounded on a
    // multi-GB archive, and needs no system zstd. Same defensive tar flags
    // as the gzip path.
    await extractTarZst(archivePath, dataDir)
  } else {
    // --no-same-owner / --no-same-permissions: defensive belts on top of
    // the pre-flight validator. Even if the validator misses a hostile
    // entry, these flags keep tar from chmod'ing / chown'ing files into a
    // privileged state. Snapshot tarballs are typically 1-3 GB; 10 min
    // deadline bounds an OS-level hang without rejecting legit big-corpus
    // extracts on slower hosts.
    const { stderr, exitCode } = await spawnWithDeadline(
      ['tar', '--no-same-owner', '--no-same-permissions', '-xzf', archivePath, '-C', dataDir],
      { deadlineMs: 10 * 60_000 },
    )
    if (exitCode !== 0) throw new ValidationError(`Extraction failed (exit ${exitCode}): ${stderr}`)
  }
  logger.info('Extracted snapshot.')

  const verifyDb = new DocsDatabase(dbPath)
  try {
    const schemaVersion = verifyDb.getSchemaVersion()
    const documentCount = verifyDb.db.query('SELECT COUNT(*) as c FROM documents').get().c

    if (skipResources !== true) {
      try {
        await syncAppleFonts({ downloadFonts: false }, { db: verifyDb, dataDir, logger })
      } catch (e) {
        logger?.warn?.(`Font index refresh skipped: ${e.message}`)
      }
      try {
        for (const scope of ['public', 'private']) {
          await syncSfSymbols({ scope }, { db: verifyDb, dataDir, logger })
        }
      } catch (e) {
        logger?.warn?.(`SF Symbols refresh skipped: ${e.message}`)
      }
    }

    if (skipSemantic !== true) {
      // Snapshots ship no vectors (GitHub asset-size headroom); the chunk
      // index is rebuilt here from the shipped sections + model, offline.
      // Any failure degrades to lexical-only search, never blocks install.
      logger.info('Building semantic search index (a few minutes; skip with --skip-semantic)…')
      try {
        const { indexEmbeddings } = await import('./index-embeddings.js')
        const sem = await indexEmbeddings({ full: true, embedder }, { db: verifyDb, dataDir, logger })
        if (sem.status !== 'ok') logger.warn(`Semantic index skipped (lexical-only): ${sem.message}`)
      } catch (e) {
        logger?.warn?.(`Semantic index build failed (search stays lexical-only): ${e.message}`)
      }
    }

    // Apply the storage profile explicitly — overrides whatever the snapshot
    // build host baked into snapshot_meta. Each non-default profile finishes
    // its shape in one step so the operator never has to chase setup with a
    // second command:
    //   prebuilt → materialize Markdown + HTML (max speed).
    //   compact  → run the full compaction (compress sections, contentless
    //              body index, drop raw payloads, VACUUM) — smallest disk.
    const storageProfile = await resolveStorageProfile({ profile: profile ?? priorProfile, yes })
    setProfile(verifyDb, storageProfile)
    if (storageProfile === 'prebuilt') {
      logger.info('Prebuilt profile — materializing markdown + HTML…')
      const { storageMaterialize } = await import('./storage.js')
      const md = await storageMaterialize({ format: 'markdown' }, { db: verifyDb, dataDir, logger })
      const html = await storageMaterialize({ format: 'html' }, { db: verifyDb, dataDir, logger })
      logger.info(`Materialized ${md.materialized} markdown + ${html.materialized} HTML documents.`)
    } else if (storageProfile === 'compact') {
      logger.info('Compact profile — compacting install (compressed sections, contentless body index, dropping raw payloads)…')
      const { storageCompact } = await import('./storage-compact.js')
      const compacted = await storageCompact({}, { db: verifyDb, dataDir, logger })
      logger.info(`Compacted: ${compacted.sectionsCompressed} sections compressed, ${compacted.rawDropped} raw payloads dropped.`)
    }

    if (tag) verifyDb.setSnapshotMeta('snapshot_tag', tag)
    verifyDb.setSnapshotMeta('snapshot_installed_at', new Date().toISOString())

    logger.info(`Setup complete! ${documentCount} documents ready (profile: ${storageProfile}).`)
    return { documentCount, schemaVersion, storageProfile }
  } finally {
    verifyDb.close()
  }
}

// resolveArchivePath, stripTarGz, fetchLatestRelease, formatSize, extractTarZst
// live in ./setup/helpers.js so this file fits under the 400-line ceiling.
