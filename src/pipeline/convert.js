import { join } from 'node:path'
import { renderPage } from '../apple/renderer.js'
import { readJSON, writeText } from '../storage/files.js'

/**
 * Convert all unconverted pages from raw JSON to Markdown.
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} dataDir
 * @param {import('../lib/logger.js').Logger} logger
 * @param {function} [onProgress]
 */
export async function convertAll(db, dataDir, logger, onProgress) {
  const pages = db.getUnconvertedPages()
  let done = 0

  for (const { path } of pages) {
    try {
      await convertPage(db, dataDir, path)
      done++
      onProgress?.({ done, total: pages.length, path })
    } catch (e) {
      logger.warn(`Convert failed: ${path}`, { error: e.message })
    }
  }

  return { converted: done, total: pages.length }
}

/**
 * Convert a single page from raw JSON to Markdown.
 */
export async function convertPage(db, dataDir, pagePath) {
  const jsonPath = join(dataDir, 'raw-json', pagePath + '.json')
  const mdPath = join(dataDir, 'markdown', pagePath + '.md')

  const json = await readJSON(jsonPath)
  if (!json) return false

  const markdown = renderPage(json, pagePath)
  await writeText(mdPath, markdown)

  db.markConverted(pagePath)
  return true
}
