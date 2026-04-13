import { join } from 'node:path'
import { dirSize, fileCount } from '../storage/files.js'
import { statSync, existsSync } from 'node:fs'

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

  return {
    dataDir,
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
