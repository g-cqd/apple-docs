import { crawlRoot, discoverRoots } from '../pipeline/discover.js'
import { persistFetchedDocPage, persistNormalizedPage } from '../pipeline/persist.js'
import { applyGuidelinesSnapshot } from '../pipeline/sync-guidelines.js'
import { markFlatSourceFailed, markFlatSourceProcessed, seedFlatSourceProgress } from '../lib/flat-source-progress.js'
import { Semaphore } from '../lib/semaphore.js'
import { pool } from '../lib/pool.js'
import { getAdapter, getAllAdapters } from '../sources/registry.js'
import { ROOT_CATALOG_SOURCE_TYPES, normalizeList, validateRequestedSources, selectRootsForAdapter, filterPagesByRoots, discoverAdaptersInParallel } from './command-helpers.js'

/**
 * Check for documentation updates and pull changes.
 * @param {{ roots?: string[], sources?: string[], concurrency?: number, parallel?: number }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function update(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const concurrency = ctx.semaphore?.max ?? opts.concurrency ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10)
  const parallel = opts.parallel ?? 1
  const semaphore = ctx.semaphore ?? new Semaphore(concurrency)
  const requestedSources = normalizeList(opts.sources)
  const requestedRoots = normalizeList(opts.roots)

  validateRequestedSources(requestedSources)

  const adapters = ctx.adapters ?? (
    requestedSources
      ? requestedSources.map(getAdapter)
      : getAllAdapters()
  )
  const adapterCtx = { ...ctx, rootCatalogReady: false, semaphore }

  db.setActivity('update', opts.roots ?? null)

  let newCount = 0
  let modCount = 0
  let unchangedCount = 0
  let delCount = 0
  let errCount = 0

  try {
    if (adapters.some(adapter => ROOT_CATALOG_SOURCE_TYPES.has(adapter.constructor.type))) {
      try {
        await discoverRoots(db, rateLimiter, logger)
        adapterCtx.rootCatalogReady = true
      } catch (e) {
        logger.warn('Failed to refresh root catalog', { error: e.message })
      }
    }

    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } = await discoverAdaptersInParallel(adapters, adapterCtx)

    for (const adapter of adapters) {
      try {
        const discoveryError = discoveryErrorsBySource.get(adapter.constructor.type)
        if (discoveryError) {
          errCount++
          logger.warn(`Discovery failed for source: ${adapter.constructor.type}`, { error: discoveryError.message })
          continue
        }

        const discovery = discoveriesBySource.get(adapter.constructor.type)
        let counts
        switch (adapter.constructor.syncMode) {
          case 'snapshot':
            counts = await updateGuidelinesSource(adapter, discovery, requestedRoots, adapterCtx)
            break
          case 'flat':
            counts = await updateFlatSource(adapter, discovery, requestedRoots, concurrency, semaphore, adapterCtx)
            break
          default:
            counts = await updateDoccSource(adapter, discovery, requestedRoots, concurrency, parallel, semaphore, adapterCtx)
            break
        }

        newCount += counts.newCount
        modCount += counts.modCount
        unchangedCount += counts.unchangedCount
        delCount += counts.delCount
        errCount += counts.errCount
      } catch (e) {
        errCount++
        logger.warn(`Update failed for source: ${adapter.constructor.type}`, { error: e.message })
      }
    }

    if (opts.indexBody) {
      const { indexBodyIncremental } = await import('../pipeline/index-body.js')
      await indexBodyIncremental(db, dataDir, logger)
    }

    const durationMs = Date.now() - startMs
    db.addUpdateLog({
      action: 'update',
      newCount,
      modCount,
      delCount,
      errCount,
      durationMs,
    })

    return { newCount, modCount, unchangedCount, delCount, errCount, durationMs }
  } finally {
    db.clearActivity()
  }
}

async function updateDoccSource(adapter, discovery, requestedRoots, concurrency, parallel, semaphore, ctx) {
  const { db, dataDir, logger } = ctx
  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const modified = []
  const deleted = []
  let checked = 0

  if (pages.length > 0) {
    logger.info(`Checking ${pages.length} ${adapter.constructor.displayName} pages for updates (concurrency: ${concurrency})...`)
  }

  await Promise.all(pages.map(page =>
    semaphore.run(async () => {
      try {
        const result = await adapter.check(page.path, {
          etag: page.etag,
          lastModified: page.last_modified,
          contentHash: page.content_hash,
        }, ctx)

        switch (result.status) {
          case 'unchanged':
            counts.unchangedCount++
            break
          case 'modified':
            modified.push(page)
            break
          case 'deleted':
            deleted.push(page.path)
            break
          default:
            counts.errCount++
            break
        }
      } catch (e) {
        counts.errCount++
        logger.warn(`Check failed: ${page.path}`, { error: e.message })
      }

      checked++
      if (checked % 1000 === 0) {
        logger.info(`Checked ${checked}/${pages.length} (${modified.length} modified, ${deleted.length} deleted)`)
      }
    })
  ))

  if (pages.length > 0) {
    logger.info(`Check complete for ${adapter.constructor.displayName}: ${modified.length} modified, ${deleted.length} deleted, ${counts.unchangedCount} unchanged, ${counts.errCount} errors`)
  }

  if (modified.length > 0) {
    logger.info(`Pulling ${modified.length} modified ${adapter.constructor.displayName} pages...`)
    await Promise.all(modified.map(page =>
      semaphore.run(async () => {
        try {
          const fetchResult = await adapter.fetch(page.path, ctx)
          await persistFetchedDocPage({
            db,
            dataDir,
            rootId: page.root_id,
            path: page.path,
            sourceType: adapter.constructor.type,
            json: fetchResult.payload,
            etag: fetchResult.etag,
            lastModified: fetchResult.lastModified,
          })
          counts.modCount++
        } catch (e) {
          counts.errCount++
          logger.warn(`Pull failed: ${page.path}`, { error: e.message })
        }
      })
    ))
  }

  for (const path of deleted) {
    db.markPageDeleted(path)
    counts.delCount++
  }

  const newRoots = selectRootsForAdapter(adapter, discovery, db, requestedRoots).filter(root => {
    const stats = db.getCrawlStats(root.slug)
    return stats.processed === 0 && stats.pending === 0
  })

  if (newRoots.length > 0) {
    logger.info(`Crawling ${newRoots.length} new ${adapter.constructor.displayName} root(s)...`)

    if (parallel <= 1) {
      for (const root of newRoots) {
        try {
          const result = await crawlRoot(db, dataDir, ctx.rateLimiter, root.slug, logger, null, {
            semaphore,
            adapter,
          })
          counts.newCount += result.processed
        } catch (e) {
          counts.errCount++
          logger.warn(`Crawl failed for new root: ${root.slug}`, { error: e.message })
        }
      }
    } else {
      await pool(newRoots, parallel, async (root) => {
        try {
          const result = await crawlRoot(db, dataDir, ctx.rateLimiter, root.slug, logger, null, {
            semaphore,
            adapter,
          })
          counts.newCount += result.processed
        } catch (e) {
          counts.errCount++
          logger.warn(`Crawl failed for new root: ${root.slug}`, { error: e.message })
        }
      })
    }
  }

  return counts
}

async function updateFlatSource(adapter, discovery, requestedRoots, _concurrency, semaphore, ctx) {
  const { db, dataDir, logger } = ctx
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const roots = selectRootsForAdapter(adapter, discovery, db, requestedRoots)
  const root = roots[0] ?? null
  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const discoveredKeys = discovery.keys ?? []
  const discoveredKeySet = new Set(discoveredKeys)
  const stalePages = pages.filter(page => !discoveredKeySet.has(page.path))
  const trackedPages = pages.filter(page => discoveredKeySet.has(page.path))
  const existingKeys = new Set(trackedPages.map(page => page.path))

  if (root) {
    seedFlatSourceProgress(db, root.slug, discoveredKeys, existingKeys)
  }

  if (stalePages.length > 0) {
    logger.info(`Removing ${stalePages.length} stale ${adapter.constructor.displayName} pages...`)
    for (const page of stalePages) {
      db.markPageDeleted(page.path)
      counts.delCount++
    }
  }

  // Check existing pages for updates
  if (trackedPages.length > 0) {
    logger.info(`Checking ${trackedPages.length} ${adapter.constructor.displayName} pages for updates...`)
    const modified = []

    await Promise.all(trackedPages.map(page =>
      semaphore.run(async () => {
        try {
          const result = await adapter.check(page.path, {
            etag: page.etag,
            lastModified: page.last_modified,
            contentHash: page.content_hash,
          }, ctx)

          switch (result.status) {
            case 'unchanged':
              counts.unchangedCount++
              break
            case 'modified':
              modified.push(page)
              break
            case 'deleted':
              db.markPageDeleted(page.path)
              if (root && discoveredKeySet.has(page.path)) {
                markFlatSourceFailed(db, root.slug, page.path, 'Source entry is no longer available')
              }
              counts.delCount++
              break
            default:
              if (root && discoveredKeySet.has(page.path)) {
                markFlatSourceFailed(db, root.slug, page.path, 'Update check failed')
              }
              counts.errCount++
              break
          }
        } catch (e) {
          if (root && discoveredKeySet.has(page.path)) {
            markFlatSourceFailed(db, root.slug, page.path, e.message)
          }
          counts.errCount++
          logger.warn(`Check failed: ${page.path}`, { error: e.message })
        }
      })
    ))

    if (modified.length > 0) {
      logger.info(`Pulling ${modified.length} modified ${adapter.constructor.displayName} pages...`)
      await Promise.all(modified.map(page =>
        semaphore.run(async () => {
          try {
            const fetchResult = await adapter.fetch(page.path, ctx)
            const normalized = adapter.normalize(page.path, fetchResult.payload)
            adapter.validateNormalizeResult(normalized)

            await persistNormalizedPage({
              db,
              dataDir,
              rootId: page.root_id,
              path: page.path,
              sourceType: adapter.constructor.type,
              rawPayload: fetchResult.payload,
              normalized,
              etag: fetchResult.etag ?? null,
              lastModified: fetchResult.lastModified ?? null,
            })
            if (root && discoveredKeySet.has(page.path)) {
              markFlatSourceProcessed(db, root.slug, page.path)
            }
            counts.modCount++
          } catch (e) {
            if (root && discoveredKeySet.has(page.path)) {
              markFlatSourceFailed(db, root.slug, page.path, e.message)
            }
            counts.errCount++
            logger.warn(`Pull failed: ${page.path}`, { error: e.message })
          }
        })
      ))
    }
  }

  const newKeys = discoveredKeys.filter(k => !existingKeys.has(k))

  if (newKeys.length > 0) {
    logger.info(`Fetching ${newKeys.length} new ${adapter.constructor.displayName} pages...`)
    const rootId = roots[0]?.id ?? null

    await Promise.all(newKeys.map(key =>
      semaphore.run(async () => {
        try {
          const fetchResult = await adapter.fetch(key, ctx)
          const normalized = adapter.normalize(key, fetchResult.payload)
          adapter.validateNormalizeResult(normalized)

          await persistNormalizedPage({
            db,
            dataDir,
            rootId,
            path: key,
            sourceType: adapter.constructor.type,
            rawPayload: fetchResult.payload,
            normalized,
            etag: fetchResult.etag ?? null,
            lastModified: fetchResult.lastModified ?? null,
          })
          if (root) {
            markFlatSourceProcessed(db, root.slug, key)
          }
          counts.newCount++
        } catch (e) {
          if (root) {
            markFlatSourceFailed(db, root.slug, key, e.message)
          }
          counts.errCount++
          logger.warn(`Fetch failed: ${key}`, { error: e.message })
        }
      })
    ))
  }

  if (root) {
    db.updateRootPageCount(root.slug)
  }
  return counts
}

async function updateGuidelinesSource(adapter, discovery, requestedRoots, ctx) {
  const { db, dataDir, logger } = ctx
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const roots = selectRootsForAdapter(adapter, discovery, db, requestedRoots)

  if (roots.length === 0) {
    return counts
  }

  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const previousState = pages[0]
    ? { etag: pages[0].etag, lastModified: pages[0].last_modified, contentHash: pages[0].content_hash }
    : null

  logger.info(`Checking ${adapter.constructor.displayName} for updates...`)

  let result
  try {
    result = await adapter.check(roots[0].slug, previousState, ctx)
  } catch (e) {
    counts.errCount++
    logger.warn(`${adapter.constructor.displayName} update check failed`, { error: e.message })
    return counts
  }

  switch (result.status) {
    case 'unchanged':
      counts.unchangedCount += pages.length
      return counts
    case 'deleted':
      for (const page of pages) {
        db.markPageDeleted(page.path)
        counts.delCount++
      }
      return counts
    case 'error':
      counts.errCount++
      return counts
    default:
      break
  }

  const fetchResult = await adapter.fetch(roots[0].slug, ctx)
  const syncResult = await applyGuidelinesSnapshot(db, dataDir, {
    html: fetchResult.payload.html,
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
    sections: fetchResult.payload.sections,
    lastUpdated: fetchResult.payload.lastUpdated,
  })

  logger.info(`Guidelines re-synced: ${syncResult.sections} sections`)

  if (pages.length === 0) {
    counts.newCount += syncResult.sections
  } else {
    counts.modCount += syncResult.sections
  }

  return counts
}
