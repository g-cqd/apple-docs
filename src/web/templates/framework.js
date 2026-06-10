import { html, raw, attr } from '../lib/html.js'
import {
  buildBreadcrumbListJsonLd,
  buildFooter,
  buildHead,
  buildHeader,
  buildOriginalResourceBlock,
  buildScripts,
  frameworkOriginalUrl,
  renderTocHtml,
} from '../templates.js'
import { slugify } from '../../content/render-html.js'
import { buildScopeGroups } from './framework-groups.js'

export function buildFrameworkTreeData(_framework, documents, treeEdges, siteConfig) {
  if (!treeEdges || treeEdges.length === 0) return { json: '', hasTree: false }

  const docList = documents ?? []
  const docLookup = {}
  for (const doc of docList) {
    const docKey = doc.key ?? doc.path ?? ''
    docLookup[docKey] = {
      title: doc.title ?? docKey,
      role_heading: doc.role_heading ?? doc.role ?? 'Other',
      href: `${siteConfig.baseUrl ?? ''}/docs/${docKey}/`,
    }
  }

  // Same role grouping the inline path emits when deferList is on (which is
  // always true when hasTree is true).
  const ROLE_LABELS = {
    symbol: 'Symbols', collection: 'Collections', collectionGroup: 'Collection Groups',
    sampleCode: 'Sample Code', article: 'Articles', dictionarySymbol: 'Dictionary Symbols',
    overview: 'Overview', pseudoSymbol: 'Pseudo Symbols',
    restRequestSymbol: 'REST Requests', link: 'Links',
  }
  const byRole = new Map()
  for (const doc of docList) {
    const rawRole = doc.role ?? doc.role_heading ?? 'Other'
    const role = ROLE_LABELS[rawRole] ?? rawRole
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push(doc)
  }
  const roleGroups = []
  for (const [role, roleDocs] of byRole) {
    roleGroups.push({
      role,
      id: slugify(role),
      docs: roleDocs.map(doc => {
        const docKey = doc.key ?? doc.path ?? ''
        const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
        return {
          key: docKey,
          title: doc.title ?? docKey,
          role_heading: doc.role_heading ?? doc.role ?? 'Other',
          abstract: doc.abstract_text ?? doc.abstract ?? '',
          deprecated: /\bDeprecated\b/i.test(doc.abstract_text ?? doc.abstract ?? ''),
          symbol: isSymbol,
        }
      }),
    })
  }

  return {
    json: JSON.stringify({ edges: treeEdges, docs: docLookup, roleGroups }),
    hasTree: true,
  }
}

/**
 * Render a framework listing page with documents grouped by role.
 *
 * @param {object} framework - Framework record (name, slug, kind)
 * @param {Array}  documents - Document records (title, key, role, role_heading)
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @param {object} [opts] - { treeEdges?: Array<{from_key: string, to_key: string}> }
 * @returns {string} Complete HTML page string
 */
