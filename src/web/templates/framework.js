import {
  buildFooter,
  buildHead,
  buildHeader,
  buildOriginalResourceBlock,
  buildScripts,
  escapeAttr,
  frameworkOriginalUrl,
  renderTocHtml,
} from '../templates.js'
import { slugify } from '../../content/render-html.js'

export function buildFrameworkTreeData(framework, documents, treeEdges, siteConfig) {
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

  const roleSections = []
  for (const [role, docs] of byRole) {
    const docsHtml = docs.map(doc => {
      const docKey = doc.key ?? doc.path ?? ''
      const href = `${siteConfig.baseUrl}/docs/${escapeAttr(docKey)}/`
      const title = escapeAttr(doc.title ?? docKey)
      const filterKind = escapeAttr(doc.role_heading ?? doc.role ?? 'Other')
      // Show role_heading as metadata to distinguish duplicates (e.g. .!=(_:_:) across types)
      const meta = doc.role_heading ? `<span class="doc-item-meta">${escapeAttr(doc.role_heading)}</span>` : ''
      const abstractText = doc.abstract_text ?? doc.abstract ?? ''
      const isDeprecated = /\bDeprecated\b/i.test(abstractText)
      const abstract = abstractText
        ? `<span class="doc-item-meta">— ${escapeAttr(abstractText.length > 80 ? abstractText.slice(0, 80) + '...' : abstractText)}</span>`
        : ''
      const deprecatedAttr = isDeprecated ? ' data-deprecated="true"' : ''
      const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
      const titleHtml = isSymbol ? `<code>${title}</code>` : title
      return `<li data-filter-kind="${filterKind}"${deprecatedAttr}><a href="${href}">${titleHtml}</a>${meta}${abstract}</li>`
    }).join('\n      ')

    const roleId = slugify(role)
    roleSections.push(`<section id="${escapeAttr(roleId)}" class="role-group" data-filter-kind="${escapeAttr(role)}">
    <h2 class="role-heading">${escapeAttr(role)}</h2>
    <ul class="doc-list">
      ${docsHtml}
    </ul>
  </section>`)
  }

  const mainContent = roleSections.length > 0
    ? roleSections.join('\n  ')
    : '<p>No documents found for this framework.</p>'

  // View toggle only shown when we have tree edges
  const hasTree = treeEdges.length > 0

  // When tree view is default, skip rendering the full list HTML server-side.
  // The list is hidden on load and contains thousands of <li> elements that bloat
  // the HTML payload (e.g., Swift stdlib: 10 MB HTML, 138k DOM nodes, 53s FCP).
  // Instead, collection-filters.js will build the list on-demand when the user
  // switches to list view.
  const deferList = hasTree

  const breadcrumbs = `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">${escapeAttr(fwName)}</span></nav>`

  // Build sidebar: original-resource block + TOC of role groups.
  const tocItems = [...byRole.keys()].map(role => ({ id: slugify(role), label: role }))
  const hasSidebar = tocItems.length >= 2
  const sidebarBlocks = []
  const originalBlock = buildOriginalResourceBlock(frameworkOriginalUrl(framework))
  if (originalBlock) sidebarBlocks.push(originalBlock)
  if (hasSidebar) sidebarBlocks.push(`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  const sidebar = sidebarBlocks.length > 0
    ? `<aside class="doc-sidebar">${sidebarBlocks.join('\n')}</aside>`
    : ''
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

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
    ? `<div class="view-toggle" role="group" aria-label="View mode">
    <button data-view="list" aria-pressed="false">List</button>
    <button class="active" data-view="tree" aria-pressed="true">Tree</button>
  </div>`
    : ''

  const description = `${fwName} documentation index.`
  const canonical = framework?.slug ? `${siteConfig.baseUrl || ''}/docs/${framework.slug}/` : null
  const originalUrl = frameworkOriginalUrl(framework)
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
  }

  return `<!DOCTYPE html>
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
  <h1>${escapeAttr(fwName)}${viewToggle}</h1>
  ${mobileToc}
  <article class="doc-article">
  <div id="collection-controls"${deferList ? ' class="hidden"' : ''}></div>
  <div id="list-container"${hasTree ? ' class="hidden"' : ''}${deferList ? ' data-deferred' : ''}>
  ${deferList ? '' : mainContent}
  </div>
  <div id="tree-container"${externalTreeDataUrl ? ` data-tree-src="${escapeAttr(externalTreeDataUrl)}"` : ''}></div>
  ${hasTree && !externalTreeDataUrl ? `<script type="application/json" id="tree-data">${treeDataJsonInline}</script>` : ''}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', 'listing'])}
</body>
</html>`
}
