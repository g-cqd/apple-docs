import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { sha256 } from '../lib/hash.js'
import { ensureDir } from '../storage/files.js'
import { DocsDatabase } from '../storage/database.js'

const GITHUB_REPO = 'g-cqd/apple-docs'
const USER_AGENT = 'apple-docs/2.0'

/**
 * Download and install a pre-built documentation snapshot.
 *
 * @param {{ tier?: string, force?: boolean, downgrade?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function setup(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const tier = opts.tier ?? 'standard'
  const force = opts.force ?? false
  const downgrade = opts.downgrade ?? false

  if (!['lite', 'standard', 'full'].includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Must be one of: lite, standard, full`)
  }

  // 1. Check existing corpus
  const dbPath = join(dataDir, 'apple-docs.db')
  const stats = db.getStats()
  const currentTier = db.getTier()
  const tierRank = { lite: 0, standard: 1, full: 2 }
  if (stats.totalPages > 0 && !force) {
    return {
      status: 'exists',
      dataDir,
      pages: stats.totalPages,
      currentTier,
      hint: currentTier !== tier
        ? `Run 'apple-docs setup --tier ${tier} --force' to upgrade from ${currentTier} to ${tier}.`
        : undefined,
    }
  }

  if (
    stats.totalPages > 0
    && currentTier
    && tierRank[tier] < tierRank[currentTier]
    && !downgrade
  ) {
    throw new Error(
      `Refusing to downgrade from ${currentTier} to ${tier} without --downgrade. ` +
      `Re-run 'apple-docs setup --tier ${tier} --force --downgrade' if you really want to replace the current corpus.`,
    )
  }

  // 2. Fetch latest release
  logger.info('Fetching latest release...')
  const release = await fetchLatestRelease()
  logger.info(`Found release: ${release.tag} (${release.date})`)

  // 3. Find matching asset
  const archiveAsset = release.assets.find(a => a.name.includes(`-${tier}-`) && a.name.endsWith('.tar.gz'))
  if (!archiveAsset) {
    throw new Error(`No ${tier} snapshot found in release ${release.tag}. Available: ${release.assets.map(a => a.name).join(', ')}`)
  }

  const checksumAsset = release.assets.find(a => a.name.includes(`-${tier}-`) && a.name.endsWith('.sha256'))

  // 4. Download archive to temp file
  const tmpPath = join(dataDir, '.setup-download.tar.gz')
  ensureDir(dataDir)

  try {
    logger.info(`Downloading ${archiveAsset.name} (${formatSize(archiveAsset.size)})...`)
    const archiveRes = await fetch(archiveAsset.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
      redirect: 'follow',
    })
    if (!archiveRes.ok) {
      throw new Error(`Download failed: HTTP ${archiveRes.status}`)
    }
    await Bun.write(tmpPath, archiveRes)
    logger.info('Download complete.')

    // 5. Verify checksum
    if (checksumAsset) {
      logger.info('Verifying checksum...')
      const checksumRes = await fetch(checksumAsset.downloadUrl, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
      })
      if (checksumRes.ok) {
        const checksumText = await checksumRes.text()
        const expectedHash = checksumText.trim().split(/\s+/)[0]
        const archiveBytes = await Bun.file(tmpPath).arrayBuffer()
        const actualHash = sha256(new Uint8Array(archiveBytes))
        if (actualHash !== expectedHash) {
          throw new Error(`Checksum mismatch! Expected ${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`)
        }
        logger.info('Checksum verified.')
      }
    }

    // 6. Close current DB and extract
    db.close()

    // Remove old extracted payloads before installing the new tier.
    // This prevents stale markdown/raw-json content from surviving a
    // downgrade (for example, standard -> lite).
    const installPaths = [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      join(dataDir, 'manifest.json'),
      join(dataDir, 'raw-json'),
      join(dataDir, 'markdown'),
    ]
    for (const target of installPaths) {
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true })
      }
    }

    const proc = Bun.spawn(['tar', '-xzf', tmpPath, '-C', dataDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`Extraction failed (exit ${exitCode}): ${stderr}`)
    }
    logger.info('Extracted snapshot.')

    // 7. Verify extracted database
    const verifyDb = new DocsDatabase(dbPath)
    try {
      const schemaVersion = verifyDb.getSchemaVersion()
      const documentCount = verifyDb.db.query('SELECT COUNT(*) as c FROM documents').get().c

      // 8. Store installation metadata
      verifyDb.setSnapshotMeta('snapshot_tag', release.tag)
      verifyDb.setSnapshotMeta('snapshot_installed_at', new Date().toISOString())

      const transition = currentTier && currentTier !== tier ? { from: currentTier, to: tier } : null
      if (transition) {
        logger.info(`Upgraded from ${transition.from} to ${transition.to} tier.`)
      }
      logger.info(`Setup complete! ${documentCount} documents ready.`)

      return {
        status: 'ok',
        tag: release.tag,
        tier,
        transition,
        documentCount,
        schemaVersion,
        dataDir,
      }
    } finally {
      verifyDb.close()
    }
  } finally {
    // 9. Cleanup temp file
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true })
    }
  }
}

/**
 * Fetch the latest release from GitHub.
 */
async function fetchLatestRelease() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('No releases found. The repository may not have published any snapshots yet.')
    }
    throw new Error(`GitHub API error: HTTP ${res.status}`)
  }

  const data = await res.json()
  return {
    tag: data.tag_name,
    date: data.published_at?.slice(0, 10) ?? 'unknown',
    assets: (data.assets ?? []).map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  }
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}
