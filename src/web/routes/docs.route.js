import { renderDocumentPage, renderFrameworkPage, buildFrameworkTreeData } from '../templates.js'
import { sha256 } from '../../lib/hash.js'
import { fetchDocPage } from '../../apple/api.js'
import { persistFetchedDocPage } from '../../pipeline/persist.js'
import { textResponse, notFoundResponse } from '../responses.js'

const HTML_HASHABLE = { contentType: 'text/html; charset=utf-8', hashable: true }

const DOC_BASE_QUERY = `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.source_type, d.url,
       d.platforms_json, d.is_deprecated, d.is_beta,
       COALESCE(r.display_name, d.framework) as framework_display
FROM documents d LEFT JOIN roots r ON r.slug = d.framework WHERE d.key = ?`

const DOC_SECTIONS_QUERY = 'SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id'

/**
 * `/docs/<key>` — either a framework listing (when the key matches a
 * root slug) or a document page. Falls through to an on-demand
 * `fetchDocPage` against Apple's API for keys not yet in the corpus, so
 * lite-tier deployments can render newly-published pages without a sync.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export async function docsHandler(_request, ctx, url) {
  const { db, dataDir, siteConfig, renderCache, rateLimiter, readerPool, frameworkTreeCache, frameworkTreeBySlug, invalidateDocumentCaches } = ctx
  const key = url.pathname.replace('/docs/', '').replace(/\/$/, '').replace(/\/index\.html$/, '')
  if (!key) return notFoundResponse(siteConfig)

  // Try as framework listing first.
  const root = db.getRootBySlug(key)
  if (root) {
    const docs = db.getPagesByRoot(root.slug)
    const isSelfRef = docs.length <= 1 && docs[0]?.path === key
    if (!isSelfRef && docs.length > 0) {
      const treeEdges = db.getFrameworkTree(root.slug)
      // Externalise the tree-view JSON: hash the payload, stash it in the
      // in-memory cache, and pass `treeDataUrl` so the rendered HTML
      // emits a `data-tree-src` reference (~50 KB) instead of an ~5 MB
      // inline `<script type="application/json">`. The JSON is served by
      // /data/frameworks/<slug>/tree.<hash>.json with `Cache-Control:
      // immutable`, so Cloudflare caches both HTML and JSON for a year
      // (the hash invalidates on rebuild).
      const tree = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
      let treeDataUrl = null
      if (tree.hasTree) {
        const hash = sha256(tree.json).slice(0, 10)
        frameworkTreeCache.set(`${root.slug}:${hash}`, tree.json)
        // Also stash the latest hash per slug so the URL we emit in HTML
        // always matches whatever the route can satisfy.
        frameworkTreeBySlug.set(root.slug, hash)
        treeDataUrl = `${siteConfig.baseUrl || ''}/data/frameworks/${root.slug}/tree.${hash}.json`
      }
      const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges, treeDataUrl })
      return textResponse(html, HTML_HASHABLE)
    }
  }

  // Try as document page.
  let doc = db.db.query(DOC_BASE_QUERY).get(key)

  // On-demand fetch from Apple if not in database.
  if (!doc && /^[a-z][a-z0-9_-]*(?:\/[a-z0-9_-]+)*$/i.test(key)) {
    try {
      const { json, etag, lastModified } = await fetchDocPage(key, rateLimiter)
      const framework = key.split('/')[0]
      const rootRow = db.getRootBySlug(framework)
      await persistFetchedDocPage({
        db, dataDir,
        rootId: rootRow?.id ?? null,
        path: key,
        sourceType: 'apple-docc',
        json, etag, lastModified,
      })
      doc = db.db.query(DOC_BASE_QUERY).get(key)
      invalidateDocumentCaches()
      try { await readerPool?.recycle?.() } catch {}
    } catch {
      // fetch failed — fall through to 404
    }
  }

  if (doc) {
    let sections = db.hasTable('document_sections')
      ? db.db.query(DOC_SECTIONS_QUERY).all(doc.id)
      : []

    // On-demand fetch sections for lite snapshots (doc exists but sections are missing).
    if (sections.length === 0 && doc.source_type === 'apple-docc') {
      try {
        db.ensureSectionsTable()
        const { json, etag, lastModified } = await fetchDocPage(doc.key, rateLimiter)
        const framework = doc.key.split('/')[0]
        const rootRow = db.getRootBySlug(framework)
        await persistFetchedDocPage({
          db, dataDir,
          rootId: rootRow?.id ?? null,
          path: doc.key,
          sourceType: 'apple-docc',
          json, etag, lastModified,
        })
        sections = db.db.query(DOC_SECTIONS_QUERY).all(doc.id)
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
    return textResponse(html, HTML_HASHABLE)
  }

  return notFoundResponse(siteConfig)
}
