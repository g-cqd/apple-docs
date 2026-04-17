import { fetchDocPage } from '../apple/api.js'
import { pool } from '../lib/pool.js'
import { persistFetchedDocPage } from './persist.js'

/**
 * Download any pages that were discovered but not yet downloaded.
 * This handles the resume edge case where discovery succeeded but download didn't persist.
 */
export async function downloadMissing(db, dataDir, rateLimiter, logger, onProgress, filters = {}, opts = {}) {
  let pages = db.db.query(`
    SELECT p.path, p.root_id, r.slug as root_slug, r.source_type
    FROM pages p JOIN roots r ON p.root_id = r.id
    WHERE p.downloaded_at IS NULL AND p.status = 'active'
  `).all()
  const rootSet = filters.roots ? new Set(filters.roots.map(root => root.toLowerCase())) : null
  const sourceSet = filters.sources ? new Set(filters.sources.map(source => source.toLowerCase())) : null

  if (rootSet) {
    pages = pages.filter(page => rootSet.has(page.root_slug))
  }
  if (sourceSet) {
    pages = pages.filter(page => sourceSet.has(page.source_type))
  }

  if (pages.length === 0) return { downloaded: 0 }

  logger.info(`Downloading ${pages.length} missing pages...`)
  let downloaded = 0
  const concurrency = Math.max(1, opts.semaphore?.max ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10))
  const fetchPage = opts.fetchDocPage ?? fetchDocPage
  const persistPage = opts.persistFetchedDocPage ?? persistFetchedDocPage

  await pool(pages, concurrency, async ({ path, root_id: rootId, source_type: sourceType }) => {
    try {
      const { json, etag, lastModified } = await fetchPage(path, rateLimiter)
      await persistPage({
        db,
        dataDir,
        rootId,
        path,
        sourceType: sourceType ?? 'apple-docc',
        json,
        etag,
        lastModified,
      })
      downloaded++
      onProgress?.({ downloaded, total: pages.length, path })
    } catch (e) {
      logger.warn(`Download failed: ${path}`, { error: e.message })
    }
  })

  return { downloaded }
}
