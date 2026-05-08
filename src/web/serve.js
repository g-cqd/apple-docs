import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { renderDocumentPage, renderIndexPage, renderFrameworkPage, renderSearchPage, renderFontsPage, renderSymbolsPage, buildFrameworkTreeData } from './templates.js'
import { search } from '../commands/search.js'
import { fetchDocPage } from '../apple/api.js'
import { persistFetchedDocPage } from '../pipeline/persist.js'
import { sha256 } from '../lib/hash.js'
import { getPrerenderedSymbolPath, listAppleFonts, renderFontText, renderSfSymbol, searchSfSymbols } from '../resources/apple-assets.js'
import { buildStoreZip } from '../lib/zip.js'
import { ASSET_BUNDLES } from './assets-manifest.js'
import {
  MIME_TYPES,
  jsonResponse,
  textResponse,
  notFoundResponse,
  matchesIfNoneMatch,
  fileResponseRevalidated,
  finalizeResponse,
} from './responses.js'
import { createWebContext } from './context.js'

// Cache directive for JSON endpoints whose result is a pure function of the
// current corpus (`/api/search`, `/api/filters`). Cloudflare's default policy
// is to skip caching JSON without an explicit Cache-Control directive, so
// these used to land at Bun on every request even though the corpus is
// effectively static between syncs. Pairing this directive with an explicit
// CF cache purge after every deploy (ops/bin/cf-purge.sh) gives instant
// coherence without staleness drift.
const API_CORPUS_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600'

/**
 * Start a local dev server for previewing documentation.
 * @param {object} opts - { port?: number, baseUrl?: string }
 * @param {object} ctx - { db, dataDir, logger }
 * @returns {{ server: object, url: string }}
 */
