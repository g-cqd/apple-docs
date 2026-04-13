import { normalizeIdentifier, extractRootSlug } from '../apple/normalizer.js'
import { extractReferences, extractMetadata } from '../apple/extractor.js'
import { fetchDocPage, fetchTechnologies } from '../apple/api.js'
import { renderPage } from '../apple/renderer.js'
import { sha256 } from '../lib/hash.js'
import { writeJSON, writeText } from '../storage/files.js'
import { join } from 'node:path'

const KIND_MAP = {
  'App Frameworks': 'framework',
  'App Services': 'framework',
  'Developer Tools': 'tooling',
  'Graphics and Games': 'framework',
  'Media': 'framework',
  'Release Notes': 'release-notes',
  'System': 'framework',
  'Web': 'framework',
  'Design': 'technology',
  'Technology Overviews': 'technology',
  'Sample Code': 'tutorial',
}

/**
 * Discover documentation roots from the technologies index.
 * @returns {number} Number of roots discovered
 */
export async function discoverRoots(db, rateLimiter, logger) {
  logger.info('Fetching technologies index...')
  const { json } = await fetchTechnologies(rateLimiter)

  let count = 0
  for (const section of json.sections ?? []) {
    for (const group of section.groups ?? []) {
      const kind = KIND_MAP[group.name] ?? 'unknown'
      for (const tech of group.technologies ?? []) {
        const id = normalizeIdentifier(tech.destination?.identifier)
        if (!id) continue
        const slug = extractRootSlug(id)
        if (!slug) continue

        db.upsertRoot(slug, tech.title, kind, 'apple-index')
        count++
      }
    }
  }

  // HIG uses /design/ instead of /documentation/. Apple's technologies index
  // points to it via https:// URL (which we reject). Register it explicitly
  // with its actual seed path.
  db.upsertRoot('design', 'Human Interface Guidelines', 'technology', 'apple-index', 'design/human-interface-guidelines')
  count++

  // App Store Review Guidelines are an HTML page, not DocC JSON.
  // Register here so it appears in list_frameworks; actual sync handled by sync-guidelines.js.
  db.upsertRoot('app-store-review', 'App Store Review Guidelines', 'guidelines', 'html-scrape')
  count++

  logger.info(`Discovered ${count} documentation roots`)
  return count
}

/**
 * Crawl a single root's documentation pages via BFS.
 * Uses a shared semaphore for global concurrency control across all roots.
 * @param {import('../lib/semaphore.js').Semaphore} semaphore - shared across all parallel roots
 */
export async function crawlRoot(db, dataDir, rateLimiter, rootSlug, logger, onProgress, opts = {}) {
  const { retryFailed = false, semaphore } = opts
  const root = db.getRootBySlug(rootSlug)
  if (!root) throw new Error(`Unknown root: ${rootSlug}`)

  // Seed the crawl queue with the root's entry point
  const seedPath = root.seed_path ?? rootSlug
  db.seedCrawlIfNew(seedPath, rootSlug, 0)

  // Optionally retry previously failed pages
  if (retryFailed) {
    const failedCount = db.countFailed(rootSlug)
    if (failedCount > 0) {
      db.resetFailedCrawl(rootSlug)
      logger.info(`Reset ${failedCount} failed pages for ${rootSlug} to pending`)
    }
  }

  // Batch size for pulling from the queue — pull more than we can run
  // so the semaphore always has work to schedule
  const batchSize = semaphore ? semaphore.max : (opts.concurrency ?? parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10))
  let processed = 0

  while (true) {
    const batch = db.getPendingCrawl(rootSlug, batchSize)
    if (batch.length === 0) break

    const results = await Promise.allSettled(
      batch.map(({ path, depth }) => {
        const run = () => processPage(db, dataDir, rateLimiter, root.id, rootSlug, path, depth, logger)
        return semaphore ? semaphore.run(run) : run()
      })
    )

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        processed++
      } else {
        logger.warn(`Failed: ${batch[i].path}`, { error: results[i].reason?.message })
      }
    }

    onProgress?.({
      ...db.getCrawlStats(rootSlug),
      current: batch[batch.length - 1]?.path,
    })
  }

  db.updateRootPageCount(rootSlug)
  const finalStats = db.getCrawlStats(rootSlug)
  return { processed, total: finalStats.processed + finalStats.failed }
}

async function processPage(db, dataDir, rateLimiter, rootId, rootSlug, path, depth, logger) {
  try {
    const { json, etag, lastModified } = await fetchDocPage(path, rateLimiter)

    // Save raw JSON (writeJSON returns the serialized string — reuse for hash)
    const jsonStr = await writeJSON(join(dataDir, 'raw-json', path + '.json'), json)
    const contentHash = sha256(jsonStr)

    // Extract metadata
    const meta = extractMetadata(json)

    // Upsert page
    db.upsertPage({
      rootId,
      path,
      url: `https://developer.apple.com/tutorials/data/documentation/${path}.json`,
      title: meta.title,
      role: meta.role,
      roleHeading: meta.roleHeading,
      abstract: meta.abstract,
      platforms: meta.platforms,
      declaration: meta.declaration,
      etag,
      lastModified,
      contentHash,
      downloadedAt: new Date().toISOString(),
    })

    // Extract and seed references
    const refs = extractReferences(json)
    for (const refPath of refs) {
      const refRoot = extractRootSlug(refPath)
      if (refRoot === rootSlug) {
        db.seedCrawlIfNew(refPath, rootSlug, depth + 1)
      }
    }

    // Convert to Markdown inline
    try {
      const markdown = renderPage(json, path)
      await writeText(join(dataDir, 'markdown', path + '.md'), markdown)
      db.markConverted(path)
    } catch (e) {
      logger.warn(`Inline convert failed: ${path}`, { error: e.message })
    }

    db.setCrawlState(path, 'processed', rootSlug, depth)
  } catch (e) {
    const errMsg = e.status === 404 ? 'Not found' : e.message
    db.setCrawlState(path, 'failed', rootSlug, depth, errMsg)
    throw e
  }
}
