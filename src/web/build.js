import { join, dirname } from 'node:path'
import { rename, rm, appendFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage, renderFontsPage, renderSymbolsPage, renderNotFoundPage, buildFrameworkTreeData } from './templates.js'
import { buildHomepageProps } from './view-models/homepage.viewmodel.js'
import { buildFontsPageProps } from './view-models/fonts-page.viewmodel.js'
import { buildSymbolsPageProps } from './view-models/symbols-page.viewmodel.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { generateSitemaps } from './sitemap.js'
import { createWebRenderCache } from './render-cache.js'
import { ensureDir } from '../storage/files.js'
import { pool } from '../lib/pool.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'
import { linksAudit } from '../commands/links.js'
import { ENTRY_BUNDLES, STANDALONE_ASSETS, WORKER_ASSETS } from './assets-manifest.js'
import { minifyJs } from './asset-bundler.js'
import {
  batchFetchSections,
  computeSectionsDigest,
  computeTemplateVersion,
} from './build/checkpoint.js'
import { renderSkiplistPlaceholder, renderWithTimeout } from './build/render-helpers.js'
import { copyDirRecursive, maybePrecompress, PRECOMPRESS_THRESHOLD } from './build/io.js'
import { runWorkerBuilds } from './build/worker-fanout.js'

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
 *
 * The original entry (swift-evolution/0253-callable) was traced to an
 * infinite loop in markdownToHtml on lines like `### ` (empty heading)
 * and fixed in src/content/render-html.js; the skiplist is empty again.
 *
 * For each entry we emit a placeholder page (title + abstract + alternate
 * link to the upstream Apple URL) instead of rendering. The page is still
 * indexed, still cacheable, and still in the sitemap; only the body
 * content is missing.
 */
const RENDER_SKIPLIST = new Set()

/**
 * How often to flush the build checkpoint to the DB. Each flush is one tiny
 * UPDATE; the cost is negligible but the write still hits the WAL, so we
 * avoid doing it per-document.
 */
const CHECKPOINT_EVERY = 1_000

