import { renderHtml } from '../content/render-html.js'

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape a value for use inside HTML attribute values or text content. */
function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// ---------------------------------------------------------------------------
// Shared page-level fragments
// ---------------------------------------------------------------------------

function buildHead({ title, description, siteConfig }) {
  const escapedTitle = escapeAttr(title)
  const escapedDesc = escapeAttr(description ?? '')
  const cssHref = `${siteConfig.baseUrl}/assets/style.css`
  const themeHref = `${siteConfig.baseUrl}/assets/theme.js`
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  ${escapedDesc ? `<meta name="description" content="${escapedDesc}">` : ''}
  <link rel="stylesheet" href="${escapeAttr(cssHref)}">
  <script src="${escapeAttr(themeHref)}" defer></script>
</head>`
}

function buildHeader(siteConfig) {
  const homeHref = `${siteConfig.baseUrl}/`
  return `<header class="site-header">
  <nav class="site-nav">
    <a class="site-name" href="${escapeAttr(homeHref)}">${escapeAttr(siteConfig.siteName)}</a>
    <div class="search-container">
      <input class="search-input" type="search" placeholder="Search…" aria-label="Search documentation" autocomplete="off">
      <div class="search-dropdown" hidden aria-live="polite"></div>
    </div>
    <button class="theme-toggle" aria-label="Toggle theme" type="button">&#9680;</button>
  </nav>
</header>`
}

function buildFooter(siteConfig) {
  const buildDate = escapeAttr(siteConfig.buildDate ?? new Date().toISOString().slice(0, 10))
  return `<footer class="site-footer">
  <p>Built on ${buildDate}</p>
</footer>`
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Build a breadcrumb nav HTML string from a slash-separated doc key.
 *
 * Example: `documentation/swiftui/view` produces:
 *   <a href="/docs/documentation/">documentation</a> /
 *   <a href="/docs/documentation/swiftui/">swiftui</a> /
 *   view
 *
 * The last segment is rendered as plain text (current page).
 * A single-segment key produces plain text with no link.
 */
export function buildBreadcrumbs(key) {
  if (!key || typeof key !== 'string') return ''
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return ''
  if (segments.length === 1) {
    return `<nav class="breadcrumbs" aria-label="Breadcrumb"><span>${escapeAttr(segments[0])}</span></nav>`
  }

  const parts = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const isLast = i === segments.length - 1
    if (isLast) {
      parts.push(`<span aria-current="page">${escapeAttr(segment)}</span>`)
    } else {
      const href = `/docs/${segments.slice(0, i + 1).join('/')}/`
      parts.push(`<a href="${escapeAttr(href)}">${escapeAttr(segment)}</a>`)
    }
  }

  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${parts.join(' / ')}</nav>`
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function buildDocMeta(doc) {
  const badges = []
  if (doc.framework) {
    badges.push(`<span class="badge badge-framework">${escapeAttr(doc.framework)}</span>`)
  }
  if (doc.role_heading) {
    badges.push(`<span class="badge badge-role">${escapeAttr(doc.role_heading)}</span>`)
  }
  if (doc.source_type) {
    badges.push(`<span class="badge badge-source">${escapeAttr(doc.source_type)}</span>`)
  }
  if (badges.length === 0) return ''
  return `<div class="doc-meta">${badges.join('')}</div>`
}

// ---------------------------------------------------------------------------
// Relationship sidebar
// ---------------------------------------------------------------------------

function buildRelationshipSidebar(section) {
  const contentJson = section?.content_json ?? section?.contentJson ?? null
  let groups = null
  if (contentJson && typeof contentJson === 'string') {
    try { groups = JSON.parse(contentJson) } catch { /* ignore */ }
  } else if (contentJson && typeof contentJson === 'object') {
    groups = contentJson
  }

  const parts = ['<aside class="doc-sidebar">', '<h2>Relationships</h2>']

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        parts.push(`<h3 class="sidebar-group-title">${escapeAttr(group.title)}</h3>`)
      }
      const items = (group?.items ?? [])
        .map(item => {
          if (item?.key) {
            return `<li><a href="/docs/${escapeAttr(item.key)}/">${escapeAttr(item.title ?? item.key)}</a></li>`
          }
          return `<li>${escapeAttr(item?.title ?? item?.identifier ?? '')}</li>`
        })
        .join('')
      if (items) {
        parts.push(`<ul class="sidebar-list">${items}</ul>`)
      }
    }
  } else {
    parts.push('<p class="sidebar-hint">See relationships section in the article.</p>')
  }

  parts.push('</aside>')
  return parts.join('\n  ')
}

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------

