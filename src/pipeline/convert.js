import { renderPage } from '../apple/renderer.js'
import { nativeConvertPages } from '../content/content-native.js'
import { pool } from '../lib/pool.js'
import { keyPath } from '../lib/safe-path.js'
import { readJSON, writeText } from '../storage/files.js'

const NATIVE_BATCH = 64

/**
 * Convert all unconverted pages from raw JSON to Markdown.
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} dataDir
 * @param {import('../lib/logger.js').Logger} logger
 * @param {function} [onProgress]
 */
export async function convertAll(db, dataDir, logger, onProgress, filters = {}, opts = {}) {
  let pages = db.getUnconvertedPages()
  const rootSet = filters.roots ? new Set(filters.roots.map((root) => root.toLowerCase())) : null
  const sourceSet = filters.sources ? new Set(filters.sources.map((source) => source.toLowerCase())) : null

  if (rootSet) {
    pages = pages.filter((page) => rootSet.has(page.root_slug))
  }
  if (sourceSet) {
    pages = pages.filter((page) => sourceSet.has(page.source_type))
  }

  let done = 0
  const concurrency = Math.max(1, opts.semaphore?.max ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10))
  const convertPageImpl = opts.convertPage ?? convertPage

  // Batched native convert (RFC 0004 D-0004-6): Swift reads+parses+renders
  // whole batches; JS only writes the results (atomic-write semantics stay
  // here). Pages the native side rejects fall back to the JS pool below.
  // Skipped when tests inject a convertPage implementation.
  if (!opts.convertPage && pages.length > 0) {
    const remaining = []
    for (let start = 0; start < pages.length; start += NATIVE_BATCH) {
      const batch = pages.slice(start, start + NATIVE_BATCH)
      const entries = batch.map(({ path }) => ({ path, filePath: keyPath(dataDir, 'raw-json', path, '.json') }))
      const results = nativeConvertPages(entries)
      if (results === null) {
        remaining.push(...batch) // native unavailable — JS pool serves
        continue
      }
      for (let i = 0; i < batch.length; i++) {
        const { path } = batch[i]
        const markdown = results[i]
        if (markdown === null) {
          remaining.push(batch[i])
          continue
        }
        try {
          await writeText(keyPath(dataDir, 'markdown', path, '.md'), markdown)
          db.markConverted(path)
          done++
          onProgress?.({ done, total: pages.length, path })
        } catch (e) {
          logger.warn(`Convert failed: ${path}`, { error: e.message })
        }
      }
    }
    pages = remaining
  }

  const total = done + pages.length
  await pool(pages, concurrency, async ({ path }) => {
    try {
      const ok = await convertPageImpl(db, dataDir, path)
      if (ok !== false) done++
      onProgress?.({ done, total, path })
    } catch (e) {
      logger.warn(`Convert failed: ${path}`, { error: e.message })
    }
  })

  return { converted: done, total }
}

/**
 * Convert a single page from raw JSON to Markdown.
 */
async function convertPage(db, dataDir, pagePath) {
  const jsonPath = keyPath(dataDir, 'raw-json', pagePath, '.json')
  const mdPath = keyPath(dataDir, 'markdown', pagePath, '.md')

  const json = await readJSON(jsonPath)
  if (!json) return false

  const markdown = renderPage(json, pagePath)
  await writeText(mdPath, markdown)

  db.markConverted(pagePath)
  return true
}
