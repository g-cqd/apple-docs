import {
  buildFooter,
  buildHead,
  buildHeader,
  buildScripts,
  escapeAttr,
  renderTocHtml,
} from '../templates.js'
import { slugify } from '../../content/render-html.js'

export function renderIndexPage(frameworks, siteConfig, opts = {}) {
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
    const itemsHtml = items.map(fw => {
      const href = fw.href ?? `${siteConfig.baseUrl}/docs/${escapeAttr(fw.slug)}/`
      const countBadge = fw.doc_count != null
        ? ` <span class="badge badge-count">${escapeAttr(String(fw.doc_count))}</span>`
        : ''
      return `<li data-filter-kind="${escapeAttr(kind)}"><a href="${href}">${escapeAttr(fw.display_name ?? fw.name ?? fw.slug)}</a>${countBadge}</li>`
    }).join('\n      ')

    const kindId = slugify(kind)
    sections.push(`<section id="${escapeAttr(kindId)}" class="framework-group" data-filter-kind="${escapeAttr(kind)}">
    <h2 class="framework-kind">${escapeAttr(kind)}</h2>
    <ul class="framework-list">
      ${itemsHtml}
    </ul>
  </section>`)
  }

  const mainContent = sections.length > 0
    ? sections.join('\n  ')
    : '<p>No frameworks indexed yet.</p>'

  // Build sidebar TOC from kind groups
  const tocItems = [...byKind.keys()].map(kind => ({ id: slugify(kind), label: kind }))
  const hasSidebar = tocItems.length >= 2
  const sidebar = hasSidebar
    ? `<aside class="doc-sidebar"><div class="sidebar-block">${renderTocHtml(tocItems, false)}</div></aside>`
    : ''
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  const description = 'Apple developer documentation, indexed locally.'
  const canonical = `${siteConfig.baseUrl || ''}/`

  return `<!DOCTYPE html>
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
  <h1>${escapeAttr(siteConfig.siteName)}</h1>
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
 * Compute the framework tree-view JSON ahead of rendering. Build.js uses this
 * to write a hashed, externally-cacheable `tree.<hash>.json` file and pass
 * back the URL via `opts.treeDataUrl` to `renderFrameworkPage`. Keeping this
 * exported lets us assert framework-page weight in tests without re-running
 * the entire page render.
 *
 * @param {object} framework
 * @param {Array}  documents
 * @param {Array<{from_key: string, to_key: string}>} treeEdges
 * @param {object} siteConfig
 * @returns {{ json: string, hasTree: boolean }} `json` is empty when the
 *   framework has no tree edges (and so no tree-view).
 */