/**
 * Build a complete static documentation site from the corpus.
 *
 * Two modes are supported:
 *
 * - **Full build (default)**: writes into a sibling staging directory, then
 *   atomically renames it over the live `out` directory. Backwards compatible
 *   with the original behavior; preserves the previous output if the build
 *   fails. Clears the per-document render index at the start so every page is
 *   re-rendered from scratch.
 *
 * - **Incremental build (`--incremental`)**: writes in place into `out`,
 *   skipping documents whose `(sections_digest, template_version)` matches the
 *   last successful render recorded in `document_render_index`. Resumable: a
 *   killed run leaves the on-disk tree consistent with the checkpoint, and
 *   re-running picks up where it left off.
 *
 * @param {object} opts
 * @param {string} [opts.out='dist/web']      Output directory for the static site.
 * @param {string} [opts.baseUrl='']          Public base URL (used in templates).
 * @param {string} [opts.siteName]            Site name for templates.
 * @param {boolean} [opts.incremental=false]  Skip unchanged docs; write in place.
 * @param {boolean} [opts.full=false]         Force a full rebuild (clears render index).
 * @param {string[]} [opts.frameworks]        Restrict the build to these framework slugs (escape hatch for memory pressure on giant frameworks).
 * @param {number} [opts.concurrency]         Per-process render concurrency (default: ncpu, min 2). Sync-CPU rendering doesn't benefit much above 2–4 — for real parallelism use --workers.
 * @param {number} [opts.workers]             Number of subprocesses to fan out across (default: 1 = inline). Each subprocess opens its own SQLite handle, runs initHighlighter once, and renders a partition of the framework list. With WAL mode, multiple writers serialise on render-index upserts but throughput still scales near-linearly with cores up to `ncpu`.
 * @param {boolean} [opts.skipDocs=false]     Build only the site essentials (homepage, search page, public/ static files, sitemap-index, search artifacts, manifest, framework metadata) and skip every per-document and per-framework HTML page. Caddy's `try_files {path} {path}/index.html` falls through to Bun for `/docs/*`, where the existing on-demand renderer + the new `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` header makes Cloudflare cache each doc after first visit. Compromise mode for getting the deploy live without first burning hours on a full corpus build.
 * @param {{ rename: typeof rename, rm: typeof rm }} [opts.fsOps]  Test-only override for atomic-swap.
 * @param {(progress: { built: number, skipped: number, failed: number, total: number, framework: string|null, rss: number }) => void} [opts.onProgress]  Progress callback (fires per page).
 * @param {object} ctx
 * @param {import('../storage/database.js').DocsDatabase} ctx.db
 * @param {string} ctx.dataDir
 * @param {object} [ctx.logger]
 * @returns {Promise<{ pagesBuilt: number, pagesSkipped: number, pagesFailed: number, frameworksBuilt: number, durationMs: number, outputDir: string, searchArtifacts: object }>}
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

  // Staging directory is only used for full builds (preserves "no partial
  // output is ever served" guarantee). Incremental writes in place because
  // the whole point is to leave existing files alone.
  const buildDir = incremental
    ? outDir
    : `${outDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const previousDir = `${outDir}.prev-${Date.now()}-${Math.random().toString(16).slice(2)}`

  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
    bundled: true,
  }
  const { db, logger } = ctx
  const fsOps = opts.fsOps ?? { rename, rm }

  await initHighlighter()

  let pagesBuilt = 0
  let pagesSkipped = 0
  let pagesFailed = 0
  let frameworksBuilt = 0
  let searchArtifacts = null
  let lastCheckpointAt = 0

  // template_version captures the surface area that, if changed, invalidates
  // every cached render. Includes the templates themselves and the stylesheet
  // (since CSS rule names are referenced from `renderHtml`).
  const templateVersion = computeTemplateVersion()

  const runStartedAt = Math.floor(Date.now() / 1000)
  let renderIndexInitialized = false

  try {
    // Manage the render-index lifecycle. We do this inside the try block (and
    // *after* the first DB call below) so that contexts which can't even
    // reach the corpus — see the failingCtx test — surface the underlying
    // error, rather than the missing helpers on a stub `db`.
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

    // 1. Create directory structure (always — incremental builds may target a
    // partially populated dir, but the subdirs must exist either way).
    for (const sub of ['assets', 'docs', 'data/search', 'data/frameworks', 'worker', 'search', 'fonts', 'symbols']) {
      ensureDir(join(buildDir, sub))
    }

    // 2. Copy, minify, and bundle static assets. These are tiny and rebuild
    // each time; cheap relative to the doc render loop.
    const srcWebDir = dirname(new URL(import.meta.url).pathname)

    // 2a. Minify CSS — strip comments, collapse whitespace
    const rawCSS = readFileSync(join(srcWebDir, 'assets', 'style.css'), 'utf8')
    await Bun.write(join(buildDir, 'assets', 'style.css'), minifyCSS(rawCSS))

    // 2b. Bundle JS into logical groups to reduce HTTP requests. Each
    // entry in ENTRY_BUNDLES points at a `src/web/assets/entries/*.entry.js`
    // file that imports the bundle members in the right side-effect order.
    // Bun.build resolves the entry, inlines the members (each a top-level
    // IIFE), and emits one minified IIFE-wrapped output. format='iife' is
    // set inside asset-bundler.js so the result runs from a regular
    // <script src=...> tag (not a module script).
    for (const [bundleName, entryRel] of Object.entries(ENTRY_BUNDLES)) {
      const entryPath = join(srcWebDir, 'assets', entryRel)
      await Bun.write(join(buildDir, 'assets', bundleName), await minifyJs(entryPath))
    }
    for (const file of STANDALONE_ASSETS) {
      const src = join(srcWebDir, 'assets', file)
      if (existsSync(src)) {
        await Bun.write(join(buildDir, 'assets', file), await minifyJs(src))
      }
    }
    for (const file of WORKER_ASSETS) {
      const src = join(srcWebDir, 'worker', file)
      if (existsSync(src)) {
        await Bun.write(join(buildDir, 'worker', file), readFileSync(src, 'utf8'))
      }
    }

    // 2c. Copy the static public/ tree (robots.txt, llms.txt, security.txt,
    // and any other site-wide text files). Only the orchestrator writes
    // these — workers running with `--frameworks <chunk>` would re-do the
    // copy needlessly, and the bigger problem is that `index.html` and the
    // search page below are *partition-specific* when frameworkFilter is set.
    // Letting six workers race to overwrite them ends with the last-finished
    // worker's partition replacing the full corpus index (the bug that
    // shipped a 59-framework homepage on 2026-05-06).
    const isOrchestratorRun = !frameworkFilter
    const publicSrc = join(srcWebDir, 'public')
    if (isOrchestratorRun && existsSync(publicSrc)) {
      await copyDirRecursive(publicSrc, buildDir)
    }

    // 3. Pull frameworks. Filter must happen even if the call throws — we
    // want the failingCtx test in the suite to surface the underlying error.
    const allRoots = db.getRoots()
    const roots = frameworkFilter
      ? allRoots.filter(r => frameworkFilter.has(r.slug))
      : allRoots

    // Now that we know we can reach the corpus, initialise the render-index
    // lifecycle (clear-on-full, persist initial checkpoint).
    initRenderIndexIfNeeded()

    // 4. Landing page + search page. Same orchestrator-only guard as the
    // public/ copy: `roots` reflects the filtered partition inside a
    // worker, and the homepage iterates `roots` to enumerate every kind →
    // letting workers write here would publish a partition-only homepage.
    if (isOrchestratorRun) {
      // Same view-models the dev server's page routes use, so a static
      // build and a live render of `/`, `/fonts`, `/symbols` cannot drift
      // on filtering or DB query shape. The homepage's `roots` argument
      // inside this branch still uses the orchestrator's full root set —
      // the view-model props re-derive it from the DB to keep the contract
      // closed; iterators below this block continue to use `roots`.
      const homepageProps = buildHomepageProps({ db, siteConfig })
      const indexHtml = renderIndexPage(homepageProps.roots, siteConfig, { extras: homepageProps.extras })
      await Bun.write(join(buildDir, 'index.html'), indexHtml)
      const searchHtml = renderSearchPage(siteConfig)
      await Bun.write(join(buildDir, 'search', 'index.html'), searchHtml)
      const fontsHtml = renderFontsPage(siteConfig, buildFontsPageProps({ db }))
      await Bun.write(join(buildDir, 'fonts', 'index.html'), fontsHtml)
      const symbolsHtml = renderSymbolsPage(siteConfig, buildSymbolsPageProps({ db }))
      await Bun.write(join(buildDir, 'symbols', 'index.html'), symbolsHtml)

      // 404 fallback. Caddy `handle_errors` and Bun web/serve.js both
      // route /docs/* misses here; the inline JS pre-fills the search
      // box with the inferred page title so the user lands somewhere
      // useful instead of a dead end.
      const notFoundHtml = renderNotFoundPage(siteConfig)
      await Bun.write(join(buildDir, '404.html'), notFoundHtml)
    }

    // 5. Build document pages.
    //
    // Two execution modes:
    //
    //   - workers > 1: this process is an orchestrator. Partition the
    //     framework list across N child Bun subprocesses, each of which
    //     re-enters buildStaticSite with `--workers 1 --frameworks <slugs>
    //     --incremental`. Each subprocess opens its own SQLite handle (WAL
    //     allows concurrent readers + serialised writers; render-index
    //     upserts contend briefly but the cost is negligible vs. the
    //     synchronous shiki-bound render itself).
    //
    //   - workers == 1: render the per-framework loop in-process with the
    //     async pool. Sync-CPU work means raising `concurrency` past ~2-4
    //     gives diminishing returns inside one process — that's why
    //     `--workers` exists.
    //
    // Worker children carry `--frameworks <chunk>` so they skip the global
    // steps (sitemap, search artifacts, manifest) — those run in the
    // orchestrator after every child exits cleanly.
    const renderCache = createWebRenderCache(db)
    const knownKeys = renderCache.getKnownKeys()

    const failuresPath = join(buildDir, 'build-failures.jsonl')

    // Worker fan-out kicks in for any multi-framework run, including
    // explicit `--frameworks a,b,c` subsets — useful for sizing tests.
    if (skipDocs) {
      logger?.info?.('--skip-docs: per-document HTML render skipped; Caddy will fall through to Bun for /docs/*')
    } else if (workers > 1 && roots.length > 1) {
      // Workers must write into the orchestrator's `buildDir`, NOT `outDir`,
      // otherwise the orchestrator's atomic swap of buildDir over outDir at
      // step 10 clobbers everything the workers wrote. (And under `--full`,
      // each worker also tries to atomic-swap its own staging dir over
      // outDir, which racily replaces the previous worker's output.)
      const stats = await runWorkerBuilds({
        roots,
        opts,
        siteConfig,
        workers,
        concurrency,
        outDir: buildDir,
        db,
        logger,
      })
      pagesBuilt += stats.pagesBuilt
      pagesSkipped += stats.pagesSkipped
      pagesFailed += stats.pagesFailed
    } else for (const root of roots) {
      const docs = db.db.query(
        `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework,
                d.abstract_text, d.source_type, d.language, d.url,
                d.platforms_json, d.is_deprecated, d.is_beta,
                COALESCE(r.display_name, d.framework) as framework_display
         FROM documents d LEFT JOIN roots r ON r.slug = d.framework
         WHERE d.framework = ?
         ORDER BY d.id`
      ).all(root.slug)

      if (docs.length === 0) continue

      // Batched sections fetch: one query per chunk of doc IDs (mirrors the
      // index-body pipeline at src/pipeline/index-body.js:44). Drops
      // 346 K queries to ~700 in the production corpus.
      const sectionsByDoc = db.hasTable('document_sections')
        ? batchFetchSections(db, docs.map(d => d.id), 500)
        : new Map()

      await pool(docs, concurrency, async (doc) => {
        const sections = sectionsByDoc.get(doc.id) ?? []
        const sectionsDigest = computeSectionsDigest(sections)
        const filePath = join(buildDir, 'docs', doc.key, 'index.html')

        // Incremental skip. Two-tier:
        //   1. The render-index says nothing changed since the last
        //      successful render *and* the on-disk file is there → skip.
        //   2. The render-index is stale or missing but the on-disk file is
        //      still there and the sections haven't changed → also skip.
        //      Template-version churn alone (e.g. tweaking a copy line in
        //      templates.js between deploys) doesn't justify re-rendering
        //      346 K pages each time. `--full` is the explicit lever for
        //      that case.
        //
        // Either path persists the matching render-index entry under the
        // current template version so subsequent incremental runs hit the
        // fast path 1.
        if (incremental && existsSync(filePath)) {
          const cached = db.getRenderIndexEntry(doc.id)
          if (cached?.sections_digest === sectionsDigest) {
            if (cached.template_version !== templateVersion) {
              db.upsertRenderIndexEntry({
                docId: doc.id,
                sectionsDigest,
                templateVersion,
                htmlHash: cached.html_hash,
              })
            }
            pagesSkipped++
            tickProgress()
            return
          }
        }

        try {
          // Skiplist entries get a tombstone page so the rest of the build
          // can proceed without wedging on a single bad input. See the
          // RENDER_SKIPLIST comment for the bisect that produced the list.
          const html = RENDER_SKIPLIST.has(doc.key)
            ? renderSkiplistPlaceholder(doc, siteConfig)
            : await renderWithTimeout(() => renderDocumentPage(doc, sections, siteConfig, {
                knownKeys,
                ancestorTitles: renderCache.getAncestorTitles(doc.key),
                resolveRoleHeadings: (keys) => renderCache.getRoleHeadings(keys),
              }), RENDER_TIMEOUT_MS)

          ensureDir(dirname(filePath))
          await Bun.write(filePath, html)
          await maybePrecompress(filePath, html)

          db.upsertRenderIndexEntry({
            docId: doc.id,
            sectionsDigest,
            templateVersion,
            htmlHash: sha256(html).slice(0, 16),
          })
          pagesBuilt++
        } catch (err) {
          pagesFailed++
          logger?.warn?.(`Failed to build page ${doc.key}: ${err.message}`)
          // Persist failures to a sidecar log; the build run should not abort
          // because of a single bad doc.
          try {
            await appendFile(failuresPath, `${JSON.stringify({
              t: new Date().toISOString(),
              doc_id: doc.id,
              key: doc.key,
              error: err.message,
            })}\n`)
          } catch {
            // best-effort; never let logging fail a build
          }
        } finally {
          tickProgress()
        }
      })
    }

    // 6. Framework listing pages. The tree-view JSON used to be inlined into
    // every framework page (~800 KB on Swift stdlib, ~500 KB on UIKit), which
    // dominated the HTML payload and prevented edge caching. Now we write it
    // to a content-hashed sibling file under /data/frameworks/<slug>/, which
    // CF caches indefinitely (`?v=…` is the hash itself), and the framework
    // HTML carries only a `data-tree-src` reference.
    if (!skipDocs) for (const root of roots) {
      const docs = db.db.query(
        'SELECT key, title, kind, role, role_heading, abstract_text FROM documents WHERE framework = ? ORDER BY title'
      ).all(root.slug)
      if (docs.length === 0) continue

      const treeEdges = db.getFrameworkTree(root.slug)
      let treeDataUrl = null
      const tree = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
      if (tree.hasTree) {
        const hash = sha256(tree.json).slice(0, 10)
        const treeRel = `data/frameworks/${root.slug}/tree.${hash}.json`
        const treeAbs = join(buildDir, treeRel)
        ensureDir(dirname(treeAbs))
        await Bun.write(treeAbs, tree.json)
        treeDataUrl = `${siteConfig.baseUrl || ''}/${treeRel}`
      }

      const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges, treeDataUrl })
      const fwFilePath = join(buildDir, 'docs', root.slug, 'index.html')
      ensureDir(dirname(fwFilePath))
      await Bun.write(fwFilePath, html)
      await maybePrecompress(fwFilePath, html)
      // The tree-data JSON is also a big static file — precompress if it
      // beats the threshold so Caddy can serve `.br` directly.
      if (treeDataUrl && tree.json.length >= PRECOMPRESS_THRESHOLD) {
        const treeRel = treeDataUrl.replace(`${siteConfig.baseUrl || ''}/`, '')
        await maybePrecompress(join(buildDir, treeRel), tree.json)
      }
      frameworksBuilt++
    }

    // 7. Search artifacts + sitemaps (only on a full or unfiltered build —
    // partial framework builds intentionally don't touch the global index or
    // the sitemap-index, since both reference every framework).
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

    // 8. Per-framework metadata (cheap; refresh every run for the frameworks
    // we touched this run).
    for (const root of roots) {
      const count = db.db.query('SELECT COUNT(*) as count FROM documents WHERE framework = ?').get(root.slug).count
      await Bun.write(
        join(buildDir, 'data', 'frameworks', `${root.slug}.json`),
        JSON.stringify({ slug: root.slug, displayName: root.display_name, kind: root.kind, documentCount: count })
      )
    }

    // 9. Manifest — only refresh on a full/unfiltered build so partial runs
    // don't claim totals they didn't compute.
    if (buildingAll) {
      const manifest = {
        version: 1,
        siteName: siteConfig.siteName,
        buildDate: siteConfig.buildDate,
        baseUrl: siteConfig.baseUrl,
        totalDocuments: pagesBuilt + pagesSkipped,
        totalFrameworks: frameworksBuilt,
        searchArtifacts,
      }
      await Bun.write(join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    }

    // 10. Atomic swap (full builds only). For incremental we already wrote
    // into outDir, nothing to do.
    if (!incremental) {
      let hadPreviousOutput = false
      if (existsSync(outDir)) {
        await fsOps.rename(outDir, previousDir)
        hadPreviousOutput = true
      }
      try {
        await fsOps.rename(buildDir, outDir)
      } catch (error) {
        if (hadPreviousOutput && existsSync(previousDir) && !existsSync(outDir)) {
          await fsOps.rename(previousDir, outDir)
        }
        logger?.error?.(`Static site publish failed: ${error.message}`)
        throw error
      }
      if (hadPreviousOutput) {
        await fsOps.rm(previousDir, { recursive: true, force: true })
      }
    }

    // Finalize checkpoint
    if (renderIndexInitialized) {
      db.setWebBuildCheckpoint({
        run_id: db.getWebBuildCheckpoint()?.run_id,
        template_version: templateVersion,
        started_at: runStartedAt,
        updated_at: Math.floor(Date.now() / 1000),
        pages_built: pagesBuilt,
        pages_skipped: pagesSkipped,
        pages_failed: pagesFailed,
        build_dir: outDir,
        base_url: siteConfig.baseUrl,
        incremental,
        status: 'completed',
      })
    }

    // 11. Walk the rendered HTML and classify every link. Cheap relative to
    // the build itself, surfaces internal_broken / external_resolvable /
    // relative_broken hot spots so they show up in the build summary.
    // Skipped on partial builds (--frameworks subset / --skip-docs) since
    // the audit needs the full /docs tree to be meaningful.
    let linksAuditResult = null
    if (buildingAll && !skipDocs) {
      try {
        linksAuditResult = await linksAudit({ outDir }, { db, logger })
      } catch (err) {
        logger?.warn?.(`Links audit skipped: ${err.message}`)
      }
    }

    const durationMs = Math.round(performance.now() - start)
    logger?.info?.(
      `Static site built: ${outDir} ` +
      `(${pagesBuilt} built, ${pagesSkipped} skipped, ${pagesFailed} failed, ` +
      `${frameworksBuilt} frameworks in ${durationMs}ms)`
    )

    return { pagesBuilt, pagesSkipped, pagesFailed, frameworksBuilt, durationMs, outputDir: outDir, searchArtifacts, linksAudit: linksAuditResult }
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
          pages_built: pagesBuilt,
          pages_skipped: pagesSkipped,
          pages_failed: pagesFailed,
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

  function tickProgress() {
    const total = pagesBuilt + pagesSkipped + pagesFailed
    if (total - lastCheckpointAt >= CHECKPOINT_EVERY) {
      lastCheckpointAt = total
      const cp = db.getWebBuildCheckpoint() ?? {}
      db.setWebBuildCheckpoint({
        ...cp,
        updated_at: Math.floor(Date.now() / 1000),
        pages_built: pagesBuilt,
        pages_skipped: pagesSkipped,
        pages_failed: pagesFailed,
      })
    }
    if (onProgress) {
      onProgress({
        built: pagesBuilt,
        skipped: pagesSkipped,
        failed: pagesFailed,
        total,
        framework: null,
        rss: typeof process !== 'undefined' ? process.memoryUsage().rss : 0,
      })
    }
  }
}

/**
 * Batched sections fetch: returns a `Map<docId, sections[]>`.
 * Chunks doc-id IN-lists at `chunkSize` to keep individual queries small.
 */
export function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')     // strip block comments
    .replace(/\s*([{}:;,>~+])\s*/g, '$1') // collapse whitespace around syntax chars
    .replace(/;\}/g, '}')                  // remove trailing semicolons before }
    .replace(/\n+/g, '')                   // remove newlines
    .replace(/\s{2,}/g, ' ')              // collapse remaining whitespace
    .trim()
}
