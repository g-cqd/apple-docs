import { renderSearchPage, renderFontsPage, renderSymbolsPage, renderIndexPage } from '../templates.js'
import { textResponse } from '../responses.js'
import { buildHomepageProps } from '../view-models/homepage.viewmodel.js'
import { buildFontsPageProps } from '../view-models/fonts-page.viewmodel.js'
import { buildSymbolsPageProps } from '../view-models/symbols-page.viewmodel.js'

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
  const props = buildFontsPageProps(ctx)
  return textResponse(renderFontsPage(ctx.siteConfig, props), HTML)
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
  const props = buildSymbolsPageProps(ctx)
  return textResponse(renderSymbolsPage(ctx.siteConfig, props), HTML)
}

/**
 * `/` and `/index.html` — landing page. Lists every framework root with at
 * least one real page (filters out collection pages whose only entry is
 * the root itself).
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function homepageHandler(_request, ctx) {
  const { roots, extras } = buildHomepageProps(ctx)
  const html = renderIndexPage(roots, ctx.siteConfig, { extras })
  return textResponse(html, HTML)
}
