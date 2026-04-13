import { join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage } from './templates.js'
import { buildTitleIndex } from './search-artifacts.js'
import { search } from '../commands/search.js'
import { fetchDocPage } from '../apple/api.js'
import { persistFetchedDocPage } from '../pipeline/persist.js'
import { RateLimiter } from '../lib/rate-limiter.js'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Start a local dev server for previewing documentation.
 * @param {object} opts - { port?: number, baseUrl?: string }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ server: object, url: string }}
 */
export function startDevServer(opts, ctx) {
  const port = opts.port ?? 3000
  const { db, dataDir, logger } = ctx
  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
  }

  const srcWebDir = dirname(new URL(import.meta.url).pathname)
  const rateLimiter = new RateLimiter(5, 2)

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)
      const pathname = url.pathname

      // API: live search
      if (pathname === '/api/search') {
        const query = url.searchParams.get('q')
        if (!query) return Response.json({ results: [], total: 0 })
        const searchOpts = { query, limit: 10, fuzzy: true, noDeep: true }
        const framework = url.searchParams.get('framework')
        const language = url.searchParams.get('language')
        const source = url.searchParams.get('source')
        if (framework) searchOpts.framework = framework
        if (language) searchOpts.language = language
        if (source) searchOpts.source = source
        const results = await search(searchOpts, ctx)
        return Response.json(results)
      }

      // Landing page
      if (pathname === '/' || pathname === '/index.html') {
        const roots = db.getRoots()
        const html = renderIndexPage(roots, siteConfig)
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }

      // Static assets from src/web/assets/
      if (pathname.startsWith('/assets/')) {
        const file = pathname.replace('/assets/', '')
        const filePath = join(srcWebDir, 'assets', file)
        if (existsSync(filePath)) {
          const ext = `.${file.split('.').pop()}`
          return new Response(readFileSync(filePath), {
            headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // Worker JS
      if (pathname.startsWith('/worker/')) {
        const file = pathname.replace('/worker/', '')
        const filePath = join(srcWebDir, 'worker', file)
        if (existsSync(filePath)) {
          return new Response(readFileSync(filePath), {
            headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // Title index on demand
      if (pathname === '/data/search/title-index.json') {
        const titleIndex = buildTitleIndex(db)
        return Response.json(titleIndex)
      }

      // Document pages
      if (pathname.startsWith('/docs/')) {
        const key = pathname.replace('/docs/', '').replace(/\/$/, '').replace(/\/index\.html$/, '')
        if (!key) return new Response('Not Found', { status: 404 })

        // Try as framework listing first
        const root = db.getRootBySlug(key)
        if (root) {
          const docs = db.getPagesByRoot(root.slug)
          const html = renderFrameworkPage(root, docs, siteConfig)
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }

        // Try as document page
        let doc = db.db.query(
          'SELECT id, key, title, kind, role, role_heading, framework, abstract_text, source_type FROM documents WHERE key = ?'
        ).get(key)

        // On-demand fetch from Apple if not in database
        if (!doc) {
          try {
            const { json, etag, lastModified } = await fetchDocPage(key, rateLimiter)
            const framework = key.split('/')[0]
            const rootRow = db.getRootBySlug(framework)
            await persistFetchedDocPage({
              db,
              dataDir,
              rootId: rootRow?.id ?? null,
              path: key,
              sourceType: 'apple-docc',
              json,
              etag,
              lastModified,
            })
            doc = db.db.query(
              'SELECT id, key, title, kind, role, role_heading, framework, abstract_text, source_type FROM documents WHERE key = ?'
            ).get(key)
          } catch {
            // fetch failed — fall through to 404
          }
        }

        if (doc) {
          const sections = db.db.query(
            'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'
          ).all(doc.id)
          const html = renderDocumentPage(doc, sections, siteConfig)
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }

        return new Response('Not Found', { status: 404 })
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  return { server, url: serverUrl }
}
