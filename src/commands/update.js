import { discoverRoots } from '../pipeline/discover.js'
import { Semaphore } from '../lib/semaphore.js'
import { getAdapter, getAllAdapters } from '../sources/registry.js'
import {
  ROOT_CATALOG_SOURCE_TYPES,
  discoverAdaptersInParallel,
  normalizeList,
  validateRequestedSources,
} from './command-helpers.js'
import { syncAppleFonts, syncSfSymbols } from '../resources/apple-assets.js'
import { updateDoccSource } from './update/docc.js'
import { updateFlatSource } from './update/flat.js'
import { updateGuidelinesSource } from './update/guidelines.js'

/**
 * Check for documentation updates and pull changes.
 * @param {{ roots?: string[], sources?: string[], concurrency?: number, parallel?: number }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function update(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const concurrency = ctx.semaphore?.max ?? opts.concurrency ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '500', 10)
  const parallel = opts.parallel ?? 10
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

    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } =
      await discoverAdaptersInParallel(adapters, adapterCtx)

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

    // Refresh resource indexes (fonts, SF Symbols) on whole-corpus update runs.
    // Same gating as sync: skipped when the run is restricted via --roots/--sources.
    const restrictedRun = !!(requestedSources || requestedRoots)
    let fontsResult = null
    let symbolsResult = null
    if (!restrictedRun && opts.skipFonts !== true) {
      try {
        fontsResult = await syncAppleFonts({ downloadFonts: !!opts.downloadFonts }, ctx)
      } catch (e) {
        logger.warn('Font refresh failed', { error: e.message })
      }
    }
    if (!restrictedRun && opts.skipSymbols !== true) {
      try {
        const counts = { public: 0, private: 0 }
        for (const scope of ['public', 'private']) {
          counts[scope] = await syncSfSymbols({ scope }, ctx)
        }
        symbolsResult = counts
      } catch (e) {
        logger.warn('SF Symbols refresh failed', { error: e.message })
      }
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

    return { newCount, modCount, unchangedCount, delCount, errCount, fonts: fontsResult, symbols: symbolsResult, durationMs }
  } finally {
    db.clearActivity()
    // Safety belt for the rare case where update runs in the same process as
    // an active reader pool (e.g. embedded tests): respawn workers so any
    // prepared statements reload against the post-write schema. WAL would
    // usually cover us without this; recycle is cheap when the pool is idle.
    try { await ctx.readerPool?.recycle?.() } catch { /* best-effort */ }
  }
}
