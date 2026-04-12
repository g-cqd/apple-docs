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
  }
}
