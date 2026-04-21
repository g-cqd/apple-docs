import { convertAll } from '../pipeline/convert.js'
import { crawlRoot, discoverRoots } from '../pipeline/discover.js'
import { downloadMissing } from '../pipeline/download.js'
import { persistNormalizedPage } from '../pipeline/persist.js'
import { applyGuidelinesSnapshot } from '../pipeline/sync-guidelines.js'
import { markFlatSourceFailed, markFlatSourceProcessed, seedFlatSourceProgress } from '../lib/flat-source-progress.js'
import { Semaphore } from '../lib/semaphore.js'
import { pool } from '../lib/pool.js'
import { getAdapter, getAllAdapters } from '../sources/registry.js'
import { ROOT_CATALOG_SOURCE_TYPES, normalizeList, validateRequestedSources, selectRootsForAdapter, filterPages, discoverAdaptersInParallel } from './command-helpers.js'

/**
 * Full sync pipeline: discover roots -> crawl (parallel) -> convert remaining.
 * @param {{ roots?: string[], sources?: string[], full?: boolean, concurrency?: number, parallel?: number, retryFailed?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function sync(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const requestedSources = normalizeList(opts.sources)
  const requestedRoots = normalizeList(opts.roots)

  validateRequestedSources(requestedSources)

  const adapters = ctx.adapters ?? (
    requestedSources
      ? requestedSources.map(getAdapter)
      : getAllAdapters()
  )
  const concurrency = ctx.semaphore?.max ?? opts.concurrency ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '500', 10)
  const parallel = opts.parallel ?? 10
  const semaphore = ctx.semaphore ?? new Semaphore(concurrency)
  const adapterCtx = { ...ctx, rootCatalogReady: false, semaphore, fullSync: !!opts.full }

  db.setActivity('sync', opts.roots ?? null)

  try {
    if (adapters.some(adapter => ROOT_CATALOG_SOURCE_TYPES.has(adapter.constructor.type))) {
      await discoverRoots(db, rateLimiter, logger)
      adapterCtx.rootCatalogReady = true
    }

    const crawlOpts = { retryFailed: !!opts.retryFailed, semaphore }
    const crawlResults = {}
    const failedSources = []
    let guidelinesResult = null
    let rootsCrawled = 0
    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } = await discoverAdaptersInParallel(adapters, adapterCtx)

    for (const adapter of adapters) {
      logger.info(`Syncing ${adapter.constructor.displayName}...`)

      try {
        const discoveryError = discoveryErrorsBySource.get(adapter.constructor.type)
        if (discoveryError) {
          logger.error(`Source ${adapter.constructor.type} failed`, { error: discoveryError.message })
          failedSources.push({ source: adapter.constructor.type, error: discoveryError.message })
          continue
        }

        const discovery = discoveriesBySource.get(adapter.constructor.type)
        const roots = selectRootsForAdapter(adapter, discovery, db, requestedRoots)

        switch (adapter.constructor.syncMode) {
          case 'snapshot': {
            if (roots.length > 0) {
              logger.info(`Fetching ${adapter.constructor.displayName} via adapter...`)
              const fetchResult = await adapter.fetch(roots[0].slug, adapterCtx)
              guidelinesResult = await applyGuidelinesSnapshot(db, dataDir, fetchResult.payload)
              logger.info(`Synced ${guidelinesResult.sections} guideline sections`)
            }
            break
          }
          case 'flat': {
            const flatResults = await syncFlatSource(adapter, discovery, roots, concurrency, adapterCtx)
            rootsCrawled += roots.length
            Object.assign(crawlResults, flatResults)
            break
          }
          default: {
            const rootSlugs = roots.map(root => root.slug)
            if (rootSlugs.length === 0) break

            rootsCrawled += rootSlugs.length
            const adapterResults = await crawlRoots(rootSlugs, parallel, concurrency, ctx, crawlOpts, adapter)
            Object.assign(crawlResults, adapterResults)
            break
          }
        }
      } catch (e) {
        logger.error(`Source ${adapter.constructor.type} failed`, { error: e.message })
        failedSources.push({ source: adapter.constructor.type, error: e.message })
      }
    }

    const activeSourceTypes = adapters.map(adapter => adapter.constructor.type)
    const filters = { roots: requestedRoots, sources: activeSourceTypes }
    const dlResult = await downloadMissing(db, dataDir, rateLimiter, logger, null, filters, { semaphore })

    const pendingConversions = filterPages(db.getUnconvertedPages(), requestedRoots, activeSourceTypes)
    let cvResult = { converted: 0, total: 0 }
    if (pendingConversions.length > 0) {
      logger.info(`Converting ${pendingConversions.length} remaining pages to Markdown...`)
      cvResult = await convertAll(db, dataDir, logger, null, filters, { semaphore })
    }

    let bodyIndexed = 0
    if (opts.indexBody) {
      const { indexBodyIncremental } = await import('../pipeline/index-body.js')
      const idxResult = await indexBodyIncremental(db, dataDir, logger)
      bodyIndexed = idxResult.indexed
    }

    const durationMs = Date.now() - startMs
    const totalProcessed = Object.values(crawlResults).reduce((sum, result) => sum + (result.processed ?? 0), 0)

    db.addUpdateLog({
      action: 'sync',
      newCount: totalProcessed,
      durationMs,
    })

    return {
      rootsDiscovered: db.getRoots().length,
      rootsCrawled,
      crawlResults,
      failedSources,
      guidelines: guidelinesResult,
      downloaded: dlResult.downloaded,
      bodyIndexed,
      converted: cvResult.converted,
      durationMs,
    }
  } finally {
    db.clearActivity()
    // Mirror update.js: recycle any embedded reader-pool so post-sync queries
    // see a clean set of prepared statements. No-op in the normal CLI path
    // where the pool is absent.
    try { await ctx.readerPool?.recycle?.() } catch {}
  }
}

async function crawlRoots(rootSlugs, parallel, concurrency, ctx, crawlOpts, adapter) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const results = {}

  if (parallel <= 1) {
    for (const slug of rootSlugs) {
      logger.info(`Crawling ${slug}...`)
      try {
        results[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, {
          ...crawlOpts,
          adapter,
        })
      } catch (e) {
        logger.error(`Crawl failed for ${slug}`, { error: e.message })
        results[slug] = { error: e.message }
      }
    }
    return results
  }

  logger.info(`Crawling ${rootSlugs.length} roots (${parallel} parallel, ${concurrency} max fetches, ${ctx.rateLimiter.rate} req/s)...`)
  await pool(rootSlugs, parallel, async (slug) => {
    logger.info(`Crawling ${slug}...`)
    try {
      results[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, {
        ...crawlOpts,
        adapter,
      })
      const result = results[slug]
      logger.info(`Done: ${slug} (${result.total} total, ${result.processed} new)`)
    } catch (e) {
      logger.error(`Crawl failed for ${slug}`, { error: e.message })
      results[slug] = { error: e.message }
    }
  })
  return results
}


async function syncFlatSource(adapter, discovery, roots, concurrency, ctx) {
  const { db, dataDir, logger } = ctx
  const results = {}
  const keys = discovery.keys ?? []

  for (const root of roots) {
    let processed = 0
    let skipped = 0
    const existingKeys = db.getActivePathsIn(keys)

    logger.info(`Syncing ${adapter.constructor.displayName} (${keys.length} keys)...`)
    seedFlatSourceProgress(db, root.slug, keys, existingKeys)

    await pool(keys, concurrency, async (key) => {
      if (existingKeys.has(key)) {
        skipped++
        return
      }

      try {
        const fetchResult = await adapter.fetch(key, ctx)
        const normalized = adapter.normalize(key, fetchResult.payload)
        adapter.validateNormalizeResult(normalized)

        await persistNormalizedPage({
          db,
          dataDir,
          rootId: root.id,
          path: key,
          sourceType: adapter.constructor.type,
          rawPayload: fetchResult.payload,
          normalized,
          etag: fetchResult.etag ?? null,
          lastModified: fetchResult.lastModified ?? null,
        })
        markFlatSourceProcessed(db, root.slug, key)
        processed++
      } catch (e) {
        markFlatSourceFailed(db, root.slug, key, e.message)
        logger.warn(`Failed to sync ${key}`, { error: e.message })
      }
    })

    db.updateRootPageCount(root.slug)
    logger.info(`Done: ${adapter.constructor.displayName} (${processed} new, ${skipped} skipped)`)
    results[root.slug] = { processed, total: keys.length, skipped }
  }

  return results
}
