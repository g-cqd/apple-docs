import { join, dirname } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { appendFile } from 'node:fs/promises'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage, buildFrameworkTreeData } from './templates.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { generateSitemaps } from './sitemap.js'
import { createWebRenderCache } from './render-cache.js'
import { ensureDir } from '../storage/files.js'
import { pool } from '../lib/pool.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'

/**
 * Default per-page render timeout. The Swift stdlib + a few other "kitchen
 * sink" frameworks can blow this if the inline tree-data ever returns; 30 s
 * is far above the typical 10–200 ms but well below "we're stuck forever".
 */
const RENDER_TIMEOUT_MS = 30_000

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
 * @param {number} [opts.concurrency]         Per-framework render concurrency (default: ncpu - 2, min 2).
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
  const concurrency = Math.max(2, opts.concurrency ?? Math.max(2, (availableParallelism?.() ?? 4) - 2))
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
    for (const sub of ['assets', 'docs', 'data/search', 'data/frameworks', 'worker', 'search']) {
      ensureDir(join(buildDir, sub))
    }

    // 2. Copy, minify, and bundle static assets. These are tiny and rebuild
    // each time; cheap relative to the doc render loop.
    const srcWebDir = dirname(new URL(import.meta.url).pathname)

    // 2a. Minify CSS — strip comments, collapse whitespace
    const rawCSS = readFileSync(join(srcWebDir, 'assets', 'style.css'), 'utf8')
    await Bun.write(join(buildDir, 'assets', 'style.css'), minifyCSS(rawCSS))

    // 2b. Bundle JS into logical groups to reduce HTTP requests
    const readAsset = (f) => {
      const p = join(srcWebDir, 'assets', f)
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    }
    const coreBundle = [readAsset('theme.js'), readAsset('search.js'), readAsset('page-toc.js')].join('\n')
    const listingBundle = [readAsset('collection-filters.js'), readAsset('tree-view.js')].join('\n')
    await Bun.write(join(buildDir, 'assets', 'core.js'), coreBundle)
    await Bun.write(join(buildDir, 'assets', 'listing.js'), listingBundle)
    for (const file of ['search-page.js', 'lang-toggle.js']) {
      const src = join(srcWebDir, 'assets', file)
      if (existsSync(src)) {
        await Bun.write(join(buildDir, 'assets', file), readFileSync(src, 'utf8'))
      }
    }
    const workerSrc = join(srcWebDir, 'worker', 'search-worker.js')
    if (existsSync(workerSrc)) {
      await Bun.write(join(buildDir, 'worker', 'search-worker.js'), readFileSync(workerSrc, 'utf8'))
    }

    // 2c. Copy the static public/ tree (robots.txt, llms.txt, security.txt,
    // and any other site-wide text files). Always overwritten so a content
    // change to e.g. robots.txt ships with the next build.
    const publicSrc = join(srcWebDir, 'public')
    if (existsSync(publicSrc)) {
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

    // 4. Landing page + search page (cheap; rebuild every run).
    const indexHtml = renderIndexPage(roots, siteConfig)
    await Bun.write(join(buildDir, 'index.html'), indexHtml)
    const searchHtml = renderSearchPage(siteConfig)
    await Bun.write(join(buildDir, 'search', 'index.html'), searchHtml)

    // 5. Build document pages, iterating per-framework so we can batch the
    // sections query and bound peak memory.
    const renderCache = createWebRenderCache(db)
    const knownKeys = renderCache.getKnownKeys()

    const failuresPath = join(buildDir, 'build-failures.jsonl')

    for (const root of roots) {
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

        // Incremental skip: render-index entry matches and the on-disk file
        // still exists. The existsSync guard catches the case where someone
        // wiped `dist/web` but left the DB intact.
        if (incremental) {
          const cached = db.getRenderIndexEntry(doc.id)
          if (cached
            && cached.sections_digest === sectionsDigest
            && cached.template_version === templateVersion
            && existsSync(filePath)
          ) {
            pagesSkipped++
            tickProgress()
            return
          }
        }

        try {
          const html = await renderWithTimeout(() => renderDocumentPage(doc, sections, siteConfig, {
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
    for (const root of roots) {
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

    const durationMs = Math.round(performance.now() - start)
    logger?.info?.(
      `Static site built: ${outDir} ` +
      `(${pagesBuilt} built, ${pagesSkipped} skipped, ${pagesFailed} failed, ` +
      `${frameworksBuilt} frameworks in ${durationMs}ms)`
    )

    return { pagesBuilt, pagesSkipped, pagesFailed, frameworksBuilt, durationMs, outputDir: outDir, searchArtifacts }
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
