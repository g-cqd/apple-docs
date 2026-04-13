import { join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage } from './templates.js'
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
        const searchOpts = {
          query,
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50') || 50,
          fuzzy: url.searchParams.get('no_fuzzy') !== '1',
          noDeep: url.searchParams.get('no_deep') === '1',
          noEager: url.searchParams.get('no_eager') === '1',
        }
        for (const key of ['framework', 'language', 'source', 'kind', 'platform']) {
          const val = url.searchParams.get(key)
          if (val) searchOpts[key] = val
        }
        for (const key of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos']) {
          const val = url.searchParams.get(key)
          if (val) searchOpts[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = val
        }
        const year = url.searchParams.get('year')
        if (year) searchOpts.year = Number.parseInt(year)
        const track = url.searchParams.get('track')
        if (track) searchOpts.track = track
        const offset = Number.parseInt(url.searchParams.get('offset') ?? '0') || 0
        const results = await search(searchOpts, ctx)
        if (offset > 0) {
          results.results = results.results.slice(offset)
        }
        return Response.json(results)
      }

      // API: filter options for search page
      if (pathname === '/api/filters') {
        const frameworks = db.db.query('SELECT DISTINCT framework FROM documents WHERE framework IS NOT NULL ORDER BY framework').all().map(r => r.framework)
        const sources = db.db.query('SELECT DISTINCT source_type FROM documents WHERE source_type IS NOT NULL ORDER BY source_type').all().map(r => r.source_type)
        const kinds = db.db.query('SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading').all().map(r => r.role_heading)
        return Response.json({ frameworks, sources, kinds })
      }

      // Search page
      if (pathname === '/search' || pathname === '/search/') {
        const html = renderSearchPage(siteConfig)
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }

      // Landing page
      if (pathname === '/' || pathname === '/index.html') {
        const roots = db.getRoots().filter(r => {
          // Hide self-referential roots (collection pages with only themselves as content)
          if (r.page_count <= 1) {
            const pages = db.getPagesByRoot(r.slug)
            if (pages.length <= 1 && (!pages[0] || pages[0].path === r.slug)) return false
          }
          return true
        })
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
          // Self-referential roots (only contain themselves) should render as
          // document pages instead of empty framework listings
          const isSelfRef = docs.length <= 1 && docs[0]?.path === key
          if (!isSelfRef && docs.length > 0) {
            const html = renderFrameworkPage(root, docs, siteConfig)
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          }
          // Fall through to document page rendering
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
