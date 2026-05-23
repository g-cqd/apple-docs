import { convertAll } from '../pipeline/convert.js'
import { crawlRoot, discoverRoots } from '../pipeline/discover.js'
import { downloadMissing } from '../pipeline/download.js'
import { persistNormalizedPage } from '../pipeline/persist.js'
import { applyGuidelinesSnapshot } from '../pipeline/sync-guidelines.js'
import { markFlatSourceFailed, markFlatSourceProcessed, seedFlatSourceProgress } from '../lib/flat-source-progress.js'
import { ValidationError } from '../lib/errors.js'
import { Semaphore } from '../lib/semaphore.js'
import { pool } from '../lib/pool.js'
import { runStep } from '../lib/run-step.js'
import { getAllAdapters } from '../sources/registry.js'
import { ROOT_CATALOG_SOURCE_TYPES, selectRootsForAdapter, filterPages, discoverAdaptersInParallel } from './command-helpers.js'
import { syncAppleFonts, syncSfSymbols, prerenderSfSymbols, stampSfSymbolCodepoints } from '../resources/apple-assets.js'
import { update } from './update.js'
import { consolidate } from './consolidate.js'
import { indexBodyFull, indexBodyIncremental } from '../pipeline/index-body.js'

/**
 * Full corpus pipeline. Single entry point for refreshing everything end-to-end:
 *
 *   1. Detect changed pages on every existing source via HEAD checks (was `update`)
 *   2. Discover roots (catalog sources) and adapter pages
 *   3. Crawl every adapter end-to-end (all adapters in parallel; per-root parallelism inside)
 *   4. Download missing raw payloads, convert to Markdown
 *   5. Body index (FTS) + resources (fonts, SF Symbols, prerender) run concurrently
 *   6. Run schema migrations, clean invalid entries, re-resolve failures, minify raw JSON
 *
 * Always full coverage. The only flag is `--full`, which forces a clean re-crawl
 * (resets failed entries everywhere, ignores incremental shortcuts) instead of
 * a normal resumable refresh.
 *
 * Independent phases run concurrently:
 *   - All 11 source adapters' crawls run in parallel (Promise.allSettled).
 *   - Body-index and the resources phase overlap (Promise.all).
 *   - Inside resources, fonts ∥ symbols catalog; stamp depends on both; prerender depends only on symbols.
 *
 * @param {{ full?: boolean, aggressive?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger, semaphore?, adapters?, readerPool? }} ctx
 */
