import { discoverRoots, crawlRoot } from '../pipeline/discover.js'
import { downloadMissing } from '../pipeline/download.js'
import { convertAll } from '../pipeline/convert.js'
import { syncGuidelines } from '../pipeline/sync-guidelines.js'
import { Semaphore } from '../lib/semaphore.js'

/** Roots that use a custom sync pipeline instead of DocC BFS crawl. */
const HTML_ROOTS = new Set(['app-store-review'])

/**
 * Full sync pipeline: discover roots -> crawl (parallel) -> convert remaining.
 * @param {{ roots?: string[], full?: boolean, concurrency?: number, parallel?: number, retryFailed?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function sync(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()

  db.setActivity('sync', opts.roots ?? null)

  // 1. Discover roots
  let rootCount
  try {
    rootCount = await discoverRoots(db, rateLimiter, logger)
  } catch (e) {
    db.clearActivity()
    throw e
  }

  // 2. Determine which roots to crawl
  let rootsToCrawl
  if (opts.roots?.length) {
    rootsToCrawl = opts.roots.map(r => r.toLowerCase())
  } else if (opts.full) {
    rootsToCrawl = db.getRoots().map(r => r.slug)
  } else {
    rootsToCrawl = db.getRoots().map(r => r.slug)
  }

  // Filter to valid roots, separating HTML-based roots from DocC roots
  const validRoots = rootsToCrawl.filter(slug => {
    if (HTML_ROOTS.has(slug)) return false // handled separately below
    const root = db.getRootBySlug(slug)
    if (!root) { logger.warn(`Root not found: ${slug}`); return false }
    return true
  })
  const htmlRootsToSync = rootsToCrawl.filter(slug => HTML_ROOTS.has(slug))

  // 3. Shared concurrency control
  // One semaphore caps total in-flight fetches across ALL roots.
  // One rate limiter caps total requests/sec across ALL roots.
  const concurrency = opts.concurrency ?? parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10)
  const parallel = opts.parallel ?? 1
  const semaphore = new Semaphore(concurrency)
  const crawlOpts = { retryFailed: !!opts.retryFailed, semaphore }

  // 4. Crawl roots
  const crawlResults = {}

  if (parallel <= 1) {
    for (const slug of validRoots) {
      logger.info(`Crawling ${slug}...`)
      try {
        crawlResults[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, crawlOpts)
      } catch (e) {
        logger.error(`Crawl failed for ${slug}`, { error: e.message })
        crawlResults[slug] = { error: e.message }
      }
    }
  } else {
    logger.info(`Crawling ${validRoots.length} roots (${parallel} parallel, ${concurrency} max fetches, ${ctx.rateLimiter.rate} req/s)...`)
    await pool(validRoots, parallel, async (slug) => {
      logger.info(`Crawling ${slug}...`)
      try {
        crawlResults[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, crawlOpts)
        const r = crawlResults[slug]
        logger.info(`Done: ${slug} (${r.total} total, ${r.processed} new)`)
      } catch (e) {
        logger.error(`Crawl failed for ${slug}`, { error: e.message })
        crawlResults[slug] = { error: e.message }
      }
    })
  }

  // 5. Sync HTML-based roots (e.g. App Store Review Guidelines)
  let guidelinesResult = null
  if (htmlRootsToSync.includes('app-store-review')) {
    try {
      guidelinesResult = await syncGuidelines(db, dataDir, rateLimiter, logger)
    } catch (e) {
      logger.error('Guidelines sync failed', { error: e.message })
    }
  }

  // 6. Download any missing pages (resume case)
  const dlResult = await downloadMissing(db, dataDir, rateLimiter, logger)

  // 6. Convert any remaining unconverted pages
  const unconverted = db.getUnconvertedPages()
  let cvResult = { converted: 0, total: 0 }
  if (unconverted.length > 0) {
    logger.info(`Converting ${unconverted.length} remaining pages to Markdown...`)
    cvResult = await convertAll(db, dataDir, logger)
  }

  // 7. Optional body indexing
  let bodyIndexed = 0
  if (opts.indexBody) {
    const { indexBodyIncremental } = await import('../pipeline/index-body.js')
    const idxResult = await indexBodyIncremental(db, dataDir, logger)
    bodyIndexed = idxResult.indexed
  }

  const durationMs = Date.now() - startMs

  const totalProcessed = Object.values(crawlResults).reduce((s, r) => s + (r.processed ?? 0), 0)
  db.addUpdateLog({
    action: 'sync',
    newCount: totalProcessed,
    durationMs,
  })
  db.clearActivity()

  return {
    rootsDiscovered: rootCount,
    rootsCrawled: validRoots.length,
    crawlResults,
    guidelines: guidelinesResult,
    downloaded: dlResult.downloaded,
    bodyIndexed,
    converted: cvResult.converted,
    durationMs,
  }
}

/**
 * Run async tasks with bounded concurrency.
 * Starts up to `limit` tasks. When one finishes, starts the next.
 */
function pool(items, limit, fn) {
  const queue = [...items]
  const active = new Set()

  return new Promise((resolve) => {
    function drain() {
      while (active.size < limit && queue.length > 0) {
        const item = queue.shift()
        const p = fn(item).finally(() => {
          active.delete(p)
          drain()
        })
        active.add(p)
      }
      if (active.size === 0 && queue.length === 0) {
        resolve()
      }
    }
    drain()
  })
}
