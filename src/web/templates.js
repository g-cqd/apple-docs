import { renderHtml } from '../content/render-html.js'

// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------

/**
 * Render the advanced search page with filter form and results container.
 *
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderSearchPage(siteConfig) {
  const pageTitle = `Search — ${siteConfig.siteName}`

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({ title: pageTitle, description: 'Search Apple developer documentation with filters.', siteConfig })}
<body>
${buildHeader(siteConfig)}
<main class="main-content search-page">
  <h1>Search Documentation</h1>

  <form class="search-filters" id="search-form" role="search">
    <div class="filter-row filter-row-query">
      <label class="filter-label" for="search-q">Query</label>
      <input class="filter-input" id="search-q" name="q" type="search" placeholder="Symbol, API, or keyword…" autocomplete="off">
    </div>

    <div class="filter-row filter-row-selects">
      <div class="filter-group">
        <label class="filter-label" for="filter-framework">Framework</label>
        <select class="filter-select" id="filter-framework" name="framework">
          <option value="">All</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label" for="filter-source">Source</label>
        <select class="filter-select" id="filter-source" name="source">
          <option value="">All</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label" for="filter-kind">Kind</label>
        <select class="filter-select" id="filter-kind" name="kind">
          <option value="">All</option>
        </select>
      </div>
    </div>

    <div class="filter-row filter-row-toggles">
      <fieldset class="filter-group">
        <legend class="filter-label">Language</legend>
        <div class="filter-chips">
          <label><input type="radio" name="language" value="" checked> All</label>
          <label><input type="radio" name="language" value="swift"> Swift</label>
          <label><input type="radio" name="language" value="objc"> ObjC</label>
        </div>
      </fieldset>
      <fieldset class="filter-group">
        <legend class="filter-label">Platform</legend>
        <div class="filter-chips">
          <label><input type="checkbox" name="platform" value="ios"> iOS</label>
          <label><input type="checkbox" name="platform" value="macos"> macOS</label>
          <label><input type="checkbox" name="platform" value="watchos"> watchOS</label>
          <label><input type="checkbox" name="platform" value="tvos"> tvOS</label>
          <label><input type="checkbox" name="platform" value="visionos"> visionOS</label>
        </div>
      </fieldset>
    </div>

    <details class="filter-advanced">
      <summary>Advanced filters</summary>
      <div class="filter-row filter-row-versions">
        <div class="filter-group">
          <label class="filter-label" for="filter-min-ios">Min iOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-ios" name="min_ios" type="text" placeholder="e.g. 17.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-macos">Min macOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-macos" name="min_macos" type="text" placeholder="e.g. 14.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-watchos">Min watchOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-watchos" name="min_watchos" type="text" placeholder="e.g. 10.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-tvos">Min tvOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-tvos" name="min_tvos" type="text" placeholder="e.g. 17.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-visionos">Min visionOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-visionos" name="min_visionos" type="text" placeholder="e.g. 1.0">
        </div>
      </div>
      <div class="filter-row">
        <div class="filter-group">
          <label class="filter-label" for="filter-year">WWDC Year</label>
          <input class="filter-input filter-input-sm" id="filter-year" name="year" type="number" placeholder="e.g. 2024">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-track">WWDC Track</label>
          <input class="filter-input filter-input-sm" id="filter-track" name="track" type="text" placeholder="e.g. SwiftUI">
        </div>
      </div>
      <div class="filter-row">
        <label class="filter-checkbox"><input type="checkbox" name="no_fuzzy" value="1"> Disable fuzzy matching</label>
        <label class="filter-checkbox"><input type="checkbox" name="no_deep" value="1"> Disable deep (body) search</label>
      </div>
    </details>

    <div class="filter-row filter-row-actions">
      <button type="submit" class="filter-button">Search</button>
    </div>
  </form>

  <div id="search-status" class="search-status" hidden></div>
  <div id="search-results" class="search-results"></div>
  <button id="search-load-more" class="load-more" hidden>Load more results</button>
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/search-page.js`)}" defer></script>
</body>
</html>`
}

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
