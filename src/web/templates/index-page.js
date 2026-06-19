import { slugify } from '../../content/render-html.js'
import { html } from '../lib/html.js'
import { buildFooter, buildHead, buildHeader, buildScripts, renderTocHtml } from '../templates.js'

export function renderIndexPage(/** @type {any} */ frameworks, /** @type {any} */ siteConfig, /** @type {any} */ opts = {}) {
  const pageTitle = siteConfig.siteName
  const frameworkList = frameworks ?? []

  // Group frameworks by kind, preserving insertion order
  const byKind = new Map()
  for (const fw of frameworkList) {
    const kind = fw.kind ?? 'other'
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(fw)
  }

  // Extras hook — synthetic entries (e.g. /fonts, /symbols inside Design)
  // that aren't real corpus roots. They render as normal list items with
  // a custom href.
  const extrasByKind = opts.extras ?? {}
  for (const [kind, extras] of Object.entries(extrasByKind)) {
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(...extras)
  }

  const sections = []
  for (const [kind, items] of byKind) {
    const listItems = items.map((/** @type {any} */ fw) => {
      const href = fw.href ?? `${siteConfig.baseUrl}/docs/${fw.slug}/`
      const countBadge = fw.doc_count != null ? html` <span class="badge badge-count">${String(fw.doc_count)}</span>` : null
      return html`<li data-filter-kind="${kind}"><a href="${href}">${fw.display_name ?? fw.name ?? fw.slug}</a>${countBadge}</li>`
    })

    const kindId = slugify(kind)
    sections.push(html`<section id="${kindId}" class="framework-group" data-filter-kind="${kind}">
    <h2 class="framework-kind">${kind}</h2>
    <ul class="framework-list">
      ${interleave(listItems, html`\n      `)}
    </ul>
  </section>`)
  }

  const mainContent = sections.length > 0 ? interleave(sections, html`\n  `) : html`<p>No frameworks indexed yet.</p>`

  // Build sidebar TOC from kind groups
  const tocItems = [...byKind.keys()].map((kind) => ({ id: slugify(kind), label: kind }))
  const hasSidebar = tocItems.length >= 2
  const sidebar = hasSidebar ? html`<aside class="doc-sidebar"><div class="sidebar-block">${renderTocHtml(tocItems, false)}</div></aside>` : null
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : null

  const description = 'Apple developer documentation, indexed locally.'
  const canonical = `${siteConfig.baseUrl || ''}/`

  return html`<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  ogType: 'website',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.siteName,
    url: canonical,
    description,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteConfig.baseUrl || ''}/search?q={query}`,
      'query-input': 'required name=query',
    },
  },
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${hasSidebar ? ' has-sidebar' : ''} listing">
  <h1>${siteConfig.siteName}</h1>
  ${mobileToc}
  <article class="doc-article">
  ${mainContent}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', 'listing'])}
</body>
</html>`
}

/**
 * Splice an HtmlString separator between every element of `items`. Used
 * to recreate the `array.join('\n  ')` shape with template-literal
 * whitespace preserved for byte-level snapshot stability.
 */
function interleave(/** @type {any} */ items, /** @type {any} */ separator) {
  const out = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(separator)
    out.push(items[i])
  }
  return out
}

/**
 * Compute the framework tree-view JSON ahead of rendering. Build.js uses this
 * to write a hashed, externally-cacheable `tree.<hash>.json` file and pass
 * back the URL via `opts.treeDataUrl` to `renderFrameworkPage`. Keeping this
 * exported lets us assert framework-page weight in tests without re-running
 * the entire page render.
 *
 * @param {any} framework
 * @param {Array<any>}  documents
 * @param {Array<{from_key: string, to_key: string}>} treeEdges
 * @param {any} siteConfig
 * @returns {{ json: string, hasTree: boolean }} `json` is empty when the
 *   framework has no tree edges (and so no tree-view).
 */
