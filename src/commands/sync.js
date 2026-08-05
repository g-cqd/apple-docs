import { convertAll } from '../pipeline/convert.js'
import { discoverRoots } from '../pipeline/discover.js'
import { downloadMissing } from '../pipeline/download.js'
import { ValidationError } from '../lib/errors.js'
import { Semaphore } from '../lib/semaphore.js'
import { runStep } from '../lib/run-step.js'
import { getAllAdapters } from '../sources/registry.js'
import { loadScope, filterAdaptersByScope } from '../lib/scope.js'
import { ROOT_CATALOG_SOURCE_TYPES, filterPages, discoverAdaptersInParallel } from './command-helpers.js'
import { update } from './update.js'
import { consolidate } from './consolidate.js'
import { runAdapterStep } from './sync/adapters.js'
import { runEnrichPhase } from './sync/enrich.js'
import { runBodyIndex, runResourcesPhase } from './sync/phases.js'

/**
 * Full corpus pipeline. Single entry point for refreshing everything end-to-end:
 *
 *   1. Detect changed pages on every existing source via HEAD checks (was `update`)
 *   2. Discover roots (catalog sources) and adapter pages
 *   3. Crawl every adapter end-to-end (all adapters in parallel; per-root parallelism inside)
 *   4. Download missing raw payloads, convert to Markdown
 *   5. Enrich from Xcode's offline documentation asset (USR backfill + novel pages)
 *   6. Body index (FTS) + resources (fonts, SF Symbols, prerender) run concurrently
 *   7. Run schema migrations, clean invalid entries, re-resolve failures, minify raw JSON
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
 * Per-adapter logic lives in `./sync/adapters.js`; post-crawl phases in
 * `./sync/phases.js`. This file is the orchestrator.
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

  // Opt-in scope (<dataDir>/scope.json, issue #7): narrows sources and
  // apple-docc roots so refreshes stay as small as a pruned corpus.
  // Injected ctx.adapters (tests, harnesses) bypasses it entirely — no
  // scope.json means byte-identical full-coverage behavior.
  const scope = ctx.adapters ? null : loadScope(dataDir, { logger })
  const adapters = ctx.adapters ?? filterAdaptersByScope(getAllAdapters(), scope)
  const adapterCtx = { ...ctx, rootCatalogReady: false, semaphore, fullSync: fullRebuild }

  db.setActivity('sync', null)

  let updateResult = null
  let resourcesPromise = null
  try {
    // 1. Root discovery for catalog-driven sources (apple-docc et al) and
    //    every adapter's discover() — ONCE. Both the update step below and
    //    the crawl phase consume this bundle; running discovery per phase
    //    doubled the network-heavy discovers (WWDC year indexes, GitHub
    //    trees, the SwiftPackageIndex catalog, the technologies index).
    if (adapters.some(adapter => ROOT_CATALOG_SOURCE_TYPES.has(adapter.constructor.type))) {
      await discoverRoots(db, rateLimiter, logger)
      adapterCtx.rootCatalogReady = true
    }
    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } = await discoverAdaptersInParallel(adapters, adapterCtx)

    // Resources (fonts + SF Symbols catalog/prerender/stamp) touch only
    // sf_symbols/apple_font_* tables and local bundles — fully disjoint from
    // the corpus phases. Start them now so their disk/Swift-worker time
    // overlaps the network-bound update+crawl phases; awaited at step 6.
    resourcesPromise = runResourcesPhase({ ctx, logger, scope, fullRebuild, downloadFonts: opts.downloadFonts })

    // 2. HEAD-check existing pages on every source for upstream modifications.
    //    Pulls changed pages in place; deleted pages are tombstoned. Flat sources
    //    detect added/removed keys at the same time. Resource sync (fonts +
    //    symbols) is suppressed here — sync owns it as its own dedicated step
    //    further down so the work doesn't run twice.
    const updateStep = await runStep(
      'sync.update',
      // fullSync must be threaded here too: scope-sensitive adapters (Swift
      // Package Catalog) resolve their discovery scope from ctx.fullSync, and
      // omitting it made this update step discover only the curated 'official'
      // packages — tombstoning the entire previously-synced full catalog.
      () => update({
        skipFonts: true,
        skipSymbols: true,
        scope,
        discoveries: { discoveriesBySource, discoveryErrorsBySource },
        rootCatalogReady: adapterCtx.rootCatalogReady,
      }, { ...ctx, semaphore, adapters, fullSync: fullRebuild }),
      { logger },
    )
    if (updateStep.ok) updateResult = updateStep.result
    db.setActivity('sync', null)

    // Flat sources the update step fully handled (checked, tombstoned,
    // fetched new keys) are skipped by the crawl phase below.
    const updateHandledSources = updateStep.ok
      ? new Set(adapters.filter(a => a.constructor.syncMode === 'flat').map(a => a.constructor.type))
      : new Set()

    // Failed crawl entries are dominated by permanent misses (404ing
    // dictionary keys, consistently-403 deprecated selectors); resetting all
    // of them every run re-fetched thousands of known-dead URLs per sync.
    // `--full` still retries everything; the consolidate phase's transient
    // sweep handles the recoverable classes in between.
    const crawlOpts = { retryFailed: fullRebuild, semaphore }

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
        scope,
        updateHandledSources,
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

    // 5. Merge Xcode's offline Developer Documentation asset BEFORE the
    //    index phase so novel pages flow through the normal body-index
    //    build below (title/trigram FTS are trigger-maintained on insert).
    //    Local asset only, unless APPLE_DOCS_ENRICH_FETCH=1 opts into the
    //    CDN download (snapshot CI). Non-fatal: no asset means skip.
    //    Skipped entirely for partial syncs — injected ctx.adapters (tests,
    //    smoke harnesses) and scope.json-narrowed corpora alike: merging a
    //    ~350k-page asset into a partial corpus would flood it with novel
    //    pages from sources/roots that were deliberately excluded.
    const enrichResult = (ctx.adapters || scope)
      ? { skipped: true }
      : await runEnrichPhase({ db, logger, fullRebuild, enrichFetch: opts.enrichFetch })

    // 6. Body index + resources run concurrently. They touch disjoint tables
    //    (body index: documents_body_fts + schema_meta; resources:
    //    sf_symbols + apple_font_*). bun:sqlite serialises SQL on the
    //    single connection, but the wall-clock win comes from the disk + network
    //    + Swift-worker I/O overlap between the two phases.
    const [idxOutcome, resOutcome] = await Promise.all([
      runBodyIndex({ db, dataDir, logger, fullRebuild }),
      resourcesPromise,
    ])
    const bodyIndexed = idxOutcome.indexed
    for (const failure of resOutcome.failedSources) failedSources.push(failure)
    const fontsResult = resOutcome.fontsResult
    const symbolsResult = resOutcome.symbolsResult
    const symbolsRenderResult = resOutcome.symbolsRenderResult

    // 7. Schema migrations + invalid-entry cleanup + parent-ref re-resolution +
    // raw JSON minification. Idempotent and cheap when there's nothing to do.
    const doctorStep = await runStep(
      'sync.consolidate',
      () => consolidate({ minify: true }, { ...ctx, semaphore }),
      { logger },
    )
    const doctorResult = doctorStep.ok ? doctorStep.result : null

    // 8. Semantic embedding index — LAST, so it sees every mutation the
    //    pipeline made (crawl, enrich-added pages, consolidate cleanups).
    //    Incremental: new documents plus those whose updated_at advanced.
    //    Non-fatal — a missing model degrades to lexical-only, never fails
    //    the sync. Skipped for injected-adapter runs (tests) like enrich.
    let embeddingsResult = { status: 'skipped' }
    if (!ctx.adapters) {
      const embedStep = await runStep(
        'sync.index-embeddings',
        async () => {
          const { indexEmbeddings } = await import('./index-embeddings.js')
          return indexEmbeddings({ full: fullRebuild, fetchModels: opts.fetchModels }, ctx)
        },
        { logger },
      )
      embeddingsResult = embedStep.ok ? embedStep.result : { status: 'error', message: embedStep.error.message }
      if (embeddingsResult.status === 'error') logger.warn(`Semantic index skipped (lexical-only): ${embeddingsResult.message}`)
    }

    const durationMs = Date.now() - startMs
    const totalProcessed = Object.values(crawlResults).reduce((sum, result) => sum + (result.processed ?? 0), 0)

    db.addUpdateLog({
      action: 'sync',
      // Fold the update phase's counts in — the crawl-only number dropped
      // every modified/deleted/errored page and all flat-source work from
      // the operation log.
      newCount: totalProcessed + (updateResult?.newCount ?? 0),
      modCount: updateResult?.modCount ?? 0,
      delCount: updateResult?.delCount ?? 0,
      errCount: updateResult?.errCount ?? 0,
      durationMs,
    })

    return {
      rootsDiscovered: db.getRoots().length,
      rootsCrawled,
      crawlResults,
      failedSources,
      guidelines: guidelinesResult,
      downloaded: dlResult.downloaded,
      enrich: enrichResult,
      bodyIndexed,
      converted: cvResult.converted,
      update: updateResult,
      fonts: fontsResult,
      symbols: symbolsResult,
      symbolsRender: symbolsRenderResult,
      doctor: doctorResult,
      embeddings: embeddingsResult,
      durationMs,
    }
  } finally {
    // If sync aborted mid-flight, let the early-started resources phase
    // settle before teardown — the WAL truncate below must not race it.
    try { await resourcesPromise } catch { /* reported via failedSources */ }
    db.clearActivity()
    try { await ctx.readerPool?.recycle?.() } catch {}
    // A multi-hour sync under WAL with long-lived readers can leave a WAL
    // that passive autocheckpoints never truncate. Best-effort TRUNCATE
    // after the recycle (no active readers from this process) returns the
    // space and keeps reader page-cache behavior predictable.
    try { db.db.run('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* readers active */ }
  }
}
