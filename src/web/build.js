import { join, dirname } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { renderIndexPage, renderSearchPage, renderFontsPage, renderSymbolsPage, renderNotFoundPage } from './templates.js'
import { buildHomepageProps } from './view-models/homepage.viewmodel.js'
import { buildFontsPageProps } from './view-models/fonts-page.viewmodel.js'
import { buildSymbolsPageProps } from './view-models/symbols-page.viewmodel.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { generateSitemaps } from './sitemap.js'
import { createWebRenderCache } from './render-cache.js'
import { ensureDir } from '../storage/files.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'
import { linksAudit } from '../commands/links.js'
import { computeTemplateVersion } from './build/checkpoint.js'
import { runWorkerBuilds } from './build/worker-fanout.js'
import { runStep } from '../lib/run-step.js'
import { runAssetPipeline } from './build/assets-pipeline.js'
import { buildDocumentPages } from './build/document-pages.js'
import { buildFrameworkPages } from './build/framework-pages.js'
import { atomicPublish } from './build/atomic-swap.js'
import { minifyCSS } from './build/minify-css.js'

export { minifyCSS }

/**
 * Default per-page render timeout. The Swift stdlib + a few other "kitchen
 * sink" frameworks can blow this if the inline tree-data ever returns; 30 s
 * is far above the typical 10–200 ms but well below "we're stuck forever".
 *
 * NOTE: this timeout cannot fire if the render itself blocks the JS thread
 * (sync template / regex work) — `setTimeout` schedules a callback for the
 * event loop, which never gets a turn. The skiplist below is the
 * pragmatic guardrail until we move heavy renders onto Bun.Worker threads.
 */
const RENDER_TIMEOUT_MS = 30_000

/**
 * Documents that wedge the synchronous render path. Kept as an explicit
 * escape hatch — populate when bisect lands on a doc whose render pins the
 * JS thread, defeating the per-page Promise-race timeout (which can't fire
 * while the thread has no event-loop turn).
 */
const RENDER_SKIPLIST = new Set()

/** How often to flush the build checkpoint to the DB. */
const CHECKPOINT_EVERY = 1_000

/**
 * Build a complete static documentation site from the corpus.
 *
 * This is the orchestrator: it threads checkpoint / progress / counter
 * state through the per-step modules under ./build/.
 *
 * @param {object} opts
 * @param {string} [opts.out='dist/web']      Output directory for the static site.
 * @param {string} [opts.baseUrl='']          Public base URL (used in templates).
 * @param {string} [opts.siteName]            Site name for templates.
 * @param {boolean} [opts.incremental=false]  Skip unchanged docs; write in place.
 * @param {boolean} [opts.full=false]         Force a full rebuild (clears render index).
 * @param {string[]} [opts.frameworks]        Restrict the build to these framework slugs.
 * @param {number} [opts.concurrency]         Per-process render concurrency.
 * @param {number} [opts.workers]             Number of subprocesses to fan out across.
 * @param {boolean} [opts.skipDocs=false]     Build only site essentials; skip per-doc HTML.
 * @param {{ rename: typeof rename, rm: typeof rm }} [opts.fsOps]  Test-only override for atomic-swap.
 * @param {(progress: object) => void} [opts.onProgress]  Progress callback.
 * @param {object} ctx
 * @param {import('../storage/database.js').DocsDatabase} ctx.db
 * @param {string} ctx.dataDir
 * @param {object} [ctx.logger]
 */
