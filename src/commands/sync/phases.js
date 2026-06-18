/**
 * Post-crawl sync phases — body-index + resources. Both run
 * concurrently because they touch disjoint tables (body index:
 * documents_body_fts + schema_meta; resources: sf_symbols +
 * apple_font_*) and gain wall-clock from I/O overlap on the shared
 * bun:sqlite connection.
 */

import { runStep } from '../../lib/run-step.js'
import { indexBodyFull, indexBodyIncremental } from '../../pipeline/index-body.js'
import { prerenderSfSymbols, stampSfSymbolCodepoints, syncAppleFonts, syncSfSymbols } from '../../resources/apple-assets.js'

/**
 * Body-index phase. Incremental by default; `--full` triggers a clean
 * rebuild. Returns `{ indexed }` so the outer sync() can surface it.
 */
export async function runBodyIndex({ db, dataDir, logger, fullRebuild }) {
  logger.info(fullRebuild ? 'Rebuilding body index...' : 'Indexing body content...')
  const idxResult = fullRebuild ? await indexBodyFull(db, dataDir, logger) : await indexBodyIncremental(db, dataDir, logger)
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
export async function runResourcesPhase({ ctx, logger, scope }) {
  const failedSources = []
  let fontsResult = null
  let symbolsResult = null
  let symbolsRenderResult = null

  if (process.env.APPLE_DOCS_SKIP_RESOURCES === '1') {
    logger.info('APPLE_DOCS_SKIP_RESOURCES=1 — skipping fonts + SF Symbols sync')
    return { failedSources, fontsResult, symbolsResult, symbolsRenderResult }
  }

  // Corpus scope (scope.json) can drop the fonts/symbols resources
  // entirely; `scope` here is the corpus scope — unrelated to the
  // public/private VISIBILITY scope syncSfSymbols takes.
  const keepFonts = scope?.keepFonts !== false
  const keepSymbols = scope?.keepSymbols !== false
  const skippedOutcome = (label) => ({ ok: true, label, result: null, ms: 0 })

  const downloadFonts = process.env.APPLE_DOCS_DOWNLOAD_FONTS === '1'
  if (keepFonts) logger.info(`Syncing Apple typography${downloadFonts ? ' (downloading DMGs)' : ''}...`)
  else logger.info('Scope: keepFonts=false — skipping Apple fonts sync')

  const fontsTask = keepFonts
    ? runStep('sync.apple-fonts', () => syncAppleFonts({ downloadFonts }, ctx), { logger })
    : Promise.resolve(skippedOutcome('sync.apple-fonts'))

  if (!keepSymbols) logger.info('Scope: keepSymbols=false — skipping SF Symbols sync')
  const symbolsTask = keepSymbols
    ? runStep(
        'sync.sf-symbols-catalog',
        async () => {
          logger.info('Syncing SF Symbols catalog (public + private)...')
          const [publicCount, privateCount] = await Promise.all([syncSfSymbols({ scope: 'public' }, ctx), syncSfSymbols({ scope: 'private' }, ctx)])
          logger.info(`Synced ${publicCount} public + ${privateCount} private SF Symbols`)
          return { public: publicCount, private: privateCount }
        },
        { logger },
      )
    : Promise.resolve(skippedOutcome('sync.sf-symbols-catalog'))

  // Prerender only depends on the symbol catalog. Start it as soon as
  // symbols completes — does not wait for fonts.
  const prerenderTask = symbolsTask.then(async (outcome) => {
    if (!outcome.ok || !keepSymbols) return { ok: true, label: 'sync.sf-symbols-prerender', result: null, ms: 0 }
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
  const stampTask = Promise.all([fontsTask, symbolsTask]).then(async ([_fOutcome, sOutcome]) => {
    if (!sOutcome.ok || !keepSymbols || !keepFonts) return { ok: true, label: 'sync.sf-symbols-stamp', result: null, ms: 0 }
    return runStep('sync.sf-symbols-stamp', async () => stampSfSymbolCodepoints({}, ctx), { logger })
  })

  const [fontsOutcome, symbolsOutcome, prerenderOutcome, stampOutcome] = await Promise.all([fontsTask, symbolsTask, prerenderTask, stampTask])

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
