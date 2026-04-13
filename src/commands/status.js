import { join } from 'node:path'
import { dirSize, fileCount } from '../storage/files.js'
import { statSync, existsSync } from 'node:fs'

const STALE_THRESHOLD_DAYS = 14

/**
 * Check data freshness against update_log and per-root update_log entries.
 * @param {{ db: import('../storage/database.js').DocsDatabase }} db
 * @returns {{ lastSyncAt: string|null, daysSinceSync: number|null, isStale: boolean, staleRoots: Array<{slug: string, daysSince: number}> }}
 */
function freshnessCheck(db) {
  // Last global sync time
  const lastLogRow = db.db.query('SELECT timestamp FROM update_log ORDER BY id DESC LIMIT 1').get()

  if (!lastLogRow) {
    return { lastSyncAt: null, daysSinceSync: null, isStale: true, staleRoots: [] }
  }

  const lastSyncAt = lastLogRow.timestamp
  const daysSinceSync = Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 86400000)
  const isStale = daysSinceSync > STALE_THRESHOLD_DAYS

  // Per-root staleness: last update_log entry per root_slug
  const rootRows = db.db.query(
    "SELECT root_slug, MAX(timestamp) as last_update FROM update_log WHERE root_slug IS NOT NULL GROUP BY root_slug"
  ).all()

  const staleRoots = rootRows
    .map(r => ({
      slug: r.root_slug,
      daysSince: Math.floor((Date.now() - new Date(r.last_update).getTime()) / 86400000),
    }))
    .filter(r => r.daysSince > STALE_THRESHOLD_DAYS)

  return { lastSyncAt, daysSinceSync, isStale, staleRoots }
}

/**
 * Return corpus status, activity state, and crawl progress.
 * @param {object} opts - (unused)
 * @param {{ db, dataDir }} ctx
 */
export async function status(opts, ctx) {
  const { db, dataDir } = ctx
  const stats = db.getStats()

  const dbPath = join(dataDir, 'apple-docs.db')
  const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0
  const rawJsonSize = dirSize(join(dataDir, 'raw-json'))
  const rawJsonFiles = fileCount(join(dataDir, 'raw-json'))
  const markdownSize = dirSize(join(dataDir, 'markdown'))
  const markdownFiles = fileCount(join(dataDir, 'markdown'))

  // Activity: is something running, or was it interrupted?
  let activity = null
  if (stats.activity) {
    activity = {
      action: stats.activity.action,
      startedAt: stats.activity.started_at,
      pid: stats.activity.pid,
      alive: stats.activity.alive,
      roots: stats.activity.roots,
      status: stats.activity.alive ? 'running' : 'interrupted',
    }
  }

  // Crawl progress: overall and per-root
  const crawlProgress = {
    total: stats.crawlProgress.total,
    processed: stats.crawlProgress.processed,
    pending: stats.crawlProgress.pending,
    failed: stats.crawlProgress.failed,
  }

  const crawlByRoot = stats.crawlByRoot.map(r => ({
    root: r.root_slug,
    processed: r.processed,
    pending: r.pending,
    failed: r.failed,
    total: r.processed + r.pending + r.failed,
    percent: r.processed + r.pending + r.failed > 0
      ? Math.round((r.processed / (r.processed + r.pending + r.failed)) * 100)
      : 0,
  }))

  // Check for updates (only if installed from snapshot)
  let updateAvailable = null
  if (!opts.skipUpdateCheck) {
    updateAvailable = await checkForUpdate(db)
  }

  const tier = db.getTier()
  const capabilities = {
    search: true,
    searchTrigram: db.hasTable('documents_trigram'),
    searchBody: db.getBodyIndexCount() > 0,
    readContent: db.hasTable('document_sections'),
  }

  return {
    dataDir,
    tier,
    capabilities,
    databaseSize: dbSize,
    rawJson: { size: rawJsonSize, files: rawJsonFiles },
    markdown: { size: markdownSize, files: markdownFiles },
    roots: {
      total: stats.totalRoots,
      byKind: Object.fromEntries(stats.rootsByKind.map(r => [r.kind, r.count])),
    },
    pages: {
      active: stats.totalPages,
      deleted: stats.totalDeleted,
    },
    activity,
    crawlProgress,
    crawlByRoot,
    lastSync: stats.lastLog?.timestamp ?? null,
    lastAction: stats.lastLog?.action ?? null,
    updateAvailable,
    freshness: freshnessCheck(db),
  }
}

async function checkForUpdate(db) {
  try {
    const currentTag = db.getSnapshotMeta('snapshot_tag')
    if (!currentTag) return null

    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
    const headers = {
      'User-Agent': 'apple-docs/2.0',
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }

    const res = await fetch('https://api.github.com/repos/g-cqd/apple-docs/releases/latest', {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null

    const release = await res.json()
    const latestTag = release.tag_name
    if (latestTag !== currentTag) {
      return { current: currentTag, latest: latestTag, available: true }
    }
    return { current: currentTag, latest: latestTag, available: false }
  } catch {
    return null
  }
}
