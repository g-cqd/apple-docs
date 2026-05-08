import { join, dirname } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { appendFile } from 'node:fs/promises'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage, renderFontsPage, renderSymbolsPage, renderNotFoundPage, buildFrameworkTreeData } from './templates.js'
import { buildHomepageExtras } from './serve.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { generateSitemaps } from './sitemap.js'
import { createWebRenderCache } from './render-cache.js'
import { ensureDir } from '../storage/files.js'
import { pool } from '../lib/pool.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'
import { linksAudit } from '../commands/links.js'
import { ASSET_BUNDLES, STANDALONE_ASSETS, WORKER_ASSETS } from './assets-manifest.js'

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
 * Files smaller than this are NOT precompressed at build time — Caddy's
 * runtime `encode` directive compresses them quickly enough at request time
 * and the brotli-quality-11 cost would dominate the build. Picked to keep
 * the dist/ tree from doubling on the long tail of small symbol pages,
 * while still capturing every framework landing and tree-data JSON.
 */
const PRECOMPRESS_THRESHOLD = 16 * 1024

/**
 * How often to flush the build checkpoint to the DB. Each flush is one tiny
 * `UPDATE`; the cost is negligible but the write still hits the WAL, so we
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

    // 2b. Bundle JS into logical groups to reduce HTTP requests. Bundle
    // membership lives in src/web/assets-manifest.js so serve.js sees the
    // same definition for its on-the-fly /assets/<name> synthesis.
    const readAsset = (f) => {
      const p = join(srcWebDir, 'assets', f)
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    }
    for (const [bundleName, sources] of Object.entries(ASSET_BUNDLES)) {
      const concatenated = sources.map(readAsset).join('\n')
      await Bun.write(join(buildDir, 'assets', bundleName), concatenated)
    }
    for (const file of STANDALONE_ASSETS) {
      const src = join(srcWebDir, 'assets', file)
      if (existsSync(src)) {
        await Bun.write(join(buildDir, 'assets', file), readFileSync(src, 'utf8'))
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
      const indexHtml = renderIndexPage(roots, siteConfig, { extras: buildHomepageExtras(siteConfig) })
      await Bun.write(join(buildDir, 'index.html'), indexHtml)
      const searchHtml = renderSearchPage(siteConfig)
      await Bun.write(join(buildDir, 'search', 'index.html'), searchHtml)
      const families = db.listAppleFonts()
      const fontsHtml = renderFontsPage(siteConfig, { families })
      await Bun.write(join(buildDir, 'fonts', 'index.html'), fontsHtml)
      const symbolTotals = db.db.query(
        "SELECT scope, COUNT(*) as count FROM sf_symbols GROUP BY scope",
      ).all()
      const symbolsHtml = renderSymbolsPage(siteConfig, { totals: symbolTotals })
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
function batchFetchSections(db, docIds, chunkSize) {
  const result = new Map()
  for (let i = 0; i < docIds.length; i += chunkSize) {
    const chunk = docIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.db.query(
      `SELECT document_id, section_kind, heading, content_text, content_json, sort_order
       FROM document_sections
       WHERE document_id IN (${placeholders})
       ORDER BY document_id, sort_order, id`
    ).all(...chunk)
    for (const row of rows) {
      let arr = result.get(row.document_id)
      if (!arr) {
        arr = []
        result.set(row.document_id, arr)
      }
      arr.push(row)
    }
  }
  return result
}

/**
 * Cheap fingerprint of a doc's sections for the incremental skip path. We
 * deliberately don't hash the full content — only the shape (kinds + lengths)
 * — because the goal is "did this doc change since the render was cached?",
 * not "is the rendered HTML byte-identical?". A full content hash would more
 * than double the per-doc CPU cost during the digest phase, which is hot.
 */
function computeSectionsDigest(sections) {
  if (!sections || sections.length === 0) return 'empty'
  const parts = []
  for (const s of sections) {
    parts.push(s.section_kind)
    parts.push(String((s.content_text ?? '').length))
    const json = s.content_json
    parts.push(typeof json === 'string' ? String(json.length) : json ? '1' : '0')
    parts.push(String(s.sort_order ?? 0))
  }
  return sha256(parts.join('|')).slice(0, 16)
}

/**
 * Hash of the template surface — bumping any of these files invalidates the
 * render index. Keep the list tight: anything that contributes HTML output
 * during `renderDocumentPage` must be included.
 */