export async function startDevServer(opts, ctx) {
  const port = opts.port ?? 3000
  const webCtx = await createWebContext(opts, ctx)
  const {
    db,
    dataDir,
    logger,
    siteConfig,
    srcWebDir,
    rateLimiter,
    renderCache,
    readerPool,
    searchCtx,
    searchCache,
    corpusStamp,
    frameworkTreeCache,
    frameworkTreeBySlug,
    securityHeaders,
    assetCacheHeaders,
    gzipCache,
    getTitleIndex,
    getAliasMap,
    getSearchManifest,
    invalidateDocumentCaches,
  } = webCtx

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
      const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('full_text') === '1'
      const searchOpts = {
        query,
        limit: Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50') || 50, 200),
        fuzzy: url.searchParams.get('fuzzy') === '1' && url.searchParams.get('no_fuzzy') !== '1',
        noDeep: url.searchParams.get('no_deep') === '1' || !deep,
        noEager: url.searchParams.get('no_eager') === '1',
        fast: url.searchParams.get('exhaustive') !== '1',
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
      const cacheKey = searchResponseCacheKey(searchOpts, corpusStamp.get())
      const cached = searchCache.get(cacheKey)
      if (cached !== undefined) {
        return jsonResponse(cached, {
          hashable: true,
          headers: { 'x-apple-docs-cache': 'hit', 'Cache-Control': API_CORPUS_CACHE_CONTROL },
        })
      }
      const results = await search(searchOpts, searchCtx)
      searchCache.set(cacheKey, results)
      return jsonResponse(results, {
        hashable: true,
        headers: { 'x-apple-docs-cache': 'miss', 'Cache-Control': API_CORPUS_CACHE_CONTROL },
      })
    }

    // API: filter options for search page
    if (pathname === '/api/filters') {
      const frameworks = db.db.query(
        `SELECT DISTINCT COALESCE(r.display_name, d.framework) as label, d.framework as value
         FROM documents d LEFT JOIN roots r ON r.slug = d.framework
         WHERE d.framework IS NOT NULL ORDER BY label`
      ).all().map(r => ({ label: r.label, value: r.value }))
      const kinds = db.db.query('SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading').all().map(r => r.role_heading)
      return jsonResponse({ frameworks, kinds }, {
        headers: { 'Cache-Control': API_CORPUS_CACHE_CONTROL },
      })
    }

    if (pathname === '/api/fonts') {
      return jsonResponse(listAppleFonts(ctx), { hashable: true })
    }

    {
      const fileMatch = pathname.match(/^\/api\/fonts\/file\/([^/]+)$/)
      if (fileMatch) {
        const font = db.getAppleFontFile(decodeURIComponent(fileMatch[1]))
        if (!font) return new Response('Not Found', { status: 404 })
        const file = Bun.file(font.file_path)
        if (!await file.exists()) return new Response('Not Found', { status: 404 })
        const ext = extname(font.file_path).toLowerCase()
        return await fileResponseRevalidated(request, file, {
          contentType: MIME_TYPES[ext] || 'application/octet-stream',
          contentDisposition: `attachment; filename="${font.file_name.replaceAll('"', '')}"`,
          // Apple ships new font versions on macOS releases. URL is stable
          // (font id), so revalidate via ETag instead of pinning forever.
          maxAge: 86400,
        })
      }
    }

    {
      const familyMatch = pathname.match(/^\/api\/fonts\/family\/([^/]+)\.zip$/)
      if (familyMatch) {
        const familyId = decodeURIComponent(familyMatch[1])
        const subset = String(url.searchParams.get('subset') ?? 'all').toLowerCase()
        const families = db.listAppleFonts()
        const family = families.find(f => f.id === familyId)
        if (!family || family.files.length === 0) return new Response('Not Found', { status: 404 })
        const filtered = family.files.filter(file => {
          switch (subset) {
            case 'variable': return !!file.is_variable
            case 'static': return !file.is_variable
            case 'remote': return file.source === 'remote'
            case 'system': return file.source === 'system'
            default: return true
          }
        })
        if (filtered.length === 0) return new Response('Not Found', { status: 404 })
        // Dedupe by file_name as a defensive belt; the schema upgrade in v12
        // already enforces this at insert time.
        const entries = []
        const seen = new Set()
        for (const fontFile of filtered) {
          if (seen.has(fontFile.file_name)) continue
          const file = Bun.file(fontFile.file_path)
          if (!await file.exists()) continue
          const bytes = new Uint8Array(await file.arrayBuffer())
          entries.push({ name: fontFile.file_name, data: bytes })
          seen.add(fontFile.file_name)
        }
        if (entries.length === 0) return new Response('Not Found', { status: 404 })
        const zip = buildStoreZip(entries)
        const fileNameSuffix = subset !== 'all' ? `-${subset}` : ''
        // ETag derived from the SHA-1 of the zip bytes — STORE-method
        // archives are deterministic enough that identical inputs produce
        // identical bytes, so the ETag changes if and only if the family
        // contents change (or we add/remove subsets).
        const etag = `"${sha256(zip).slice(0, 16)}"`
        const headers = new Headers({
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${familyId}${fileNameSuffix}.zip"`,
          'Content-Length': String(zip.byteLength),
          'ETag': etag,
          'Cache-Control': 'public, max-age=86400, must-revalidate',
        })
        if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
          return new Response(null, { status: 304, headers })
        }
        return new Response(zip, { status: 200, headers })
      }
    }

    if (pathname === '/api/symbols/index.json') {
      const catalog = db.listSfSymbolsCatalog()
      return jsonResponse({ count: catalog.length, symbols: catalog }, { hashable: true })
    }

    if (pathname === '/api/symbols/search') {
      return jsonResponse(searchSfSymbols(
        url.searchParams.get('q') ?? '',
        {
          scope: url.searchParams.get('scope') || undefined,
          limit: url.searchParams.get('limit') || undefined,
        },
        ctx,
      ), { hashable: true })
    }

    if (pathname === '/api/fonts/text.svg') {
      try {
        const render = await renderFontText({
          fontId: url.searchParams.get('fontId'),
          text: url.searchParams.get('text') ?? 'Typography',
          size: url.searchParams.get('size') ?? undefined,
        }, ctx)
        return textResponse(render.content, {
          contentType: render.mimeType,
          headers: { 'Cache-Control': 'public, max-age=86400' },
          hashable: true,
        })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    {
      const metaMatch = pathname.match(/^\/api\/symbols\/(public|private)\/(.+)\.json$/)
      if (metaMatch) {
        const [, scope, encodedName] = metaMatch
        const decodedName = decodeURIComponent(encodedName)
        const row = db.getSfSymbol(scope, decodedName)
        if (!row) return new Response('Not Found', { status: 404 })
        return jsonResponse(row, { hashable: true })
      }
    }

    {
      const symbolMatch = pathname.match(/^\/api\/symbols\/(public|private)\/(.+)\.(svg|png)$/)
      if (symbolMatch) {
        const [, scope, encodedName, format] = symbolMatch
        const decodedName = decodeURIComponent(encodedName)
        const fgParam = url.searchParams.get('fg') ?? url.searchParams.get('color')
        const bgParam = url.searchParams.get('bg')
        const sizeParam = url.searchParams.get('size')
        const weightParam = url.searchParams.get('weight')
        const scaleParam = url.searchParams.get('scale')
        // Fast path: when the request asks for the canonical theme-neutral
        // SVG (no overrides), serve the pre-rendered file from disk. The
        // tile mask URLs in the grid hit this path so the grid never blocks
        // on Swift. Any customisation (fg/bg/size/weight/scale) routes to
        // the live renderer below.
        if (format === 'svg' && !fgParam && !bgParam && !sizeParam && !weightParam && !scaleParam) {
          const cached = getPrerenderedSymbolPath(ctx, scope, decodedName)
          const cachedFile = Bun.file(cached)
          if (await cachedFile.exists()) {
            return await fileResponseRevalidated(request, cachedFile, {
              contentType: 'image/svg+xml; charset=utf-8',
              maxAge: 86400,
            })
          }
        }
        try {
          const render = await renderSfSymbol({
            scope,
            name: decodedName,
            format,
            size: sizeParam ?? undefined,
            color: fgParam ?? undefined,
            background: bgParam ?? undefined,
            weight: weightParam ?? undefined,
            scale: scaleParam ?? undefined,
          }, ctx)
          const file = Bun.file(render.file_path)
          // Live renders are keyed off (renderer, scope, name, format,
          // size, color, background) — same parameters always yield the
          // same on-disk file. The URL captures every dimension, so a
          // bumped renderer produces a new cache row + new file path. We
          // still issue an ETag instead of `immutable` so that a renderer
          // bump on the *server* side flushes browser caches even when
          // the URL hasn't changed (older clients with the same params).
          return await fileResponseRevalidated(request, file, {
            contentType: render.mime_type,
            maxAge: 86400,
          })
        } catch {
          return notFoundResponse(siteConfig)
        }
      }
    }

    // Search page
    if (pathname === '/search' || pathname === '/search/') {
      const html = renderSearchPage(siteConfig)
      return textResponse(html, { contentType: 'text/html; charset=utf-8' })
    }

    if (pathname === '/fonts' || pathname === '/fonts/') {
      const families = db.listAppleFonts()
      const html = renderFontsPage(siteConfig, { families })
      return textResponse(html, { contentType: 'text/html; charset=utf-8' })
    }

    // /symbols and /symbols/<name>: same HTML shell, the client-side
    // symbols-page.js detects the URL and opens the inspector route on
    // load. The mobile experience uses this route shape so back-button
    // restores the grid; on desktop, history.replaceState keeps the
    // URL canonical while inspector state is in-page.
    if (pathname === '/symbols' || pathname === '/symbols/' || pathname.startsWith('/symbols/')) {
      const totals = db.db.query(
        "SELECT scope, COUNT(*) as count FROM sf_symbols GROUP BY scope",
      ).all()
      const html = renderSymbolsPage(siteConfig, { totals })
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
      const html = renderIndexPage(roots, siteConfig, { extras: buildHomepageExtras(siteConfig) })
      return textResponse(html, { contentType: 'text/html; charset=utf-8' })
    }

    // Static assets from src/web/assets/
    if (pathname.startsWith('/assets/')) {
      const file = pathname.replace('/assets/', '')
      if (file.includes('..') || file.includes('\0')) return new Response('Forbidden', { status: 403 })

      // Synthesise the named bundles (`core.js`, `listing.js`) on the fly
      // when requested directly. The built dist serves them statically;
      // this branch keeps standalone `apple-docs web serve` working without
      // a prior build, and also rescues any case where Caddy falls through
      // to Bun for /assets/* (e.g. an old asset URL no longer on disk).
      if (Object.prototype.hasOwnProperty.call(ASSET_BUNDLES, file)) {
        const parts = []
        for (const member of ASSET_BUNDLES[file]) {
          const memberPath = join(srcWebDir, 'assets', member)
          const memberFile = Bun.file(memberPath)
          if (await memberFile.exists()) {
            parts.push(await memberFile.text())
          }
        }
        if (parts.length === 0) return new Response('Not Found', { status: 404 })
        return new Response(parts.join('\n'), {
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            ...assetCacheHeaders,
          },
        })
      }

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
      if (!key) return notFoundResponse(siteConfig)

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
          try { await readerPool?.recycle?.() } catch {}
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
            try { await readerPool?.recycle?.() } catch {}
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

      return notFoundResponse(siteConfig)
    }

    return notFoundResponse(siteConfig)
  }

  const server = Bun.serve({
    port,
    async fetch(request) {
      const response = await handleRequest(request)
      for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v)
      return finalizeResponse(request, response, { gzipCache })
    },
  })

  const serverUrl = `http://localhost:${server.port}`
  if (logger) logger.info(`Dev server running at ${serverUrl}`)

  const originalStop = server.stop?.bind(server)
  if (originalStop) {
    server.stop = (...args) => {
      const out = originalStop(...args)
      void readerPool?.close?.()
      return out
    }
  }

  async function close() {
    try { originalStop?.(true) } catch {}
    try { await readerPool?.close?.() } catch {}
  }

  return { server, url: serverUrl, close, readerPool }
}

function searchResponseCacheKey(searchOpts, stamp) {
  return createHash('sha256').update(`${stableJson(searchOpts)}\0${stamp}`).digest('hex')
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

export function buildHomepageExtras(siteConfig) {
  const baseUrl = siteConfig.baseUrl ?? ''
  return {
    design: [
      {
        slug: 'fonts',
        display_name: 'Apple Fonts',
        kind: 'design',
        href: `${baseUrl}/fonts`,
      },
      {
        slug: 'symbols',
        display_name: 'SF Symbols',
        kind: 'design',
        href: `${baseUrl}/symbols`,
      },
    ],
  }
}