/**
 * Render a complete HTML5 page for a single documentation document.
 *
 * @param {object} doc - Document record (title, key, framework, role_heading, source_type, abstract_text)
 * @param {Array}  sections - Section records passed to renderHtml()
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderDocumentPage(doc, sections, siteConfig) {
  const pageTitle = `${doc.title ?? 'Untitled'} — ${siteConfig.siteName}`
  const content = renderHtml(doc, sections)
  const breadcrumbs = doc.key ? buildBreadcrumbs(doc.key) : ''

  // Collect relationships from sections for sidebar
  const relationshipSection = (sections ?? []).find(s =>
    s.sectionKind === 'relationships' || s.section_kind === 'relationships'
  )
  const hasSidebar = Boolean(relationshipSection)

  const sidebar = hasSidebar
    ? buildRelationshipSidebar(relationshipSection)
    : ''

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({ title: pageTitle, description: doc.abstract_text, siteConfig })}
<body>
${buildHeader(siteConfig)}
<main class="main-content${hasSidebar ? ' has-sidebar' : ''}">
  ${breadcrumbs}
  ${buildDocMeta(doc)}
  <article class="doc-article">
    ${content}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/search.js`)}" defer></script>
</body>
</html>`
}

/**
 * Render the index/landing page listing all frameworks grouped by kind.
 *
 * @param {Array}  frameworks - Framework records (slug, name, kind, doc_count)
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderIndexPage(frameworks, siteConfig) {
  const pageTitle = siteConfig.siteName
  const frameworkList = frameworks ?? []

  // Group frameworks by kind, preserving insertion order
  const byKind = new Map()
  for (const fw of frameworkList) {
    const kind = fw.kind ?? 'other'
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(fw)
  }

  const sections = []
  for (const [kind, items] of byKind) {
    const itemsHtml = items.map(fw => {
      const href = `${siteConfig.baseUrl}/docs/${escapeAttr(fw.slug)}/`
      const countBadge = fw.doc_count != null
        ? ` <span class="badge badge-count">${escapeAttr(String(fw.doc_count))}</span>`
        : ''
      return `<li><a href="${href}">${escapeAttr(fw.display_name ?? fw.name ?? fw.slug)}</a>${countBadge}</li>`
    }).join('\n      ')

    sections.push(`<section class="framework-group">
    <h2 class="framework-kind">${escapeAttr(kind)}</h2>
    <ul class="framework-list">
      ${itemsHtml}
    </ul>
  </section>`)
  }

  const mainContent = sections.length > 0
    ? sections.join('\n  ')
    : '<p>No frameworks indexed yet.</p>'

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({ title: pageTitle, description: 'Apple developer documentation, indexed locally.', siteConfig })}
<body>
${buildHeader(siteConfig)}
<main class="main-content listing">
  <h1>${escapeAttr(siteConfig.siteName)}</h1>
  ${mainContent}
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/search.js`)}" defer></script>
</body>
</html>`
}

/**
 * Render a framework listing page with documents grouped by role.
 *
 * @param {object} framework - Framework record (name, slug, kind)
 * @param {Array}  documents - Document records (title, key, role, role_heading)
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderFrameworkPage(framework, documents, siteConfig) {
  const fwName = framework?.display_name ?? framework?.name ?? framework?.slug ?? 'Framework'
  const pageTitle = `${fwName} — ${siteConfig.siteName}`
  const docList = documents ?? []

  // Group documents by role
  const byRole = new Map()
  for (const doc of docList) {
    const role = doc.role ?? doc.role_heading ?? 'Other'
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push(doc)
  }

  const roleSections = []
  for (const [role, docs] of byRole) {
    const docsHtml = docs.map(doc => {
      const docKey = doc.key ?? doc.path ?? ''
      const href = `${siteConfig.baseUrl}/docs/${escapeAttr(docKey)}/`
      const title = escapeAttr(doc.title ?? docKey)
      // Show role_heading as metadata to distinguish duplicates (e.g. .!=(_:_:) across types)
      const meta = doc.role_heading ? `<span class="doc-item-meta">${escapeAttr(doc.role_heading)}</span>` : ''
      const abstractText = doc.abstract_text ?? doc.abstract ?? ''
      const abstract = abstractText
        ? `<span class="doc-item-meta">— ${escapeAttr(abstractText.length > 80 ? abstractText.slice(0, 80) + '...' : abstractText)}</span>`
        : ''
      return `<li><a href="${href}">${title}</a>${meta}${abstract}</li>`
    }).join('\n      ')

    roleSections.push(`<section class="role-group">
    <h2 class="role-heading">${escapeAttr(role)}</h2>
    <ul class="doc-list">
      ${docsHtml}
    </ul>
  </section>`)
  }

  const mainContent = roleSections.length > 0
    ? roleSections.join('\n  ')
    : '<p>No documents found for this framework.</p>'

  const breadcrumbs = `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">${escapeAttr(fwName)}</span></nav>`

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({ title: pageTitle, description: `${fwName} documentation index.`, siteConfig })}
<body>
${buildHeader(siteConfig)}
<main class="main-content listing">
  ${breadcrumbs}
  <h1>${escapeAttr(fwName)}</h1>
  ${mainContent}
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/search.js`)}" defer></script>
</body>
</html>`
}