export async function buildStaticSite(opts, ctx) {
  const start = performance.now()
  const outDir = opts.out || 'dist/web'
  const incremental = opts.incremental === true && opts.full !== true
  const fullRebuild = opts.full === true || !incremental
  const frameworkFilter = Array.isArray(opts.frameworks) && opts.frameworks.length > 0
    ? new Set(opts.frameworks)
    : null
  const ncpu = availableParallelism?.() ?? 4
  const concurrency = Math.max(1, opts.concurrency ?? Math.max(2, ncpu - 2))
  const workers = Math.max(1, opts.workers ?? 1)
  const skipDocs = opts.skipDocs === true
  const onProgress = opts.onProgress ?? null

  const buildDir = incremental
    ? outDir
    : `${outDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const previousDir = `${outDir}.prev-${Date.now()}-${Math.random().toString(16).slice(2)}`

  const { db, logger } = ctx
  // `snapshot_tag` is the install-time stamp (set in src/commands/setup.js);
  // `snapshot_version` is the build-time stamp (set in src/commands/snapshot.js).
  // Either is valid as the "what corpus am I rendering" label.
  const snapshotTag = db.getSnapshotMeta?.('snapshot_tag')
    ?? db.getSnapshotMeta?.('snapshot_version')
    ?? null
  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
    snapshotTag,
    bundled: true,
  }
  const fsOps = opts.fsOps ?? { rename, rm }

  await initHighlighter()

  const counters = { pagesBuilt: 0, pagesSkipped: 0, pagesFailed: 0 }
  let frameworksBuilt = 0
  let searchArtifacts = null
  let lastCheckpointAt = 0

  // template_version captures the surface area that, if changed, invalidates
  // every cached render.
  const templateVersion = computeTemplateVersion()

  const runStartedAt = Math.floor(Date.now() / 1000)
  let renderIndexInitialized = false

  function initRenderIndexIfNeeded() {
    if (renderIndexInitialized) return
    if (fullRebuild) {
      db.clearRenderIndex()
    } else {
      const cp = db.getWebBuildCheckpoint()
      if (cp?.template_version && cp.template_version !== templateVersion) {
        logger?.info?.('Template surface changed since last build — clearing render index')
        db.clearRenderIndex()
      }
    }
    db.setWebBuildCheckpoint({
      run_id: `${runStartedAt}-${Math.random().toString(16).slice(2, 8)}`,
      template_version: templateVersion,
      started_at: runStartedAt,
      updated_at: runStartedAt,
      pages_built: 0,
      pages_skipped: 0,
      pages_failed: 0,
      build_dir: buildDir,
      base_url: siteConfig.baseUrl,
      incremental,
      status: 'in_progress',
    })
    renderIndexInitialized = true
  }

  function tickProgress() {
    const total = counters.pagesBuilt + counters.pagesSkipped + counters.pagesFailed
    if (total - lastCheckpointAt >= CHECKPOINT_EVERY) {
      lastCheckpointAt = total
      const cp = db.getWebBuildCheckpoint() ?? {}
      db.setWebBuildCheckpoint({
        ...cp,
        updated_at: Math.floor(Date.now() / 1000),
        pages_built: counters.pagesBuilt,
        pages_skipped: counters.pagesSkipped,
        pages_failed: counters.pagesFailed,
      })
    }
    if (onProgress) {
      onProgress({
        built: counters.pagesBuilt,
        skipped: counters.pagesSkipped,
        failed: counters.pagesFailed,
        total,
        framework: null,
        rss: typeof process !== 'undefined' ? process.memoryUsage().rss : 0,
      })
    }
  }

  try {
    // 1. Create directory structure (always — incremental builds may target a
    // partially populated dir, but the subdirs must exist either way).
    for (const sub of ['assets', 'docs', 'data/search', 'data/frameworks', 'worker', 'search', 'fonts', 'symbols']) {
      ensureDir(join(buildDir, sub))
    }

    // 2. Asset pipeline: minify CSS, bundle JS, copy public/.
    const srcWebDir = dirname(new URL(import.meta.url).pathname)
    const isOrchestratorRun = !frameworkFilter
    await runAssetPipeline({ srcWebDir, buildDir, isOrchestratorRun })

    // 3. Pull frameworks. Filter must happen even if the call throws — we
    // want the failingCtx test in the suite to surface the underlying error.
    const allRoots = db.getRoots()
    const roots = frameworkFilter
      ? allRoots.filter(r => frameworkFilter.has(r.slug))
      : allRoots

    initRenderIndexIfNeeded()

    // 4. Landing pages. Same orchestrator-only guard as the public/ copy:
    // letting workers write here would publish a partition-only homepage.
    if (isOrchestratorRun) {
      const homepageProps = buildHomepageProps({ db, siteConfig })
      await Bun.write(join(buildDir, 'index.html'),
        renderIndexPage(homepageProps.roots, siteConfig, { extras: homepageProps.extras }))
      await Bun.write(join(buildDir, 'search', 'index.html'), renderSearchPage(siteConfig))
      await Bun.write(join(buildDir, 'fonts', 'index.html'),
        renderFontsPage(siteConfig, buildFontsPageProps({ db })))
      await Bun.write(join(buildDir, 'symbols', 'index.html'),
        renderSymbolsPage(siteConfig, buildSymbolsPageProps({ db })))
      await Bun.write(join(buildDir, '404.html'), renderNotFoundPage(siteConfig))
    }

    // 5. Build document pages. Two execution modes:
    //   - workers > 1: orchestrator partitions framework list across N
    //     subprocesses; each opens its own SQLite handle.
    //   - workers == 1: render in-process with the async pool.
    const renderCache = createWebRenderCache(db)
    const knownKeys = renderCache.getKnownKeys()
    const failuresPath = join(buildDir, 'build-failures.jsonl')

    if (skipDocs) {
      logger?.info?.('--skip-docs: per-document HTML render skipped; Caddy will fall through to Bun for /docs/*')
    } else if (workers > 1 && roots.length > 1) {
      // Workers must write into the orchestrator's `buildDir`, NOT `outDir`,
      // otherwise the orchestrator's atomic swap clobbers everything.
      const stats = await runWorkerBuilds({
        roots, siteConfig, workers, concurrency, outDir: buildDir, db, logger,
      })
      counters.pagesBuilt += stats.pagesBuilt
      counters.pagesSkipped += stats.pagesSkipped
      counters.pagesFailed += stats.pagesFailed
    } else {
      await buildDocumentPages({
        roots, db, buildDir, siteConfig, renderCache, knownKeys,
        skipList: RENDER_SKIPLIST,
        renderTimeoutMs: RENDER_TIMEOUT_MS,
        concurrency, incremental, templateVersion,
        counters, tickProgress, logger, failuresPath,
      })
    }

    // 6. Framework listing pages.
    if (!skipDocs) {
      frameworksBuilt = await buildFrameworkPages({ roots, db, buildDir, siteConfig })
    }

    // 7. Search artifacts + sitemaps (only on a full or unfiltered build).
    const buildingAll = !frameworkFilter
    if (buildingAll) {
      searchArtifacts = await generateSearchArtifacts(db, join(buildDir, 'data', 'search'))
      await generateSitemaps({
        db,
        outputDir: buildDir,
        baseUrl: siteConfig.baseUrl || '',
        buildDate: siteConfig.buildDate,
      })
    }

    // 8. Per-framework metadata (cheap; refresh every run).
    for (const root of roots) {
      const count = db.db.query('SELECT COUNT(*) as count FROM documents WHERE framework = ?').get(root.slug).count
      await Bun.write(
        join(buildDir, 'data', 'frameworks', `${root.slug}.json`),
        JSON.stringify({ slug: root.slug, displayName: root.display_name, kind: root.kind, documentCount: count }),
      )
    }

    // 9. Manifest — only refresh on a full/unfiltered build.
    if (buildingAll) {
      await Bun.write(join(buildDir, 'manifest.json'), JSON.stringify({
        version: 1,
        siteName: siteConfig.siteName,
        buildDate: siteConfig.buildDate,
        baseUrl: siteConfig.baseUrl,
        totalDocuments: counters.pagesBuilt + counters.pagesSkipped,
        totalFrameworks: frameworksBuilt,
        searchArtifacts,
      }, null, 2))
    }

    // 10. Atomic swap (full builds only).
    if (!incremental) {
      await atomicPublish({ outDir, buildDir, previousDir, fsOps, logger })
    }

    // Finalize checkpoint
    if (renderIndexInitialized) {
      db.setWebBuildCheckpoint({
        run_id: db.getWebBuildCheckpoint()?.run_id,
        template_version: templateVersion,
        started_at: runStartedAt,
        updated_at: Math.floor(Date.now() / 1000),
        pages_built: counters.pagesBuilt,
        pages_skipped: counters.pagesSkipped,
        pages_failed: counters.pagesFailed,
        build_dir: outDir,
        base_url: siteConfig.baseUrl,
        incremental,
        status: 'completed',
      })
    }

    // 11. Walk the rendered HTML and classify every link. Skipped on partial
    // builds since the audit needs the full /docs tree to be meaningful.
    let linksAuditResult = null
    if (buildingAll && !skipDocs) {
      const auditStep = await runStep(
        'web-build.links-audit',
        () => linksAudit({ outDir }, { db, logger }),
        { logger },
      )
      if (auditStep.ok) linksAuditResult = auditStep.result
    }

    const durationMs = Math.round(performance.now() - start)
    logger?.info?.(
      `Static site built: ${outDir} ` +
      `(${counters.pagesBuilt} built, ${counters.pagesSkipped} skipped, ${counters.pagesFailed} failed, ` +
      `${frameworksBuilt} frameworks in ${durationMs}ms)`,
    )

    return {
      pagesBuilt: counters.pagesBuilt,
      pagesSkipped: counters.pagesSkipped,
      pagesFailed: counters.pagesFailed,
      frameworksBuilt,
      durationMs,
      outputDir: outDir,
      searchArtifacts,
      linksAudit: linksAuditResult,
    }
  } catch (error) {
    if (!incremental) {
      // Clean up the staging directory if a full build aborted before the swap.
      await fsOps.rm(buildDir, { recursive: true, force: true })
    }
    if (renderIndexInitialized) {
      try {
        db.setWebBuildCheckpoint({
          ...(db.getWebBuildCheckpoint() ?? {}),
          updated_at: Math.floor(Date.now() / 1000),
          pages_built: counters.pagesBuilt,
          pages_skipped: counters.pagesSkipped,
          pages_failed: counters.pagesFailed,
          status: 'failed',
          last_error: error.message,
        })
      } catch {
        // best-effort: never let checkpoint persistence mask the real error
      }
    }
    throw error
  } finally {
    disposeHighlighter()
  }
}
