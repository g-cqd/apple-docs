import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage } from './templates.js'
import { buildTitleIndex, buildAliasMap } from './search-artifacts.js'
import { search } from '../commands/search.js'
import { fetchDocPage } from '../apple/api.js'
import { persistFetchedDocPage } from '../pipeline/persist.js'
import { RateLimiter } from '../lib/rate-limiter.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter } from '../content/highlight.js'

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
export async function startDevServer(opts, ctx) {
  const port = opts.port ?? 3000
  const { db, dataDir, logger } = ctx
  const siteConfig = {
    baseUrl: opts.baseUrl || '',
    siteName: opts.siteName || 'Apple Developer Docs',
    buildDate: new Date().toISOString().split('T')[0],
  }

  await initHighlighter()

  const srcWebDir = dirname(new URL(import.meta.url).pathname)
  const rateLimiter = new RateLimiter(5, 2)

  // Lazy-built known keys set for declaration type linking
  let knownKeys = null
  function getKnownKeys() {
    if (!knownKeys) {
      knownKeys = new Set(db.db.query('SELECT key FROM documents').all().map(r => r.key))
    }
    return knownKeys
  }

  // Cached search artifacts (invalidated when knownKeys resets)
  let cachedTitleIndex = null
  let cachedAliasMap = null
  function getTitleIndex() { return cachedTitleIndex ??= buildTitleIndex(db) }
  function getAliasMap() { return cachedAliasMap ??= buildAliasMap(db) }

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }

  const COMPRESSIBLE = new Set(['text/html', 'text/css', 'text/javascript', 'application/json'])

  const server = Bun.serve({
    port,
    async fetch(request) {
      const response = await handleRequest(request)
      for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v)

      // Gzip compress text responses when client accepts it
      const accept = request.headers.get('accept-encoding') || ''
      const ct = response.headers.get('content-type') || ''
      const mimeBase = ct.split(';')[0].trim()
      if (accept.includes('gzip') && COMPRESSIBLE.has(mimeBase)) {
        const body = await response.arrayBuffer()
        const compressed = gzipSync(Buffer.from(body))
        return new Response(compressed, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            'Content-Encoding': 'gzip',
            'Content-Length': String(compressed.length),
          },
        })
      }

      return response
    },
  })

  async function handleRequest(request) {
      const url = new URL(request.url)
      const pathname = url.pathname

      // API: live search
      if (pathname === '/api/search') {
        const query = url.searchParams.get('q')
        if (!query) return Response.json({ results: [], total: 0 })
        const searchOpts = {
          query,
          limit: Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50') || 50, 200),
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
        if (offset > 0) searchOpts.offset = offset
        const results = await search(searchOpts, ctx)
        return Response.json(results)
      }

      // API: filter options for search page
      if (pathname === '/api/filters') {
        const frameworks = db.db.query(
          `SELECT DISTINCT COALESCE(r.display_name, d.framework) as label, d.framework as value
           FROM documents d LEFT JOIN roots r ON r.slug = d.framework
           WHERE d.framework IS NOT NULL ORDER BY label`
        ).all().map(r => ({ label: r.label, value: r.value }))
        const kinds = db.db.query('SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading').all().map(r => r.role_heading)
        return Response.json({ frameworks, kinds })
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
        if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })
        const filePath = join(srcWebDir, 'assets', file)
        const bunFile = Bun.file(filePath)
        if (await bunFile.exists()) {
          const ext = `.${file.split('.').pop()}`
          return new Response(bunFile, {
            headers: {
              'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
              'Cache-Control': 'public, max-age=3600',
            },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // Worker JS
      if (pathname.startsWith('/worker/')) {
        const file = pathname.replace('/worker/', '')
        if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })
        const filePath = join(srcWebDir, 'worker', file)
        const bunFile = Bun.file(filePath)
        if (await bunFile.exists()) {
          return new Response(bunFile, {
            headers: {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
            },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // Search data on demand — supports manifest-based and direct access
      if (pathname === '/data/search/search-manifest.json') {
        // Build on-demand and generate a manifest with hashed filenames
        const titleIndex = getTitleIndex()
        const aliasMap = getAliasMap()
        const titleJson = JSON.stringify(titleIndex)
        const aliasJson = JSON.stringify(aliasMap)
        const titleHash = sha256(titleJson).slice(0, 10)
        const aliasHash = sha256(aliasJson).slice(0, 10)
        const manifest = {
          version: 2,
          titleCount: titleIndex.keys.length,
          aliasCount: Object.keys(aliasMap).length,
          shardCount: 0,
          files: {
            'title-index': `title-index.${titleHash}.json`,
            'aliases': `aliases.${aliasHash}.json`,
          },
          generatedAt: new Date().toISOString(),
        }
        return Response.json(manifest, {
          headers: { 'Cache-Control': 'no-cache' },
        })
      }

      // Content-hashed search artifacts: immutable caching
      if (pathname.startsWith('/data/search/') && /\.[0-9a-f]{10}\.json$/.test(pathname)) {
        const fileName = pathname.replace('/data/search/', '')
        // Determine which artifact this is
        if (fileName.startsWith('title-index.')) {
          return Response.json(getTitleIndex(), {
            headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          })
        }
        if (fileName.startsWith('aliases.')) {
          return Response.json(getAliasMap(), {
            headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      // Unhashed fallback for backward compatibility
      if (pathname === '/data/search/title-index.json') {
        return Response.json(getTitleIndex())
      }
      if (pathname === '/data/search/aliases.json') {
        return Response.json(getAliasMap())
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
            const treeEdges = db.getFrameworkTree(root.slug)
            const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges })
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          }
          // Fall through to document page rendering
        }

        // Try as document page
        let doc = db.db.query(
          `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type,
                  d.platforms_json, d.is_deprecated, d.is_beta,
                  COALESCE(r.display_name, d.framework) as framework_display
           FROM documents d LEFT JOIN roots r ON r.slug = d.framework WHERE d.key = ?`
        ).get(key)

        // On-demand fetch from Apple if not in database
        if (!doc && /^[a-z][a-z0-9_-]*(?:\/[a-z0-9_-]+)*$/i.test(key)) {
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
              `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type,
                      d.platforms_json, d.is_deprecated, d.is_beta,
                      COALESCE(r.display_name, d.framework) as framework_display
               FROM documents d LEFT JOIN roots r ON r.slug = d.framework WHERE d.key = ?`
            ).get(key)
            knownKeys = null; cachedTitleIndex = null; cachedAliasMap = null // invalidate caches
          } catch {
            // fetch failed — fall through to 404
          }
        }

        if (doc) {
          let sections = db.hasTable('document_sections')
            ? db.db.query(
              'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'
            ).all(doc.id)
            : []

          // On-demand fetch sections for lite snapshots (doc exists but sections are missing)
          if (sections.length === 0 && doc.source_type === 'apple-docc') {
            try {
              db.ensureSectionsTable()
              const { json, etag, lastModified } = await fetchDocPage(doc.key, rateLimiter)
              const framework = doc.key.split('/')[0]
              const rootRow = db.getRootBySlug(framework)
              await persistFetchedDocPage({
                db,
                dataDir,
                rootId: rootRow?.id ?? null,
                path: doc.key,
                sourceType: 'apple-docc',
                json,
                etag,
                lastModified,
              })
              sections = db.db.query(
                'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'
              ).all(doc.id)
              knownKeys = null
            } catch {
              // fetch failed — render with empty sections
            }
          }

          // Resolve ancestor titles for breadcrumbs
          const ancestorTitles = new Map()
          if (doc.key) {
            const segs = doc.key.split('/').filter(Boolean)
            for (let i = 1; i < segs.length - 1; i++) {
              const partialKey = segs.slice(0, i + 1).join('/')
              const row = db.db.query('SELECT title FROM documents WHERE key = ?').get(partialKey)
              if (row?.title) ancestorTitles.set(partialKey, row.title)
            }
          }

          const html = renderDocumentPage(doc, sections, siteConfig, {
            knownKeys: getKnownKeys(),
            ancestorTitles,
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
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }

        return new Response('Not Found', { status: 404 })
      }

      return new Response('Not Found', { status: 404 })
  }

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  return { server, url: serverUrl }
}
