import { join } from 'node:path'
import { fetchDocPage } from '../apple/api.js'
import { sha256 } from '../lib/hash.js'
import { writeJSON } from '../storage/files.js'

/**
 * Download any pages that were discovered but not yet downloaded.
 * This handles the resume edge case where discovery succeeded but download didn't persist.
 */
export async function downloadMissing(db, dataDir, rateLimiter, logger, onProgress) {
  const pages = db.db.query(`
    SELECT p.path, r.slug as root_slug
    FROM pages p JOIN roots r ON p.root_id = r.id
    WHERE p.downloaded_at IS NULL AND p.status = 'active'
  `).all()

  if (pages.length === 0) return { downloaded: 0 }

  logger.info(`Downloading ${pages.length} missing pages...`)
  let downloaded = 0

  for (const { path } of pages) {
    try {
      const { json, etag, lastModified } = await fetchDocPage(path, rateLimiter)
      const jsonStr = await writeJSON(join(dataDir, 'raw-json', path + '.json'), json)
      const contentHash = sha256(jsonStr)

      db.updatePageAfterDownload(path, etag, lastModified, contentHash)
      downloaded++
      onProgress?.({ downloaded, total: pages.length, path })
    } catch (e) {
      logger.warn(`Download failed: ${path}`, { error: e.message })
    }
  }

  return { downloaded }
}
