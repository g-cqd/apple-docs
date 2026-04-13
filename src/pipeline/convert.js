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
export async function convertAll(db, dataDir, logger, onProgress, filters = {}) {
  let pages = db.getUnconvertedPages()
  const rootSet = filters.roots ? new Set(filters.roots.map(root => root.toLowerCase())) : null
  const sourceSet = filters.sources ? new Set(filters.sources.map(source => source.toLowerCase())) : null

  if (rootSet) {
    pages = pages.filter(page => rootSet.has(page.root_slug))
  }
  if (sourceSet) {
    pages = pages.filter(page => sourceSet.has(page.source_type))
  }

  let done = 0

  for (const { path } of pages) {
    try {
      const ok = await convertPage(db, dataDir, path)
      if (ok !== false) done++
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
async function convertPage(db, dataDir, pagePath) {
  const jsonPath = join(dataDir, 'raw-json', `${pagePath}.json`)
  const mdPath = join(dataDir, 'markdown', `${pagePath}.md`)

  const json = await readJSON(jsonPath)
  if (!json) return false

  const markdown = renderPage(json, pagePath)
  await writeText(mdPath, markdown)

  db.markConverted(pagePath)
  return true
}