export async function sync(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const fullRebuild = !!opts.full
  // bound the default in-flight fetch concurrency to 100. The
  // previous default (500) saturates Apple's per-IP rate limit instantly
  // and is friendly only on first-time bulk syncs. Operators who want
  // the old behavior pass --aggressive (or set APPLE_DOCS_CONCURRENCY
  // explicitly).
  const DEFAULT_CONCURRENCY = 100
  const AGGRESSIVE_CONCURRENCY = 500
  const envConcurrency = process.env.APPLE_DOCS_CONCURRENCY != null
    ? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY, 10)
    : null
  const concurrency = ctx.semaphore?.max
    ?? envConcurrency
    ?? (opts.aggressive ? AGGRESSIVE_CONCURRENCY : DEFAULT_CONCURRENCY)
  if (concurrency > 100 && !opts.aggressive && envConcurrency == null) {
    throw new ValidationError(`--concurrency ${concurrency} > 100 requires --aggressive (or set APPLE_DOCS_CONCURRENCY explicitly)`)
  }
  const parallel = Number.parseInt(process.env.APPLE_DOCS_PARALLEL ?? '10', 10)
  const semaphore = ctx.semaphore ?? new Semaphore(concurrency)

  const adapters = ctx.adapters ?? getAllAdapters()
  const adapterCtx = { ...ctx, rootCatalogReady: false, semaphore, fullSync: fullRebuild }

  db.setActivity('sync', null)

  let updateResult = null
  try {
    // 1. HEAD-check existing pages on every source for upstream modifications.
    //    Pulls changed pages in place; deleted pages are tombstoned. Flat sources
    //    detect added/removed keys at the same time. Resource sync (fonts +
    //    symbols) is suppressed here — sync owns it as its own dedicated step
    //    further down so the work doesn't run twice.
    const updateStep = await runStep(
      'sync.update',
      () => update({ skipFonts: true, skipSymbols: true }, { ...ctx, semaphore, adapters }),
      { logger },
    )
    if (updateStep.ok) updateResult = updateStep.result
    db.setActivity('sync', null)

    // 2. Root discovery for catalog-driven sources (apple-docc et al).
    if (adapters.some(adapter => ROOT_CATALOG_SOURCE_TYPES.has(adapter.constructor.type))) {
      await discoverRoots(db, rateLimiter, logger)
      adapterCtx.rootCatalogReady = true
    }

    const crawlOpts = { retryFailed: true, semaphore }
    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } = await discoverAdaptersInParallel(adapters, adapterCtx)

    // 3. Crawl every adapter end-to-end in parallel. Per-host rate limits in
    //    rateLimiter keep upstream load bounded; the global semaphore caps
    //    aggregate in-flight fetches; per-root parallelism (APPLE_DOCS_PARALLEL)
    //    runs inside each adapter's crawlRoots. Adapters target disjoint
    //    hosts so concurrent crawls do not contend on the same upstream
    //    budget.
    const adapterOutcomes = await Promise.allSettled(
      adapters.map(adapter => runAdapterStep(adapter, {
        ctx,
        adapterCtx,
        db,
        dataDir,
        logger,
        discoveriesBySource,
        discoveryErrorsBySource,
        parallel,
        concurrency,
        crawlOpts,
      })),
    )

    const crawlResults = {}
    const failedSources = []
    let guidelinesResult = null
    let rootsCrawled = 0
    for (const settled of adapterOutcomes) {
      // Promise.allSettled with a body that already try/catches means
      // settled.status is always 'fulfilled'. Defensive 'rejected' branch
      // for unanticipated throws from the wrapper itself.
      if (settled.status === 'rejected') {
        failedSources.push({ source: 'unknown', error: String(settled.reason?.message ?? settled.reason) })
        continue
      }
      const outcome = settled.value
      if (outcome.error) {
        failedSources.push({ source: outcome.type, error: outcome.error.message })
        continue
      }
      if (outcome.results) Object.assign(crawlResults, outcome.results)
      if (outcome.guidelinesResult) guidelinesResult = outcome.guidelinesResult
      if (outcome.rootsCrawled) rootsCrawled += outcome.rootsCrawled
    }

    const activeSourceTypes = adapters.map(adapter => adapter.constructor.type)
    const filters = { roots: null, sources: activeSourceTypes }

    // 4. Backfill any missing raw payloads + materialize Markdown.
    const dlResult = await downloadMissing(db, dataDir, rateLimiter, logger, null, filters, { semaphore })

    const pendingConversions = filterPages(db.getUnconvertedPages(), null, activeSourceTypes)
    let cvResult = { converted: 0, total: 0 }
    if (pendingConversions.length > 0) {
      logger.info(`Converting ${pendingConversions.length} remaining pages to Markdown...`)
      cvResult = await convertAll(db, dataDir, logger, null, filters, { semaphore })
    }

    // 5. Body index + resources run concurrently. They touch disjoint tables
    //    (body index: documents_body_fts + schema_meta; resources:
    //    sf_symbols + apple_font_*). bun:sqlite serialises SQL on the
    //    single connection, but the wall-clock win comes from the disk + network
    //    + Swift-worker I/O overlap between the two phases.
    const [idxOutcome, resOutcome] = await Promise.all([
      runBodyIndex({ db, dataDir, logger, fullRebuild }),
      runResourcesPhase({ ctx, logger }),
    ])
    const bodyIndexed = idxOutcome.indexed
    for (const failure of resOutcome.failedSources) failedSources.push(failure)
    const fontsResult = resOutcome.fontsResult
    const symbolsResult = resOutcome.symbolsResult
    const symbolsRenderResult = resOutcome.symbolsRenderResult

    // 6. Schema migrations + invalid-entry cleanup + parent-ref re-resolution +
    // raw JSON minification. Idempotent and cheap when there's nothing to do.
    const doctorStep = await runStep(
      'sync.consolidate',
      () => consolidate({ minify: true }, { ...ctx, semaphore }),
      { logger },
    )
    const doctorResult = doctorStep.ok ? doctorStep.result : null

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
      update: updateResult,
      fonts: fontsResult,
      symbols: symbolsResult,
      symbolsRender: symbolsRenderResult,
      doctor: doctorResult,
      durationMs,
    }
  } finally {
    db.clearActivity()
    try { await ctx.readerPool?.recycle?.() } catch {}
  }
}

/**
 * Run one adapter's crawl pipeline. Returns a result tuple the outer
 * sync() reduces into the shared accumulators after Promise.allSettled.
 *
 * Captures errors locally so a single adapter failing never aborts its
 * siblings — the outer reducer turns `outcome.error` into a `failedSources`
 * entry.
 */
async function runAdapterStep(adapter, env) {
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
    const roots = selectRootsForAdapter(adapter, discovery, db, null)

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
        const rootSlugs = roots.map(root => root.slug)
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
    logger.error(`Source ${type} failed`, { error: error.message })
    return { type, mode, error }
  }
}

/**
 * Body-index phase. Incremental by default; `--full` triggers a clean
 * rebuild. Returns `{ indexed }` so the outer sync() can surface it.
 */
async function runBodyIndex({ db, dataDir, logger, fullRebuild }) {
  logger.info(fullRebuild ? 'Rebuilding body index...' : 'Indexing body content...')
  const idxResult = fullRebuild
    ? await indexBodyFull(db, dataDir, logger)
    : await indexBodyIncremental(db, dataDir, logger)
  return { indexed: idxResult.indexed ?? 0 }
}

