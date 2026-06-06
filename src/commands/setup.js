import { join } from 'node:path'
import { existsSync, rmSync, statSync } from 'node:fs'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { sha256 } from '../lib/hash.js'
import { spawnWithDeadline } from '../lib/spawn-with-deadline.js'
import { resolveSevenZipBinary } from '../lib/archive-7z.js'
import { ensureDir } from '../storage/files.js'
import { DocsDatabase } from '../storage/database.js'
import { syncAppleFonts, syncSfSymbols } from '../resources/apple-assets.js'
import { validateArchive, validate7zArchive } from './setup/validate-archive.js'
import {
  fetchLatestRelease,
  formatSize,
  resolveArchivePath,
  stripTarGz,
  USER_AGENT,
} from './setup/helpers.js'
import { setProfile, PROFILE_NAMES, DEFAULT_PROFILE } from '../storage/profiles.js'
import { promptChoice } from '../cli/prompts.js'

// Snapshot asset filename component — every snapshot ships the full
// payload, so this is fixed.
const SNAPSHOT_TIER = 'full'

/**
 * Resolve the storage profile to apply to a freshly-installed corpus:
 *   1. An explicit, valid `--profile` wins.
 *   2. On an interactive TTY (without `--yes`), prompt for the choice.
 *   3. Otherwise fall back to the default profile.
 *
 * setup applies the result explicitly on every install: a snapshot embeds
 * whatever `storage_profile` the build host had in snapshot_meta, so the
 * installer must override it rather than silently inherit the build's value.
 *
 * @param {{ profile?: string|null, yes?: boolean }} opts
 * @returns {Promise<string>} a name in PROFILE_NAMES
 */
async function resolveStorageProfile({ profile, yes }) {
  if (profile != null) {
    if (!PROFILE_NAMES.includes(profile)) {
      throw new ValidationError(
        `Unknown --profile "${profile}". Valid profiles: ${PROFILE_NAMES.join(', ')}`,
        { field: 'profile', value: profile },
      )
    }
    return profile
  }
  if (!yes && process.stdin.isTTY) {
    return promptChoice(
      'Choose a storage profile for this install:',
      [
        { label: 'Render on demand', value: 'balanced', hint: 'smallest disk; markdown rendered per request and cached' },
        { label: 'Prebuilt', value: 'prebuilt', hint: 'fastest; materializes markdown + HTML now (largest disk)' },
      ],
      { defaultIndex: 0 },
    )
  }
  return DEFAULT_PROFILE
}

// setup: install a pre-built snapshot from GitHub releases (default) or
// a local --archive path. Both routes converge on
// validateArchive → tar extract → post-install resource re-index.
// Local archives verify a sibling .sha256 when present, warn when absent.
export async function setup(opts, ctx) {
  const { db } = ctx
  const force = opts.force ?? false

  const stats = db.getStats()
  if (stats.totalPages > 0 && !force) {
    return {
      status: 'exists',
      dataDir: ctx.dataDir,
      pages: stats.totalPages,
    }
  }

  if (opts.archive) {
    return installFromLocalArchive(ctx, opts)
  }
  return installFromGithubRelease(ctx, opts)
}

/**
 * Install from a local tarball produced by `apple-docs snapshot build`.
 *
 * Sidecar files are sourced by sibling-name convention:
 *   foo.tar.gz       → archive
 *   foo.sha256       → checksum (optional; warn if missing)
 *   foo.manifest.json → metadata (optional; informational only)
 *
 * Refuses sources outside `$HOME` so a misplaced argv path can't read an
 * arbitrary system file. The tar member walker still runs, so the
 * symlink-escape protection is identical to the GitHub-release path.
 */
async function installFromLocalArchive(ctx, opts) {
  const { dataDir, logger } = ctx
  const archivePath = resolveArchivePath(opts.archive)

  if (!existsSync(archivePath)) {
    throw new NotFoundError(archivePath, `Snapshot archive not found: ${archivePath}`)
  }
  const archiveStats = statSync(archivePath)
  if (!archiveStats.isFile()) {
    throw new ValidationError(`Snapshot archive must be a regular file: ${archivePath}`, { field: 'archive', value: archivePath })
  }

  logger.info(`Installing from local archive: ${archivePath} (${formatSize(archiveStats.size)})`)

  // Sidecar discovery: full-archive-name + `.sha256` / strip-ext +
  // `.manifest.json`. This is what `apple-docs snapshot build` writes
  // for both formats — the `.sha256` sidecar always uses the FULL
  // archive name (so `foo.tar.gz.sha256` for .tar.gz, `foo.7z.sha256`
  // for legacy .7z); manifest strips the archive extension.
  const isSevenZip = archivePath.endsWith('.7z')
  const checksumPath = `${archivePath}.sha256`
  const manifestPath = isSevenZip
    ? `${archivePath.slice(0, -'.7z'.length)}.manifest.json`
    : `${stripTarGz(archivePath)}.manifest.json`
  const hasChecksum = existsSync(checksumPath)
  const hasManifest = existsSync(manifestPath)

  if (hasChecksum) {
    logger.info('Verifying checksum...')
    const checksumText = await Bun.file(checksumPath).text()
    const expectedHash = checksumText.trim().split(/\s+/)[0]
    const archiveBytes = await Bun.file(archivePath).arrayBuffer()
    const actualHash = sha256(new Uint8Array(archiveBytes))
    if (actualHash !== expectedHash) {
      throw new ValidationError(`Checksum mismatch! Expected ${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`, { field: 'checksum' })
    }
    logger.info('Checksum verified.')
  } else {
    logger.warn(`No .sha256 sidecar at ${checksumPath} — proceeding without checksum verification`)
  }

  let manifestTag = 'local'
  if (hasManifest) {
    try {
      const manifest = await Bun.file(manifestPath).json()
      // snapshot.js writes `version` (= tag) — accept both shapes so a
      // future rename doesn't silently fall through to 'local'.
      manifestTag = manifest?.tag ?? manifest?.version ?? manifestTag
      const ts = manifest?.createdAt ?? manifest?.builtAt ?? 'unknown'
      logger.info(`Manifest: tag=${manifestTag} built=${ts} docs=${manifest?.documentCount ?? '?'}`)
    } catch (err) {
      logger.warn(`Manifest at ${manifestPath} present but unreadable: ${err.message}`)
    }
  }

  const result = await extractAndIndex(ctx, archivePath, { skipResources: opts.skipResources, profile: opts.profile, yes: opts.yes })
  return {
    status: 'ok',
    source: 'local-archive',
    archive: archivePath,
    tag: manifestTag,
    tier: SNAPSHOT_TIER,
    documentCount: result.documentCount,
    schemaVersion: result.schemaVersion,
    storageProfile: result.storageProfile,
    dataDir,
  }
}

