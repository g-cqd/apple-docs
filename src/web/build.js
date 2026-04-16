import { join, dirname } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage } from './templates.js'
import { generateSearchArtifacts } from './search-artifacts.js'
import { ensureDir } from '../storage/files.js'
import { pool } from '../lib/pool.js'
import { initHighlighter, disposeHighlighter } from '../content/highlight.js'

/**
 * Build a complete static documentation site from the corpus.
 * @param {object} opts - { out?: string, baseUrl?: string, siteName?: string }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ pagesBuilt: number, frameworksBuilt: number, durationMs: number, outputDir: string, searchArtifacts: object }}
 */
export async function buildStaticSite(opts, ctx) {
  const start = performance.now()
  await initHighlighter()
  const outDir = opts.out || 'dist/web'
  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
  }
  const { db, logger } = ctx

  // 1. Create directory structure
  for (const sub of ['assets', 'docs', 'data/search', 'data/frameworks', 'worker', 'search']) {
    ensureDir(join(outDir, sub))
  }

  // 2. Copy static assets (CSS, JS, theme, worker)
  const srcWebDir = dirname(new URL(import.meta.url).pathname)
  for (const file of ['style.css', 'theme.js', 'search.js', 'search-page.js', 'collection-filters.js', 'page-toc.js', 'tree-view.js']) {
    const src = join(srcWebDir, 'assets', file)
    if (existsSync(src)) {
      await Bun.write(join(outDir, 'assets', file), readFileSync(src, 'utf8'))
    }
  }
  const workerSrc = join(srcWebDir, 'worker', 'search-worker.js')
  if (existsSync(workerSrc)) {
    await Bun.write(join(outDir, 'worker', 'search-worker.js'), readFileSync(workerSrc, 'utf8'))
  }

  // 3. Get all frameworks/roots
  const roots = db.getRoots()

  // 4. Build landing page + search page
  const indexHtml = renderIndexPage(roots, siteConfig)
  await Bun.write(join(outDir, 'index.html'), indexHtml)
  const searchHtml = renderSearchPage(siteConfig)
  await Bun.write(join(outDir, 'search', 'index.html'), searchHtml)

  // 5. Build document pages in batches
  const knownKeys = new Set(
    db.db.query('SELECT key FROM documents').all().map(r => r.key)
  )
  const totalDocs = db.db.query('SELECT COUNT(*) as count FROM documents').get().count
  const batchSize = 500
  let pagesBuilt = 0

  for (let offset = 0; offset < totalDocs; offset += batchSize) {
    const docs = db.db.query(
      `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type, d.language,
              COALESCE(r.display_name, d.framework) as framework_display
       FROM documents d LEFT JOIN roots r ON r.slug = d.framework
       ORDER BY d.key LIMIT ? OFFSET ?`
    ).all(batchSize, offset)

    await pool(docs, 50, async (doc) => {
      const sections = db.hasTable('document_sections')
        ? db.db.query(
          'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'
        ).all(doc.id)
        : []
      const html = renderDocumentPage(doc, sections, siteConfig, {
        knownKeys,
        resolveRoleHeadings: (keys) => {
          if (keys.length === 0) return new Map()
          const placeholders = keys.map(() => '?').join(',')
          const rows = db.db.query(
            `SELECT key, role_heading FROM documents WHERE key IN (${placeholders})`
          ).all(...keys)
          const map = new Map()
          for (const r of rows) if (r.role_heading) map.set(r.key, r.role_heading)
          return map
        }
      })
      const filePath = join(outDir, 'docs', doc.key, 'index.html')
      ensureDir(dirname(filePath))
      await Bun.write(filePath, html)
      pagesBuilt++
    })

    if (logger) logger.info(`Built ${pagesBuilt}/${totalDocs} pages`)
  }

  // 6. Build framework listing pages
  let frameworksBuilt = 0
  for (const root of roots) {
    const docs = db.db.query(
      'SELECT key, title, kind, role, role_heading, abstract_text FROM documents WHERE framework = ? ORDER BY title'
    ).all(root.slug)
    if (docs.length === 0) continue

    const treeEdges = db.getFrameworkTree(root.slug)
    const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges })
    const filePath = join(outDir, 'docs', root.slug, 'index.html')
    ensureDir(dirname(filePath))
    await Bun.write(filePath, html)
    frameworksBuilt++
  }

  // 7. Generate search artifacts
  const searchArtifacts = await generateSearchArtifacts(db, join(outDir, 'data', 'search'))

  // 8. Write per-framework metadata
  for (const root of roots) {
    const count = db.db.query('SELECT COUNT(*) as count FROM documents WHERE framework = ?').get(root.slug).count
    await Bun.write(
      join(outDir, 'data', 'frameworks', `${root.slug}.json`),
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
  await Bun.write(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  disposeHighlighter()

  const durationMs = Math.round(performance.now() - start)
  if (logger) logger.info(`Static site built: ${outDir} (${pagesBuilt} pages, ${frameworksBuilt} frameworks in ${durationMs}ms)`)

  return { pagesBuilt, frameworksBuilt, durationMs, outputDir: outDir, searchArtifacts }
}
