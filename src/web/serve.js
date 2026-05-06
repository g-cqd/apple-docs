import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage, buildFrameworkTreeData } from './templates.js'
import { buildTitleIndex, buildAliasMap } from './search-artifacts.js'
import { createWebRenderCache } from './render-cache.js'
import { search } from '../commands/search.js'
import { fetchDocPage } from '../apple/api.js'
import { persistFetchedDocPage } from '../pipeline/persist.js'
import { createHostBucketedLimiter } from '../lib/per-host-rate-limiter.js'
import { sha256 } from '../lib/hash.js'
import { initHighlighter } from '../content/highlight.js'
import { createLru } from '../lib/lru.js'

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
    assetVersion: Date.now().toString(36),
  }

  void initHighlighter().catch((err) => {
    logger.warn('Syntax highlighter unavailable:', err.message)
  })

  const srcWebDir = dirname(new URL(import.meta.url).pathname)
  const rateLimiter = createHostBucketedLimiter({
    defaults: { rate: 5, burst: 2 },
    primary: { rate: 5, burst: 2 },
  })
  const renderCache = createWebRenderCache(db)

  // Cached search artifacts (invalidated when the document corpus changes)
  let cachedTitleIndex = null
  let cachedAliasMap = null
  let cachedSearchManifest = null
  // Framework tree-view JSON cache. Each framework page render computes the
  // tree JSON, hashes it, and stores it here keyed by `<slug>:<hash>`. The
  // /data/frameworks/<slug>/tree.<hash>.json route reads from this map so we
  // never re-render or re-hash on the cacheable path. Memory footprint is
  // bounded by `frameworkTreeMax`; LRU eviction keeps it small.
  const frameworkTreeCache = createLru({ max: 64 })
  const frameworkTreeBySlug = new Map()
  function getTitleIndex() { return cachedTitleIndex ??= buildTitleIndex(db) }
  function getAliasMap() { return cachedAliasMap ??= buildAliasMap(db) }
  function invalidateDocumentCaches() {
    renderCache.invalidate()
    cachedTitleIndex = null
    cachedAliasMap = null
    cachedSearchManifest = null
  }
  function getSearchManifest() {
    if (cachedSearchManifest) return cachedSearchManifest
    const titleIndex = getTitleIndex()
    const aliasMap = getAliasMap()
    const titleJson = JSON.stringify(titleIndex)
    const aliasJson = JSON.stringify(aliasMap)
    const titleHash = sha256(titleJson).slice(0, 10)
    const aliasHash = sha256(aliasJson).slice(0, 10)
    cachedSearchManifest = {
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
    return cachedSearchManifest
  }

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
  // In production Caddy serves /assets/* and /worker/* directly from disk
  // with `Cache-Control: public, max-age=31536000, immutable` (configured in
  // Caddyfile.tpl). Bun's copies are only hit by `apple-docs web serve` for
  // local previews — but those benefit from cacheable headers too, since
  // `?v=<assetVersion>` busts the cache on every server restart.
  const assetCacheHeaders = {
    'Cache-Control': 'public, max-age=31536000, immutable',
  }

  const COMPRESSIBLE = new Set(['text/html', 'text/css', 'text/javascript', 'application/json'])
  const gzipCache = createLru({ max: 256 })

  function jsonResponse(data, { headers = {}, status = 200, hashable = false } = {}) {
    const response = Response.json(data, { status, headers })
    if (hashable) response.headers.set('x-apple-docs-hashable', '1')
    return response
  }

  function textResponse(body, { contentType = 'text/plain; charset=utf-8', headers = {}, status = 200, hashable = false } = {}) {
    const response = new Response(body, {
      status,
      headers: {
        'Content-Type': contentType,
        ...headers,
      },
    })
    if (hashable) response.headers.set('x-apple-docs-hashable', '1')
    return response
  }

  function matchesIfNoneMatch(headerValue, etag) {
    if (!headerValue) return false
    const value = headerValue.trim()
    if (value === '*') return true
    return value.split(',').map(part => part.trim()).includes(etag)
  }

  async function finalizeResponse(request, response) {
    const accept = request.headers.get('accept-encoding') || ''
    const hashable = response.headers.get('x-apple-docs-hashable') === '1'
    response.headers.delete('x-apple-docs-hashable')

    const contentType = response.headers.get('content-type') || ''
    const mimeBase = contentType.split(';')[0].trim()

    if (hashable) {
      const body = await response.text()
      const etag = `"${sha256(body).slice(0, 16)}"`
      const headers = new Headers(response.headers)
      headers.set('ETag', etag)

      if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
        headers.delete('Content-Encoding')
        headers.delete('Content-Length')
        headers.delete('Content-Type')
        return new Response(null, { status: 304, headers })
      }

      if (accept.includes('gzip') && COMPRESSIBLE.has(mimeBase)) {
        let compressed = gzipCache.get(etag)
        if (!compressed) {
          compressed = gzipSync(Buffer.from(body))
          gzipCache.set(etag, compressed)
        }
        headers.set('Content-Encoding', 'gzip')
        headers.set('Content-Length', String(compressed.length))
        return new Response(compressed, { status: response.status, headers })
      }

      return new Response(body, { status: response.status, headers })
    }

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
  }

  async function handleRequest(request) {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Liveness probe: must not touch the DB or any cache so a stuck
    // request handler does not also fail the upstream health check.
    // `no-store` so a cached 200 cannot mask a wedged origin.
    if (pathname === '/healthz') {
      return jsonResponse(
        { ok: true, service: 'apple-docs-web' },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    // API: live search
    if (pathname === '/api/search') {
      const query = url.searchParams.get('q')
      if (!query) return jsonResponse({ results: [], total: 0 })
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
      return jsonResponse(results, { hashable: true })
    }

    // API: filter options for search page
    if (pathname === '/api/filters') {
      const frameworks = db.db.query(
        `SELECT DISTINCT COALESCE(r.display_name, d.framework) as label, d.framework as value
         FROM documents d LEFT JOIN roots r ON r.slug = d.framework
         WHERE d.framework IS NOT NULL ORDER BY label`
      ).all().map(r => ({ label: r.label, value: r.value }))
      const kinds = db.db.query('SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading').all().map(r => r.role_heading)
      return jsonResponse({ frameworks, kinds })
    }

    // Search page
    if (pathname === '/search' || pathname === '/search/') {
      const html = renderSearchPage(siteConfig)
      return textResponse(html, { contentType: 'text/html; charset=utf-8' })
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
      return textResponse(html, { contentType: 'text/html; charset=utf-8' })
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
            ...assetCacheHeaders,
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
            ...assetCacheHeaders,
          },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    // Search data on demand — supports manifest-based and direct access
    if (pathname === '/data/search/search-manifest.json') {
      return jsonResponse(getSearchManifest(), {
        headers: { 'Cache-Control': 'no-cache' },
        hashable: true,
      })
    }

    // Content-hashed search artifacts: immutable caching
    if (pathname.startsWith('/data/search/') && /\.[0-9a-f]{10}\.json$/.test(pathname)) {
      const fileName = pathname.replace('/data/search/', '')
      if (fileName.startsWith('title-index.')) {
        return jsonResponse(getTitleIndex(), {
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          hashable: true,
        })
      }
      if (fileName.startsWith('aliases.')) {
        return jsonResponse(getAliasMap(), {
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          hashable: true,
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    // Unhashed fallback for backward compatibility
    if (pathname === '/data/search/title-index.json') {
      return jsonResponse(getTitleIndex())
    }

    // Framework tree-view JSON. Filled by the framework-page render above.
    // If the cache misses (cold start, eviction, or a bot probing a stale
    // hash), we re-render the framework's tree JSON from the DB so the URL
    // is always satisfiable. Hashed responses are immutable to Cloudflare.
    {
      const treeMatch = pathname.match(/^\/data\/frameworks\/([^/]+)\/tree\.([0-9a-f]{10})\.json$/)
      if (treeMatch) {
        const [, slug, hash] = treeMatch
        const cacheKey = `${slug}:${hash}`
        let json = frameworkTreeCache.get(cacheKey)
        if (json === undefined) {
          const root = db.getRootBySlug(slug)
          if (!root) return new Response('Not Found', { status: 404 })
          const docs = db.getPagesByRoot(root.slug)
          const treeEdges = db.getFrameworkTree(root.slug)
          const fresh = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
          if (!fresh.hasTree) return new Response('Not Found', { status: 404 })
          // Surface the freshly-computed JSON regardless of hash mismatch:
          // the requested URL has the hash baked in, so there's no risk of
          // serving the wrong content under a different cache key.
          json = fresh.json
          frameworkTreeCache.set(`${slug}:${sha256(fresh.json).slice(0, 10)}`, fresh.json)
        }
        return new Response(json, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      }
    }
    if (pathname === '/data/search/aliases.json') {
      return jsonResponse(getAliasMap())
    }

    // Document pages
    if (pathname.startsWith('/docs/')) {
      const key = pathname.replace('/docs/', '').replace(/\/$/, '').replace(/\/index\.html$/, '')
      if (!key) return new Response('Not Found', { status: 404 })

      // Try as framework listing first
      const root = db.getRootBySlug(key)
      if (root) {
        const docs = db.getPagesByRoot(root.slug)
        const isSelfRef = docs.length <= 1 && docs[0]?.path === key
        if (!isSelfRef && docs.length > 0) {
          const treeEdges = db.getFrameworkTree(root.slug)
          // Externalise the tree-view JSON: hash the payload, stash it in
          // the in-memory cache, and pass `treeDataUrl` so the rendered
          // HTML emits a `data-tree-src` reference (~50 KB) instead of an
          // ~5 MB inline `<script type="application/json">`. The JSON is
          // served by the /data/frameworks/<slug>/tree.<hash>.json route
          // below with `Cache-Control: immutable`, so Cloudflare caches
          // both the HTML and the JSON for a year (the hash invalidates
          // on rebuild).
          const tree = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
          let treeDataUrl = null
          if (tree.hasTree) {
            const hash = sha256(tree.json).slice(0, 10)
            const cacheKey = `${root.slug}:${hash}`
            frameworkTreeCache.set(cacheKey, tree.json)
            // Also stash the latest hash per slug so the URL we emit in
            // HTML always matches whatever the route can satisfy.
            frameworkTreeBySlug.set(root.slug, hash)
            treeDataUrl = `${siteConfig.baseUrl || ''}/data/frameworks/${root.slug}/tree.${hash}.json`
          }
          const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges, treeDataUrl })
          return textResponse(html, { contentType: 'text/html; charset=utf-8', hashable: true })
        }
      }

      // Try as document page
      let doc = db.db.query(
        `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type, d.url,
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
            `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type, d.url,
                    d.platforms_json, d.is_deprecated, d.is_beta,
                    COALESCE(r.display_name, d.framework) as framework_display
             FROM documents d LEFT JOIN roots r ON r.slug = d.framework WHERE d.key = ?`
          ).get(key)
           invalidateDocumentCaches()
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
             invalidateDocumentCaches()
           } catch {
             // fetch failed — render with empty sections
           }
         }

        const html = renderDocumentPage(doc, sections, siteConfig, {
          knownKeys: renderCache.getKnownKeys(),
          ancestorTitles: renderCache.getAncestorTitles(doc.key),
          resolveRoleHeadings: (keys) => renderCache.getRoleHeadings(keys),
        })
        return textResponse(html, { contentType: 'text/html; charset=utf-8', hashable: true })
      }

      return new Response('Not Found', { status: 404 })
    }

    return new Response('Not Found', { status: 404 })
  }

  const server = Bun.serve({
    port,
    async fetch(request) {
      const response = await handleRequest(request)
      for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v)
      return finalizeResponse(request, response)
    },
  })

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  return { server, url: serverUrl }
}
