import { renderSearchPage, renderFontsPage, renderSymbolsPage, renderIndexPage } from '../templates.js'
import { textResponse } from '../responses.js'
import { buildHomepageExtras } from '../homepage-extras.js'

const HTML = { contentType: 'text/html; charset=utf-8' }

/**
 * `/search` — search page shell. Pure render: the search-page.js
 * controller fetches `/api/search` and renders results client-side.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function searchPageHandler(_request, ctx) {
  return textResponse(renderSearchPage(ctx.siteConfig), HTML)
}

/**
 * `/fonts` — Apple fonts index page. Reads the family list from the DB.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function fontsPageHandler(_request, ctx) {
  const families = ctx.db.listAppleFonts()
  return textResponse(renderFontsPage(ctx.siteConfig, { families }), HTML)
}

/**
 * `/symbols`, `/symbols/`, `/symbols/<name>` — same HTML shell. The
 * client-side symbols-page.js detects the URL and opens the inspector
 * route on load. The mobile experience uses this URL shape so back-button
 * restores the grid; on desktop, history.replaceState keeps the URL
 * canonical while inspector state is in-page.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function symbolsPageHandler(_request, ctx, url) {
  if (url.pathname !== '/symbols' && url.pathname !== '/symbols/' && !url.pathname.startsWith('/symbols/')) {
    return null
  }
  const totals = ctx.db.db.query(
    "SELECT scope, COUNT(*) as count FROM sf_symbols GROUP BY scope",
  ).all()
  return textResponse(renderSymbolsPage(ctx.siteConfig, { totals }), HTML)
}

/**
 * `/` and `/index.html` — landing page. Lists every framework root with at
 * least one real page (filters out collection pages whose only entry is
 * the root itself).
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function homepageHandler(_request, ctx) {
  const { db, siteConfig } = ctx
  const roots = db.getRoots().filter(r => {
    if (r.page_count <= 1) {
      const pages = db.getPagesByRoot(r.slug)
      if (pages.length <= 1 && (!pages[0] || pages[0].path === r.slug)) return false
    }
    return true
  })
  const html = renderIndexPage(roots, siteConfig, { extras: buildHomepageExtras(siteConfig) })
  return textResponse(html, HTML)
}
