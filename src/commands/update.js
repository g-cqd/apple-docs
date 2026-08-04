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
import { scopeRootsFor } from '../lib/scope.js'
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
  // Default aligned with sync's rate-limit-friendly cap (sync.js): the old
  // 500 default let standalone `update` runs bypass the --aggressive guard.
  const concurrency = ctx.semaphore?.max ?? opts.concurrency ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '100', 10)
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
    // sync() runs root discovery and every adapter's discover() once and
    // hands the bundle in — discovery is network-heavy (WWDC year indexes,
    // GitHub trees, package catalogs) and used to run twice per sync.
    let discoveriesBySource
    let discoveryErrorsBySource
    if (opts.discoveries) {
      ({ discoveriesBySource, discoveryErrorsBySource } = opts.discoveries)
      adapterCtx.rootCatalogReady = opts.rootCatalogReady ?? adapterCtx.rootCatalogReady
    } else {
      if (adapters.some(adapter => ROOT_CATALOG_SOURCE_TYPES.has(adapter.constructor.type))) {
        try {
          await discoverRoots(db, rateLimiter, logger)
          adapterCtx.rootCatalogReady = true
        } catch (e) {
          logger.warn('Failed to refresh root catalog', { error: e.message })
        }
      }
      const discovered = await discoverAdaptersInParallel(adapters, adapterCtx)
      discoveriesBySource = discovered.discoveries
      discoveryErrorsBySource = discovered.errors
    }

    // Adapters run concurrently: they target disjoint hosts (Apple CDN,
    // GitHub, swift.org), so serializing them stacked each source's network
    // wall time end to end while every other host's rate budget sat idle.
    // The shared semaphore still caps aggregate in-flight fetches.
    const outcomes = await Promise.allSettled(adapters.map(async (adapter) => {
      const discoveryError = discoveryErrorsBySource.get(adapter.constructor.type)
      if (discoveryError) {
        logger.warn(`Discovery failed for source: ${adapter.constructor.type}`, { error: discoveryError.message })
        return { errCount: 1 }
      }

      const discovery = discoveriesBySource.get(adapter.constructor.type)
      // Explicit --roots wins; otherwise scope.json may narrow the
      // apple-docc adapter (and only that one) to its framework list.
      const adapterRoots = requestedRoots ?? scopeRootsFor(adapter, opts.scope ?? null)
      try {
        switch (adapter.constructor.syncMode) {
          case 'snapshot':
            return await updateGuidelinesSource(adapter, discovery, adapterRoots, adapterCtx)
          case 'flat':
            return await updateFlatSource(adapter, discovery, adapterRoots, concurrency, semaphore, adapterCtx)
          default:
            return await updateDoccSource(adapter, discovery, adapterRoots, concurrency, parallel, semaphore, adapterCtx)
        }
      } catch (e) {
        logger.warn(`Update failed for source: ${adapter.constructor.type}`, { error: e.message })
        return { errCount: 1 }
      }
    }))

    for (const outcome of outcomes) {
      const counts = outcome.status === 'fulfilled' ? outcome.value : { errCount: 1 }
      newCount += counts.newCount ?? 0
      modCount += counts.modCount ?? 0
      unchangedCount += counts.unchangedCount ?? 0
      delCount += counts.delCount ?? 0
      errCount += counts.errCount ?? 0
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
    // Best-effort WAL truncate after a write-heavy run — see sync.js.
    try { db.db.run('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* readers active */ }
  }
}
