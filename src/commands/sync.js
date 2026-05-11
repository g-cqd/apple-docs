import { convertAll } from '../pipeline/convert.js'
import { crawlRoot, discoverRoots } from '../pipeline/discover.js'
import { downloadMissing } from '../pipeline/download.js'
import { persistNormalizedPage } from '../pipeline/persist.js'
import { applyGuidelinesSnapshot } from '../pipeline/sync-guidelines.js'
import { markFlatSourceFailed, markFlatSourceProcessed, seedFlatSourceProgress } from '../lib/flat-source-progress.js'
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
 *   3. Crawl each adapter, retrying any previously-failed entries
 *   4. Download missing raw payloads, convert to Markdown
 *   5. Index body content (FTS) incrementally
 *   6. Sync Apple typography (DMG download + extract) and SF Symbols (public + private)
 *   7. Pre-render every SF Symbol to SVG (idempotent — skips already-rendered ones)
 *   8. Run schema migrations, clean invalid entries, re-resolve failures, minify raw JSON (was `doctor`)
 *
 * Always full coverage. The only flag is `--full`, which forces a clean re-crawl
 * (resets failed entries everywhere, ignores incremental shortcuts) instead of
 * a normal resumable refresh.
 *
 * @param {{ full?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function sync(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const fullRebuild = !!opts.full
  // A25: bound the default in-flight fetch concurrency to 100. The
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
    throw new Error(`--concurrency ${concurrency} > 100 requires --aggressive (or set APPLE_DOCS_CONCURRENCY explicitly)`)
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
    const crawlResults = {}
    const failedSources = []
    let guidelinesResult = null
    let rootsCrawled = 0
    const { discoveries: discoveriesBySource, errors: discoveryErrorsBySource } = await discoverAdaptersInParallel(adapters, adapterCtx)

    // 3. Crawl every adapter end-to-end.
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
        const roots = selectRootsForAdapter(adapter, discovery, db, null)

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
    const filters = { roots: null, sources: activeSourceTypes }

    // 4. Backfill any missing raw payloads + materialize Markdown.
    const dlResult = await downloadMissing(db, dataDir, rateLimiter, logger, null, filters, { semaphore })

    const pendingConversions = filterPages(db.getUnconvertedPages(), null, activeSourceTypes)
    let cvResult = { converted: 0, total: 0 }
    if (pendingConversions.length > 0) {
      logger.info(`Converting ${pendingConversions.length} remaining pages to Markdown...`)
      cvResult = await convertAll(db, dataDir, logger, null, filters, { semaphore })
    }

    // 5. Body index. `--full` triggers a clean rebuild from scratch; otherwise
    // we update only the rows whose content fingerprint changed since the
    // last index pass.
    logger.info(fullRebuild ? 'Rebuilding body index...' : 'Indexing body content...')
    const idxResult = fullRebuild
      ? await indexBodyFull(db, dataDir, logger)
      : await indexBodyIncremental(db, dataDir, logger)
    const bodyIndexed = idxResult.indexed

    // 6. Resource sync — Apple typography + SF Symbols. Both are first-class
    // corpus citizens; a corpus-wide refresh implies full asset coverage.
    //
    // Two opt-out / opt-in switches:
    //   APPLE_DOCS_SKIP_RESOURCES=1   — bypass the entire resource pass
    //                                    (used by the unit tests so they
    //                                    don't spawn Swift workers / mount
    //                                    DMGs against a tmpdir corpus).
    //   APPLE_DOCS_DOWNLOAD_FONTS=1   — also fetch + extract Apple's font
    //                                    DMGs. Off by default; the snapshot
    //                                    CI sets it so the published
    //                                    archive ships every Apple font.
    let fontsResult = null
    let symbolsResult = null
    let symbolsRenderResult = null

    if (process.env.APPLE_DOCS_SKIP_RESOURCES === '1') {
      logger.info('APPLE_DOCS_SKIP_RESOURCES=1 — skipping fonts + SF Symbols sync')
    } else {
      const downloadFonts = process.env.APPLE_DOCS_DOWNLOAD_FONTS === '1'
      logger.info(`Syncing Apple typography${downloadFonts ? ' (downloading DMGs)' : ''}...`)
      const fontsStep = await runStep(
        'sync.apple-fonts',
        () => syncAppleFonts({ downloadFonts }, ctx),
        { logger },
      )
      if (fontsStep.ok) {
        fontsResult = fontsStep.result
        logger.info(`Synced ${fontsResult.families} font families, ${fontsResult.files} font files`)
      } else {
        failedSources.push({ source: 'apple-fonts', error: fontsStep.error.message })
      }

      const symbolsStep = await runStep('sync.sf-symbols', async () => {
        logger.info('Syncing SF Symbols...')
        const counts = { public: 0, private: 0 }
        for (const scope of ['public', 'private']) {
          counts[scope] = await syncSfSymbols({ scope }, ctx)
        }
        logger.info(`Synced ${counts.public} public + ${counts.private} private SF Symbols`)

        // 6b. Stamp each public symbol with its Unicode codepoint from
        // SF-Pro.ttf via a one-shot Swift worker. Idempotent; safely
        // skipped when the font isn't present in the snapshot.
        try {
          await stampSfSymbolCodepoints({}, ctx)
        } catch (err) {
          logger.warn(`SF Symbol codepoint stamping failed: ${err?.message ?? err}`)
        }

        // 7. Pre-render every symbol geometry variant. Idempotent when the
        // snapshot metadata matches the renderer + variant matrix; otherwise
        // refreshes the snapshot SVGs so runtime rendering is macOS-stable.
        logger.info('Pre-rendering SF Symbols...')
        const renders = await prerenderSfSymbols({}, ctx)
        logger.info(`Pre-rendered ${renders.rendered ?? 0} symbol variants (${renders.skipped ?? 0} skipped)`)
        return { counts, renders }
      }, { logger })
      if (symbolsStep.ok) {
        symbolsResult = symbolsStep.result.counts
        symbolsRenderResult = symbolsStep.result.renders
      } else {
        failedSources.push({ source: 'sf-symbols', error: symbolsStep.error.message })
      }
    }

    // 8. Schema migrations + invalid-entry cleanup + parent-ref re-resolution +
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