/**
 * Install from the latest GitHub release.
 * Pulled out of the previous monolithic setup() so the local-archive
 * path can short-circuit before any network call.
 */
async function installFromGithubRelease(ctx, opts) {
  const { dataDir, logger } = ctx

  logger.info('Fetching latest release...')
  const release = await fetchLatestRelease()
  logger.info(`Found release: ${release.tag} (${release.date})`)

  // Prefer `.tar.gz` (current format after the format recalibration — LZMA2 .7z didn't
  // fit the GH runner's compression budget once the corpus grew past
  // ~1M file entries). Accept `.7z` as a transitional fallback so a
  // host pulling the very last .7z release before the format flip still
  // installs (provided p7zip is on PATH).
  const archiveAsset =
    release.assets.find(a => a.name.includes(`-${SNAPSHOT_TIER}-`) && a.name.endsWith('.tar.gz')) ??
    release.assets.find(a => a.name.includes(`-${SNAPSHOT_TIER}-`) && a.name.endsWith('.7z'))
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

  const tmpPath = join(dataDir, isSevenZip ? '.setup-download.7z' : '.setup-download.tar.gz')
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
    const archiveBytes = await Bun.file(tmpPath).arrayBuffer()
    const actualHash = sha256(new Uint8Array(archiveBytes))
    if (actualHash !== expectedHash) {
      throw new ValidationError(`Checksum mismatch! Expected ${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`, { field: 'checksum' })
    }
    logger.info('Checksum verified.')

    const result = await extractAndIndex(ctx, tmpPath, { skipResources: opts.skipResources, tag: release.tag, profile: opts.profile, yes: opts.yes })
    return {
      status: 'ok',
      source: 'github-release',
      tag: release.tag,
      tier: SNAPSHOT_TIER,
      documentCount: result.documentCount,
      schemaVersion: result.schemaVersion,
      storageProfile: result.storageProfile,
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
async function extractAndIndex(ctx, archivePath, { skipResources, tag = null, profile = null, yes = false } = {}) {
  const { db, dataDir, logger } = ctx
  const dbPath = join(dataDir, 'apple-docs.db')
  const isSevenZip = archivePath.endsWith('.7z')

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
    : await validateArchive(archivePath, dataDir)
  logger.info(`Archive validated (${validation.entries.length} entries).`)

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

    // Apply the storage profile explicitly — overrides whatever the snapshot
    // build host baked into snapshot_meta. Prebuilt materializes the fast
    // artifacts locally so the shipped (compact) snapshot can still serve a
    // max-speed instance.
    const storageProfile = await resolveStorageProfile({ profile, yes })
    setProfile(verifyDb, storageProfile)
    if (storageProfile === 'prebuilt') {
      logger.info('Prebuilt profile — materializing markdown + HTML…')
      const { storageMaterialize } = await import('./storage.js')
      const md = await storageMaterialize({ format: 'markdown' }, { db: verifyDb, dataDir, logger })
      const html = await storageMaterialize({ format: 'html' }, { db: verifyDb, dataDir, logger })
      logger.info(`Materialized ${md.materialized} markdown + ${html.materialized} HTML documents.`)
    }

    if (tag) verifyDb.setSnapshotMeta('snapshot_tag', tag)
    verifyDb.setSnapshotMeta('snapshot_installed_at', new Date().toISOString())

    logger.info(`Setup complete! ${documentCount} documents ready (profile: ${storageProfile}).`)
    return { documentCount, schemaVersion, storageProfile }
  } finally {
    verifyDb.close()
  }
}

// resolveArchivePath, stripTarGz, fetchLatestRelease, formatSize live
// in ./setup/helpers.js so this file fits under the 400-line ceiling.