export function renderFrameworkPage(framework, documents, siteConfig, opts = {}) {
  const fwName = framework?.display_name ?? framework?.name ?? framework?.slug ?? 'Framework'
  const pageTitle = `${fwName} — ${siteConfig.siteName}`
  const docList = documents ?? []
  const treeEdges = opts.treeEdges ?? []

  // Human-readable labels for DocC roles
  const ROLE_LABELS = {
    symbol: 'Symbols',
    collection: 'Collections',
    collectionGroup: 'Collection Groups',
    sampleCode: 'Sample Code',
    article: 'Articles',
    dictionarySymbol: 'Dictionary Symbols',
    overview: 'Overview',
    pseudoSymbol: 'Pseudo Symbols',
    restRequestSymbol: 'REST Requests',
    link: 'Links',
  }

  // Group documents by role
  const byRole = new Map()
  for (const doc of docList) {
    const rawRole = doc.role ?? doc.role_heading ?? 'Other'
    const role = ROLE_LABELS[rawRole] ?? rawRole
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push(doc)
  }

  // Non-framework scopes (WWDC, Swift Evolution, sample code) get
  // scope-specific sections instead of the role buckets.
  const scope = buildScopeGroups(framework, docList)
  const listSections = scope
    ? scope.sections
    : [...byRole.entries()].map(([role, docs]) => ({ id: slugify(role), label: role, count: null, docs }))

  const roleSections = []
  for (const { id, label, count, docs } of listSections) {
    const docItems = docs.map(doc => renderDocItem(doc, siteConfig))
    const heading = count != null
      ? html`${label} <span class="group-count">(${count})</span>`
      : html`${label}`
    roleSections.push(html`<section id="${id}" class="role-group" data-filter-kind="${label}">
    <h2 class="role-heading">${heading}</h2>
    <ul class="doc-list">
      ${interleave(docItems, html`\n      `)}
    </ul>
  </section>`)
  }

  const jumpNav = scope?.nav?.length
    ? html`<nav class="scope-jump-nav" aria-label="Jump to section">
    ${interleave(scope.nav.map(n => html`<a href="${n.href}">${n.label} <span class="group-count">(${n.count})</span></a>`), html`\n    `)}
  </nav>
  `
    : null

  const mainContent = roleSections.length > 0
    ? html`${jumpNav}${interleave(roleSections, html`\n  `)}`
    : html`<p>No documents found for this framework.</p>`

  // View toggle only shown when we have tree edges
  const hasTree = treeEdges.length > 0

  // When tree view is default, skip rendering the full list HTML server-side.
  // The list is hidden on load and contains thousands of <li> elements that bloat
  // the HTML payload (e.g., Swift stdlib: 10 MB HTML, 138k DOM nodes, 53s FCP).
  // Instead, collection-filters.js will build the list on-demand when the user
  // switches to list view.
  const deferList = hasTree

  const breadcrumbs = html`<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">${fwName}</span></nav>`

  // Build sidebar: original-resource block + TOC of list sections.
  const tocItems = listSections.map(section => ({ id: section.id, label: section.label }))
  const hasSidebar = tocItems.length >= 2
  const sidebarBlocks = []
  const originalBlock = buildOriginalResourceBlock(frameworkOriginalUrl(framework))
  if (originalBlock.toString()) sidebarBlocks.push(originalBlock)
  if (hasSidebar) sidebarBlocks.push(html`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  const sidebar = sidebarBlocks.length > 0
    ? html`<aside class="doc-sidebar">${interleave(sidebarBlocks, html`\n`)}</aside>`
    : null
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : null

  // Build the doc lookup JSON for tree view (key -> {title, role_heading, href})
  const docLookup = {}
  for (const doc of docList) {
    const docKey = doc.key ?? doc.path ?? ''
    docLookup[docKey] = {
      title: doc.title ?? docKey,
      role_heading: doc.role_heading ?? doc.role ?? 'Other',
      href: `${siteConfig.baseUrl}/docs/${docKey}/`,
    }
  }

  // Build role grouping for deferred list rendering
  const roleGroups = []
  if (deferList) {
    for (const [role, roleDocs] of byRole) {
      roleGroups.push({
        role,
        id: slugify(role),
        docs: roleDocs.map(doc => {
          const docKey = doc.key ?? doc.path ?? ''
          const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
          return {
            key: docKey,
            title: doc.title ?? docKey,
            role_heading: doc.role_heading ?? doc.role ?? 'Other',
            abstract: doc.abstract_text ?? doc.abstract ?? '',
            deprecated: /\bDeprecated\b/i.test(doc.abstract_text ?? doc.abstract ?? ''),
            symbol: isSymbol,
          }
        }),
      })
    }
  }

  // Plain JSON for the tree data. When the caller provides
  // `opts.treeDataUrl`, the framework page emits an external reference
  // instead of inlining this — see the `<div id="tree-container">` below
  // and `tree-view.js`. Inline emission still escapes HTML-significant
  // characters to prevent `</script>` breakout.
  const treeDataObj = { edges: treeEdges, docs: docLookup, ...(deferList ? { roleGroups } : {}) }
  const treeDataJsonInline = JSON.stringify(treeDataObj)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('/', '\\u002f')
    .replaceAll('&', '\\u0026')
  const externalTreeDataUrl = opts.treeDataUrl ?? null

  const viewToggle = hasTree
    ? html`<div class="view-toggle" role="group" aria-label="View mode">
    <button data-view="list" aria-pressed="false">List</button>
    <button class="active" data-view="tree" aria-pressed="true">Tree</button>
  </div>`
    : null

  const description = `${fwName} documentation index.`
  const canonical = framework?.slug ? `${siteConfig.baseUrl || ''}/docs/${framework.slug}/` : null
  const originalUrl = frameworkOriginalUrl(framework)
  const breadcrumbJsonLd = framework?.slug
    ? buildBreadcrumbListJsonLd(framework.slug, siteConfig.baseUrl, { title: fwName, framework: fwName })
    : null
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'APIReference',
    name: fwName,
    inLanguage: 'en',
    description,
    isAccessibleForFree: true,
    ...(canonical ? { mainEntityOfPage: canonical } : {}),
    ...(siteConfig.buildDate ? { dateModified: siteConfig.buildDate } : {}),
    ...(originalUrl ? { isBasedOn: originalUrl } : {}),
    programmingLanguage: 'Swift',
    ...(breadcrumbJsonLd ? { breadcrumb: breadcrumbJsonLd } : {}),
  }

  return html`<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  alternate: originalUrl,
  ogType: 'website',
  ogTitle: fwName,
  ogDesc: description,
  jsonLd,
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${sidebar ? ' has-sidebar' : ''} listing">
  ${breadcrumbs}
  <h1>${fwName}${viewToggle}</h1>
  ${mobileToc}
  <article class="doc-article">
  <div id="collection-controls"${attr('class', deferList ? 'hidden' : null)}></div>
  <div id="list-container"${attr('class', hasTree ? 'hidden' : null)}${attr('data-deferred', deferList || null)}>
  ${deferList ? null : mainContent}
  </div>
  <div id="tree-container"${externalTreeDataUrl ? attr('data-tree-src', externalTreeDataUrl) : null}></div>
  ${hasTree && !externalTreeDataUrl ? html`<script type="application/json" id="tree-data">${raw(treeDataJsonInline)}</script>` : null}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', 'listing'])}
</body>
</html>`
}

function renderDocItem(doc, siteConfig) {
  const docKey = doc.key ?? doc.path ?? ''
  const href = `${siteConfig.baseUrl}/docs/${docKey}/`
  const filterKind = doc.role_heading ?? doc.role ?? 'Other'
  // Show role_heading (or the scope-specific meta line, e.g. SE number)
  // as metadata to distinguish duplicates (e.g. .!=(_:_:) across types).
  const metaText = doc.meta ?? doc.role_heading
  const meta = metaText
    ? html`<span class="doc-item-meta">${metaText}</span>`
    : null
  const abstractText = doc.abstract_text ?? doc.abstract ?? ''
  const isDeprecated = /\bDeprecated\b/i.test(abstractText)
  const abstract = abstractText
    ? html`<span class="doc-item-meta">— ${abstractText.length > 80 ? `${abstractText.slice(0, 80)}...` : abstractText}</span>`
    : null
  const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
  const titleContent = isSymbol
    ? html`<code>${doc.title ?? docKey}</code>`
    : (doc.title ?? docKey)
  return html`<li data-filter-kind="${filterKind}"${attr('data-deprecated', isDeprecated || null)}><a href="${href}">${titleContent}</a>${meta}${abstract}</li>`
}

/**
 * Splice an HtmlString separator between every element of `items`.
 */
function interleave(items, separator) {
  const out = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(separator)
    out.push(items[i])
  }
  return out
}
