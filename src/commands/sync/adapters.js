/**
 * Per-adapter sync helpers. The outer `sync()` orchestrator dispatches
 * one of these per adapter via `Promise.allSettled`, so each returns
 * a structured outcome the orchestrator can reduce after every adapter
 * has settled — no shared accumulator mutation under concurrent awaits.
 */

import { markFlatSourceFailed, markFlatSourceProcessed, seedFlatSourceProgress } from '../../lib/flat-source-progress.js'
import { pool } from '../../lib/pool.js'
import { scopeRootsFor } from '../../lib/scope.js'
import { crawlRoot } from '../../pipeline/discover.js'
import { persistNormalizedPage } from '../../pipeline/persist.js'
import { applyGuidelinesSnapshot } from '../../pipeline/sync-guidelines.js'
import { selectRootsForAdapter } from '../command-helpers.js'

/**
 * Run one adapter's crawl pipeline. Returns a result tuple the outer
 * sync() reduces into the shared accumulators after Promise.allSettled.
 *
 * Captures errors locally so a single adapter failing never aborts its
 * siblings — the outer reducer turns `outcome.error` into a `failedSources`
 * entry.
 */
export async function runAdapterStep(/** @type {any} */ adapter, /** @type {any} */ env) {
  const { ctx, adapterCtx, db, dataDir, logger, discoveriesBySource, discoveryErrorsBySource, parallel, concurrency, crawlOpts } = env
  const type = adapter.constructor.type
  const displayName = adapter.constructor.displayName
  const mode = adapter.constructor.syncMode
  const stepStart = Date.now()

  try {
    const discoveryError = discoveryErrorsBySource.get(type)
    if (discoveryError) {
      logger.error(`Source ${type} failed`, { error: discoveryError.message })
      return { type, mode, error: discoveryError }
    }

    const discovery = discoveriesBySource.get(type)
    // scope.json may narrow apple-docc to an allow-list of frameworks;
    // every other adapter (and an absent scope) gets null = all roots.
    const roots = selectRootsForAdapter(adapter, discovery, db, scopeRootsFor(adapter, env.scope ?? null))

    logger.info(`Starting ${displayName} (mode=${mode}, roots=${roots.length})`)

    switch (mode) {
      case 'snapshot': {
        if (roots.length === 0) {
          logger.info(`Finished ${displayName} in ${Date.now() - stepStart}ms (no roots)`)
          return { type, mode }
        }
        const fetchResult = await adapter.fetch(roots[0].slug, adapterCtx)
        const guidelinesResult = await applyGuidelinesSnapshot(db, dataDir, fetchResult.payload)
        logger.info(`Finished ${displayName} in ${Date.now() - stepStart}ms (${guidelinesResult.sections} sections)`)
        return { type, mode, guidelinesResult }
      }
      case 'flat': {
        const results = await syncFlatSource(adapter, discovery, roots, concurrency, adapterCtx)
        logger.info(`Finished ${displayName} in ${Date.now() - stepStart}ms`)
        return { type, mode, results, rootsCrawled: roots.length }
      }
      default: {
        const rootSlugs = roots.map((root) => root.slug)
        if (rootSlugs.length === 0) {
          logger.info(`Finished ${displayName} in ${Date.now() - stepStart}ms (no roots)`)
          return { type, mode }
        }
        const results = await crawlRoots(rootSlugs, parallel, concurrency, ctx, crawlOpts, adapter)
        logger.info(`Finished ${displayName} in ${Date.now() - stepStart}ms`)
        return { type, mode, results, rootsCrawled: rootSlugs.length }
      }
    }
  } catch (error) {
    logger.error(`Source ${type} failed`, { error: /** @type {any} */ (error).message })
    return { type, mode, error }
  }
}

/**
 * Crawl every root for a `crawl`-mode adapter (apple-docc, hig) with
 * per-root parallelism bounded by `parallel`. Each root's per-page
 * fetches go through the shared `semaphore` carried in `crawlOpts`.
 */
export async function crawlRoots(
  /** @type {any} */ rootSlugs,
  /** @type {any} */ parallel,
  /** @type {any} */ concurrency,
  /** @type {any} */ ctx,
  /** @type {any} */ crawlOpts,
  /** @type {any} */ adapter,
) {
  const { db, dataDir, rateLimiter, logger } = ctx
  /** @type {Record<string, any>} */
  const results = {}

  if (parallel <= 1) {
    for (const slug of rootSlugs) {
      logger.info(`Crawling ${slug}...`)
      try {
        results[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, /** @type {any} */ (null), {
          ...crawlOpts,
          adapter,
        })
      } catch (e) {
        logger.error(`Crawl failed for ${slug}`, { error: /** @type {any} */ (e).message })
        results[slug] = { error: /** @type {any} */ (e).message }
      }
    }
    return results
  }

  logger.info(`Crawling ${rootSlugs.length} roots (${parallel} parallel, ${concurrency} max fetches, ${ctx.rateLimiter.rate} req/s)...`)
  await pool(rootSlugs, parallel, async (slug) => {
    logger.info(`Crawling ${slug}...`)
    try {
      results[slug] = await crawlRoot(db, dataDir, rateLimiter, slug, logger, /** @type {any} */ (null), {
        ...crawlOpts,
        adapter,
      })
      const result = results[slug]
      logger.info(`Done: ${slug} (${result.total} total, ${result.processed} new)`)
    } catch (e) {
      logger.error(`Crawl failed for ${slug}`, { error: /** @type {any} */ (e).message })
      results[slug] = { error: /** @type {any} */ (e).message }
    }
  })
  return results
}

/**
 * Sync a `flat`-mode adapter (swift-docc, wwdc, etc.). Adapters that
 * publish multiple roots emit a single mixed `keys` array; partition
 * by the first slug segment so each page is persisted under the
 * correct `root_id`.
 */
export async function syncFlatSource(
  /** @type {any} */ adapter,
  /** @type {any} */ discovery,
  /** @type {any} */ roots,
  /** @type {any} */ concurrency,
  /** @type {any} */ ctx,
) {
  const { db, dataDir, logger } = ctx
  /** @type {Record<string, any>} */
  const results = {}
  const keys = discovery.keys ?? []

  const keysByRootSlug = new Map()
  for (const root of roots) keysByRootSlug.set(root.slug, [])
  for (const key of keys) {
    const slug = key.split('/', 1)[0]
    if (!keysByRootSlug.has(slug)) keysByRootSlug.set(slug, [])
    keysByRootSlug.get(slug).push(key)
  }

  for (const root of roots) {
    let processed = 0
    let skipped = 0
    const rootKeys = keysByRootSlug.get(root.slug) ?? []
    const existingKeys = db.getActivePathsIn(rootKeys)

    logger.info(`Syncing ${adapter.constructor.displayName} (${rootKeys.length} keys for ${root.slug})...`)
    seedFlatSourceProgress(db, root.slug, rootKeys, existingKeys)

    await pool(rootKeys, concurrency, async (key) => {
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
        markFlatSourceFailed(db, root.slug, key, /** @type {any} */ (e).message)
        logger.warn(`Failed to sync ${key}`, { error: /** @type {any} */ (e).message })
      }
    })

    db.updateRootPageCount(root.slug)
    logger.info(`Done: ${adapter.constructor.displayName} ${root.slug} (${processed} new, ${skipped} skipped)`)
    results[root.slug] = { processed, total: rootKeys.length, skipped }
  }

  return results
}
