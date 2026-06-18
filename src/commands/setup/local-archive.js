// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { existsSync, statSync } from 'node:fs'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { sha256File } from '../../lib/hash.js'
import { formatSize, resolveArchivePath, stripTarGz } from './helpers.js'

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
 *
 * `extractAndIndex` is injected by setup.js — it is the shared
 * extract → re-index → profile pipeline both install routes converge on.
 */
export async function installFromLocalArchive(ctx, opts, { extractAndIndex, snapshotTier }) {
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
  const manifestPath = isSevenZip ? `${archivePath.slice(0, -'.7z'.length)}.manifest.json` : `${stripTarGz(archivePath)}.manifest.json`
  const hasChecksum = existsSync(checksumPath)
  const hasManifest = existsSync(manifestPath)

  if (hasChecksum) {
    logger.info('Verifying checksum...')
    const checksumText = await Bun.file(checksumPath).text()
    const expectedHash = checksumText.trim().split(/\s+/)[0]
    const actualHash = await sha256File(archivePath) // streamed: full-corpus archives are multi-GB
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

  const result = await extractAndIndex(ctx, archivePath, {
    skipResources: opts.skipResources,
    skipSemantic: opts.skipSemantic,
    embedder: opts.embedder,
    profile: opts.profile,
    yes: opts.yes,
  })
  return {
    status: 'ok',
    source: 'local-archive',
    archive: archivePath,
    tag: manifestTag,
    tier: snapshotTier,
    documentCount: result.documentCount,
    schemaVersion: result.schemaVersion,
    storageProfile: result.storageProfile,
    dataDir,
  }
}