/**
 * Resources phase. Runs four tasks with the dependency graph:
 *
 *   fonts ──────────────────────────────────┐
 *   symbols ─┬─ prerender (depends on symbols only)
 *            └──────────────────────────────┐
 *                                           ▼
 *                                      stamp (needs fonts + symbols)
 *
 * Each task is wrapped in runStep so failures stay isolated and
 * activity tracking captures per-step duration.
 */
async function runResourcesPhase({ ctx, logger }) {
  const failedSources = []
  let fontsResult = null
  let symbolsResult = null
  let symbolsRenderResult = null

  if (process.env.APPLE_DOCS_SKIP_RESOURCES === '1') {
    logger.info('APPLE_DOCS_SKIP_RESOURCES=1 — skipping fonts + SF Symbols sync')
    return { failedSources, fontsResult, symbolsResult, symbolsRenderResult }
  }

  const downloadFonts = process.env.APPLE_DOCS_DOWNLOAD_FONTS === '1'
  logger.info(`Syncing Apple typography${downloadFonts ? ' (downloading DMGs)' : ''}...`)

  const fontsTask = runStep(
    'sync.apple-fonts',
    () => syncAppleFonts({ downloadFonts }, ctx),
    { logger },
  )

  const symbolsTask = runStep(
    'sync.sf-symbols-catalog',
    async () => {
      logger.info('Syncing SF Symbols catalog (public + private)...')
      const [publicCount, privateCount] = await Promise.all([
        syncSfSymbols({ scope: 'public' }, ctx),
        syncSfSymbols({ scope: 'private' }, ctx),
      ])
      logger.info(`Synced ${publicCount} public + ${privateCount} private SF Symbols`)
      return { public: publicCount, private: privateCount }
    },
    { logger },
  )

  // Prerender only depends on the symbol catalog. Start it as soon as
  // symbols completes — does not wait for fonts.
  const prerenderTask = symbolsTask.then(async outcome => {
    if (!outcome.ok) return { ok: true, label: 'sync.sf-symbols-prerender', result: null, ms: 0 }
    return runStep(
      'sync.sf-symbols-prerender',
      async () => {
        logger.info('Pre-rendering SF Symbols...')
        const renders = await prerenderSfSymbols({}, ctx)
        logger.info(`Pre-rendered ${renders.rendered ?? 0} symbol variants (${renders.skipped ?? 0} skipped)`)
        return renders
      },
      { logger },
    )
  })

  // Stamp needs SF-Pro.ttf extracted (fonts) AND sf_symbols rows
  // (symbols). Gracefully skips when either prerequisite failed.
  const stampTask = Promise.all([fontsTask, symbolsTask]).then(async ([fOutcome, sOutcome]) => {
    if (!sOutcome.ok) return { ok: true, label: 'sync.sf-symbols-stamp', result: null, ms: 0 }
    return runStep(
      'sync.sf-symbols-stamp',
      async () => stampSfSymbolCodepoints({}, ctx),
      { logger },
    )
  })

  const [fontsOutcome, symbolsOutcome, prerenderOutcome, stampOutcome] =
    await Promise.all([fontsTask, symbolsTask, prerenderTask, stampTask])

  if (fontsOutcome.ok) {
    fontsResult = fontsOutcome.result
    if (fontsResult) {
      logger.info(`Synced ${fontsResult.families} font families, ${fontsResult.files} font files`)
    }
  } else {
    failedSources.push({ source: 'apple-fonts', error: fontsOutcome.error.message })
  }

  if (symbolsOutcome.ok) {
    symbolsResult = symbolsOutcome.result
  } else {
    failedSources.push({ source: 'sf-symbols', error: symbolsOutcome.error.message })
  }

  if (prerenderOutcome.ok) {
    symbolsRenderResult = prerenderOutcome.result
  } else {
    failedSources.push({ source: 'sf-symbols-prerender', error: prerenderOutcome.error.message })
  }

  if (!stampOutcome.ok) {
    // Stamping is best-effort; surface as a warning, not a failure,
    // matching the previous try/catch behaviour.
    logger.warn(`SF Symbol codepoint stamping failed: ${stampOutcome.error.message}`)
  }

  return { failedSources, fontsResult, symbolsResult, symbolsRenderResult }
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

  // Group keys by their owning root using the first slug segment. Adapters
  // that publish multiple roots (e.g. swift-docc with three archive roots)
  // emit a single mixed `keys` array; partition it so each page is persisted
  // under the correct root_id.
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
        markFlatSourceFailed(db, root.slug, key, e.message)
        logger.warn(`Failed to sync ${key}`, { error: e.message })
      }
    })

    db.updateRootPageCount(root.slug)
    logger.info(`Done: ${adapter.constructor.displayName} ${root.slug} (${processed} new, ${skipped} skipped)`)
    results[root.slug] = { processed, total: rootKeys.length, skipped }
  }

  return results
}