function computeTemplateVersion() {
  const here = dirname(new URL(import.meta.url).pathname)
  const files = [
    join(here, 'templates.js'),
    join(here, '..', 'content', 'render-html.js'),
    join(here, 'assets', 'style.css'),
  ]
  const hasher = new Bun.CryptoHasher('sha256')
  for (const f of files) {
    try {
      hasher.update(readFileSync(f))
    } catch {
      // file missing — fold its absence into the hash so a removed file still
      // rotates the version
      hasher.update(`missing:${f}`)
    }
  }
  return hasher.digest('hex').slice(0, 16)
}

/**
 * Run a synchronous render inside a `Promise.race` against a hard timeout.
 * The render is wrapped in `Promise.resolve().then(...)` so that if it throws
 * we get a rejected promise rather than an uncaught synchronous error. The
 * timer is cleared on either path to keep the event loop tidy.
 */
function renderWithTimeout(fn, ms) {
  let timer
  const renderPromise = Promise.resolve().then(fn)
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render timeout after ${ms}ms`)), ms)
  })
  return Promise.race([renderPromise, timeoutPromise]).finally(() => clearTimeout(timer))
}

/**
 * Minimal placeholder for skiplisted documents. Emits a valid HTML page
 * with the doc's title, abstract, and a link back to the upstream Apple
 * URL — enough for SEO + the sitemap, with a banner explaining that the
 * full body is unavailable.
 */
function renderSkiplistPlaceholder(doc, siteConfig) {
  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  const title = esc(doc.title ?? doc.key)
  const description = esc(doc.abstract_text ?? `${doc.title ?? doc.key} — Apple developer documentation`)
  const canonical = `${siteConfig.baseUrl || ''}/docs/${esc(doc.key)}/`
  const upstream = doc.url ? esc(doc.url) : null
  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${esc(siteConfig.siteName)}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${canonical}">
  ${upstream ? `<link rel="alternate" href="${upstream}">` : ''}
  <meta name="robots" content="index, follow">
</head>
<body>
<main class="main-content">
  <h1>${title}</h1>
  <p>${description}</p>
  <p><em>Body unavailable in this build — see the original on Apple's site${upstream ? `: <a href="${upstream}">${upstream}</a>` : ''}.</em></p>
</main>
</body>
</html>`
}

/**
 * Partition a framework list across N workers, balancing by document count
 * via greedy bin-packing (largest framework first into the smallest bin).
 * Apple's distribution is heavy-tailed (kernel = 39 K docs, swift-evolution
 * = 553), so a naive round-robin would leave one worker rendering swift +
 * uikit while five sit idle. This balances within ~5 % of optimal.
 */
function partitionFrameworksByDocCount(roots, db, n) {
  const counts = roots.map(root => ({
    root,
    count: db.db.query('SELECT COUNT(*) as c FROM documents WHERE framework = ?').get(root.slug).c,
  }))
  counts.sort((a, b) => b.count - a.count)
  const bins = Array.from({ length: n }, () => ({ slugs: [], total: 0 }))
  for (const { root, count } of counts) {
    if (count === 0) continue
    const smallest = bins.reduce((acc, b) => (b.total < acc.total ? b : acc), bins[0])
    smallest.slugs.push(root.slug)
    smallest.total += count
  }
  return bins.filter(b => b.slugs.length > 0)
}

/**
 * Spawn N child Bun processes, each running `apple-docs web build` on its
 * partition of the framework list. Returns aggregated counts after every
 * child exits.
 *
 * Children inherit stdio so progress / failure log lines surface
 * immediately. The orchestrator does NOT render anything itself in this
 * mode; framework-listing pages (step 6) and the global steps (search
 * artifacts, sitemap, manifest) still run in the orchestrator after the
 * children finish.
 *
 * @param {object} args
 * @param {Array}  args.roots          Filtered framework list to fan out across.
 * @param {object} args.opts           Original `buildStaticSite` opts (forwarded selectively).
 * @param {object} args.siteConfig
 * @param {number} args.workers        Number of subprocesses to spawn.
 * @param {number} args.concurrency    Per-process pool concurrency.
 * @param {string} args.outDir
 * @param {import('../storage/database.js').DocsDatabase} args.db  For doc-count partitioning.
 * @param {object} [args.logger]
 */
