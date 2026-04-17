import { join, dirname } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage } from './templates.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { ensureDir } from '../storage/files.js'
import { pool } from '../lib/pool.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'

/**
 * Build a complete static documentation site from the corpus.
 * @param {object} opts - { out?: string, baseUrl?: string, siteName?: string, fsOps?: { rename: typeof rename, rm: typeof rm } }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ pagesBuilt: number, frameworksBuilt: number, durationMs: number, outputDir: string, searchArtifacts: object }}
 */
export async function buildStaticSite(opts, ctx) {
  const start = performance.now()
  const outDir = opts.out || 'dist/web'
  const buildDir = `${outDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  let frameworksBuilt = 0
  let searchArtifacts = null

  try {
    // 1. Create directory structure
    for (const sub of ['assets', 'docs', 'data/search', 'data/frameworks', 'worker', 'search']) {
      ensureDir(join(buildDir, sub))
    }

    // 2. Copy, minify, and bundle static assets
    const srcWebDir = dirname(new URL(import.meta.url).pathname)

    // 2a. Minify CSS — strip comments, collapse whitespace
    const rawCSS = readFileSync(join(srcWebDir, 'assets', 'style.css'), 'utf8')
    await Bun.write(join(buildDir, 'assets', 'style.css'), minifyCSS(rawCSS))

    // 2b. Bundle JS into logical groups to reduce HTTP requests
    //   core.js    = theme + search + page-toc  (doc, index, framework pages)
    //   listing.js = collection-filters + tree-view  (index, framework pages)
    //   search-page.js  (search page only — standalone)
    //   lang-toggle.js  (doc pages with language variants — standalone)
    const readAsset = (f) => {
      const p = join(srcWebDir, 'assets', f)
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    }

    const coreBundle = [readAsset('theme.js'), readAsset('search.js'), readAsset('page-toc.js')].join('\n')
    const listingBundle = [readAsset('collection-filters.js'), readAsset('tree-view.js')].join('\n')

    await Bun.write(join(buildDir, 'assets', 'core.js'), coreBundle)
    await Bun.write(join(buildDir, 'assets', 'listing.js'), listingBundle)

    // Standalone scripts
    for (const file of ['search-page.js', 'lang-toggle.js']) {
      const src = join(srcWebDir, 'assets', file)
      if (existsSync(src)) {
        await Bun.write(join(buildDir, 'assets', file), readFileSync(src, 'utf8'))
      }
    }

    // Also emit individual files for dev compatibility
    for (const file of ['style.css', 'theme.js', 'search.js', 'search-page.js', 'collection-filters.js', 'page-toc.js', 'tree-view.js', 'lang-toggle.js']) {
      const src = join(srcWebDir, 'assets', file)
      if (existsSync(src) && file !== 'style.css') {
        await Bun.write(join(buildDir, 'assets', file), readFileSync(src, 'utf8'))
      }
    }

    const workerSrc = join(srcWebDir, 'worker', 'search-worker.js')
    if (existsSync(workerSrc)) {
      await Bun.write(join(buildDir, 'worker', 'search-worker.js'), readFileSync(workerSrc, 'utf8'))
    }

    // 3. Get all frameworks/roots
    const roots = db.getRoots()

    // 4. Build landing page + search page
    const indexHtml = renderIndexPage(roots, siteConfig)
    await Bun.write(join(buildDir, 'index.html'), indexHtml)
    const searchHtml = renderSearchPage(siteConfig)
    await Bun.write(join(buildDir, 'search', 'index.html'), searchHtml)

    // 5. Build document pages in batches
    const knownKeys = new Set(
      db.db.query('SELECT key FROM documents').all().map(r => r.key)
    )

    // Pre-build lookup caches to avoid N+1 queries per document
    const ancestorTitleCache = new Map()
    const roleHeadingCache = new Map()
    for (const row of db.db.query('SELECT key, title FROM documents').all()) {
      ancestorTitleCache.set(row.key, row.title)
    }
    for (const row of db.db.query('SELECT key, role_heading FROM documents WHERE role_heading IS NOT NULL').all()) {
      roleHeadingCache.set(row.key, row.role_heading)
    }

    const totalDocs = db.db.query('SELECT COUNT(*) as count FROM documents').get().count
    const batchSize = 500

    for (let offset = 0; offset < totalDocs; offset += batchSize) {
      const docs = db.db.query(
        `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type, d.language,
                d.platforms_json, d.is_deprecated, d.is_beta,
                COALESCE(r.display_name, d.framework) as framework_display
         FROM documents d LEFT JOIN roots r ON r.slug = d.framework
         ORDER BY d.key LIMIT ? OFFSET ?`
      ).all(batchSize, offset)

      await pool(docs, 16, async (doc) => {
        try {
          const sections = db.hasTable('document_sections')
            ? db.db.query(
              'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'
            ).all(doc.id)
            : []

          // Resolve ancestor titles for breadcrumbs from pre-built cache
          const ancestorTitles = new Map()
          if (doc.key) {
            const segs = doc.key.split('/').filter(Boolean)
            for (let i = 1; i < segs.length - 1; i++) {
              const partialKey = segs.slice(0, i + 1).join('/')
              const title = ancestorTitleCache.get(partialKey)
              if (title) ancestorTitles.set(partialKey, title)
            }
          }

          const html = renderDocumentPage(doc, sections, siteConfig, {
            knownKeys,
            ancestorTitles,
            resolveRoleHeadings: (keys) => {
              const map = new Map()
              for (const key of keys) {
                const rh = roleHeadingCache.get(key)
                if (rh) map.set(key, rh)
              }
              return map
            }
          })
          const filePath = join(buildDir, 'docs', doc.key, 'index.html')
          ensureDir(dirname(filePath))
          await Bun.write(filePath, html)
          pagesBuilt++
        } catch (err) {
          if (logger) logger.warn(`Failed to build page ${doc.key}: ${err.message}`)
        }
      })

      if (logger) logger.info(`Built ${pagesBuilt}/${totalDocs} pages`)
    }

    // 6. Build framework listing pages
    for (const root of roots) {
      const docs = db.db.query(
        'SELECT key, title, kind, role, role_heading, abstract_text FROM documents WHERE framework = ? ORDER BY title'
      ).all(root.slug)
      if (docs.length === 0) continue

      const treeEdges = db.getFrameworkTree(root.slug)
      const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges })
      const filePath = join(buildDir, 'docs', root.slug, 'index.html')
      ensureDir(dirname(filePath))
      await Bun.write(filePath, html)
      frameworksBuilt++
    }

    // 7. Generate search artifacts
    searchArtifacts = await generateSearchArtifacts(db, join(buildDir, 'data', 'search'))

    // 8. Write per-framework metadata
    for (const root of roots) {
      const count = db.db.query('SELECT COUNT(*) as count FROM documents WHERE framework = ?').get(root.slug).count
      await Bun.write(
        join(buildDir, 'data', 'frameworks', `${root.slug}.json`),
        JSON.stringify({ slug: root.slug, displayName: root.display_name, kind: root.kind, documentCount: count })
      )
    }

    // 9. Write manifest
    const manifest = {
      version: 1,
      siteName: siteConfig.siteName,
      buildDate: siteConfig.buildDate,
      baseUrl: siteConfig.baseUrl,
      totalDocuments: pagesBuilt,
      totalFrameworks: frameworksBuilt,
      searchArtifacts,
    }
    await Bun.write(join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

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

    const durationMs = Math.round(performance.now() - start)
    if (logger) logger.info(`Static site built: ${outDir} (${pagesBuilt} pages, ${frameworksBuilt} frameworks in ${durationMs}ms)`)

    return { pagesBuilt, frameworksBuilt, durationMs, outputDir: outDir, searchArtifacts }
  } catch (error) {
    await fsOps.rm(buildDir, { recursive: true, force: true })
    throw error
  } finally {
    disposeHighlighter()
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