async function runWorkerBuilds({ roots, opts, siteConfig, workers, concurrency, outDir, db, logger }) {
  const bins = partitionFrameworksByDocCount(roots, db, workers)
  if (bins.length === 0) {
    return { pagesBuilt: 0, pagesSkipped: 0, pagesFailed: 0 }
  }
  const totalDocs = bins.reduce((s, b) => s + b.total, 0)
  logger?.info?.(
    `Fan-out: ${bins.length} workers × ${concurrency} concurrency · ${totalDocs.toLocaleString('en-US')} docs partitioned across ${bins.map(b => b.total.toLocaleString('en-US')).join(', ')}`
  )

  // Resolve the CLI entrypoint relative to this module so worker processes
  // run the same checkout (no PATH lookup, no system-wide CLI surprises).
  const here = dirname(new URL(import.meta.url).pathname)
  const cliJs = join(here, '..', '..', 'cli.js')
  const bunBin = process.execPath || Bun.argv?.[0] || 'bun'

  const procs = bins.map((bin, i) => {
    const args = [
      'run', cliJs, 'web', 'build',
      '--out', outDir,
      '--frameworks', bin.slugs.join(','),
      '--concurrency', String(concurrency),
      '--workers', '1',
      '--incremental',
    ]
    if (siteConfig.baseUrl) { args.push('--base-url', siteConfig.baseUrl) }
    if (siteConfig.siteName) { args.push('--site-name', siteConfig.siteName) }
    // Don't pass `--full` to workers. The orchestrator already cleared the
    // render index. Workers must run in incremental mode so they write
    // directly to the shared `outDir` (= the orchestrator's staging dir)
    // instead of each spinning up its own staging dir + atomic swap, which
    // would race-replace the orchestrator's output.
    logger?.info?.(`worker[${i + 1}/${bins.length}] starting (${bin.slugs.length} frameworks, ${bin.total.toLocaleString('en-US')} docs): ${bin.slugs.slice(0, 4).join(', ')}${bin.slugs.length > 4 ? '…' : ''}`)
    return Bun.spawn([bunBin, ...args], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, APPLE_DOCS_BUILD_WORKER: '1' },
    })
  })

  const exits = await Promise.all(procs.map(p => p.exited))
  const failedCount = exits.filter(c => c !== 0).length
  if (failedCount > 0) {
    throw new Error(`${failedCount}/${exits.length} build worker(s) exited non-zero`)
  }

  // Re-read counts from the render-index for an honest aggregate. We don't
  // attempt to recover a per-worker breakdown — the children already
  // streamed their summaries to stdout.
  const counts = db.db.query(
    `SELECT COUNT(*) AS built FROM document_render_index ri
     JOIN documents d ON d.id = ri.doc_id
     WHERE d.framework IN (${bins.flatMap(b => b.slugs).map(() => '?').join(',')})`
  ).get(...bins.flatMap(b => b.slugs))
  return {
    pagesBuilt: counts?.built ?? 0,
    pagesSkipped: 0,
    pagesFailed: 0,
  }
}

/**
 * Brotli-precompress an output file when it crosses the size threshold, so
 * Caddy's `precompressed br` mode can ship the sidecar directly without
 * repeating brotli at request time.
 *
 * Quality 11 is the maximum and gives 3–10 % smaller outputs than runtime
 * `encode` (which defaults to ~quality 4). The build cost is acceptable
 * because every page either misses the threshold (skipped) or is rendered
 * at most once per deploy thanks to the incremental render index.
 */
async function maybePrecompress(filePath, body) {
  const len = typeof body === 'string' ? Buffer.byteLength(body) : body.length
  if (len < PRECOMPRESS_THRESHOLD) return
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  const br = brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: len,
    },
  })
  await Bun.write(`${filePath}.br`, br)
}

/**
 * Recursively copy `src` into `dst`, overwriting existing files. Used to
 * stage the static `public/` tree (robots.txt, llms.txt, security.txt) into
 * the build output. Doesn't follow symlinks.
 */
async function copyDirRecursive(src, dst) {
  ensureDir(dst)
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to)
    } else if (entry.isFile()) {
      // Bun.write accepts a path source via Bun.file(...) and is faster than
      // readFileSync + writeFileSync because it streams; size check just so
      // we don't accidentally inflate the build with a stray multi-GB blob.
      const size = statSync(from).size
      if (size > 16 * 1024 * 1024) {
        throw new Error(`refusing to copy ${from} (${size} bytes) into static public dir`)
      }
      await Bun.write(to, Bun.file(from))
    }
  }
}

/** Minify CSS by stripping comments, collapsing whitespace, and removing unnecessary characters. */
export function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')     // strip block comments
    .replace(/\s*([{}:;,>~+])\s*/g, '$1') // collapse whitespace around syntax chars
    .replace(/;\}/g, '}')                  // remove trailing semicolons before }
    .replace(/\n+/g, '')                   // remove newlines
    .replace(/\s{2,}/g, ' ')              // collapse remaining whitespace
    .trim()
}
