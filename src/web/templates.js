import { renderHtml, slugify } from '../content/render-html.js'

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
    <fieldset class="theme-switcher" role="radiogroup" aria-label="Color scheme">
      <button class="theme-option" type="button" data-theme-value="light" aria-label="Light theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg></button>
      <button class="theme-option" type="button" data-theme-value="auto" aria-label="System theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" fill="currentColor"/><path d="M8 2.5A5.5 5.5 0 0 1 8 13.5" fill="currentColor"/></svg></button>
      <button class="theme-option" type="button" data-theme-value="dark" aria-label="Dark theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3 4.5 4.5 0 0 0 13 9.5z"/></svg></button>
    </fieldset>
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

/** Returns the inner HTML content of the relationships sidebar (without the wrapping <aside>). */
function buildRelationshipContent(section) {
  const contentJson = section?.content_json ?? section?.contentJson ?? null
  let groups = null
  if (contentJson && typeof contentJson === 'string') {
    try { groups = JSON.parse(contentJson) } catch { /* ignore */ }
  } else if (contentJson && typeof contentJson === 'object') {
    groups = contentJson
  }

  const parts = ['<h2>Relationships</h2>']

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

  return parts.join('\n  ')
}

// ---------------------------------------------------------------------------
// Page TOC (Table of Contents)
// ---------------------------------------------------------------------------

/** Build TOC item list from ordered sections. Skips abstract. */
function buildPageToc(sections) {
  const items = []
  for (const section of sections ?? []) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind === 'abstract') continue

    let id, label
    switch (kind) {
      case 'declaration':
        id = 'declaration'; label = 'Declaration'; break
      case 'parameters':
        id = 'parameters'; label = 'Parameters'; break
      case 'discussion':
        label = section.heading ?? 'Overview'
        id = slugify(label)
        break
      case 'topics':
        id = 'topics'; label = 'Topics'; break
      case 'relationships':
        id = 'relationships'; label = 'Relationships'; break
      case 'see_also':
        id = 'see-also'; label = 'See Also'; break
      default:
        label = section.heading ?? 'Section'
        id = slugify(label)
    }
    if (id) items.push({ id, label })
  }
  return items
}

/** Render the TOC HTML. In mobile mode, wraps in a <details> element. */
function renderTocHtml(tocItems, mobile = false) {
  if (tocItems.length < 2) return ''
  const listHtml = `<ul>${tocItems.map(item =>
    `<li><a href="#${escapeAttr(item.id)}">${escapeAttr(item.label)}</a></li>`
  ).join('')}</ul>`

  if (mobile) {
    return `<details class="page-toc-mobile"><summary>On this page</summary><nav class="page-toc">${listHtml}</nav></details>`
  }
  return `<nav class="page-toc"><h3>On this page</h3>${listHtml}</nav>`
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
 * @param {object} [opts] - { resolveRoleHeadings?: (keys: string[]) => Map<string, string> }
 * @returns {string} Complete HTML page string
 */
export function renderDocumentPage(doc, sections, siteConfig, opts = {}) {
  const sectionsList = sections ?? []

  // Enrich topics items with role_heading from DB (if resolver provided)
  if (opts.resolveRoleHeadings) {
    enrichTopicItems(sectionsList, opts.resolveRoleHeadings)
  }

  const pageTitle = `${doc.title ?? 'Untitled'} — ${siteConfig.siteName}`
  const content = renderHtml(doc, sectionsList)
  const breadcrumbs = doc.key ? buildBreadcrumbs(doc.key) : ''

  // Sort sections for TOC (same order as renderHtml uses)
  const orderedSections = sectionsList.slice().sort((a, b) =>
    (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0)
  )
  const tocItems = buildPageToc(orderedSections)

  const relationshipSection = orderedSections.find(s =>
    (s.sectionKind ?? s.section_kind) === 'relationships'
  )

  const hasSidebar = tocItems.length >= 2

  // Compose sidebar: TOC first, then relationships below
  const sidebarParts = []
  if (hasSidebar) {
    sidebarParts.push(renderTocHtml(tocItems, false))
  }
  if (relationshipSection) {
    sidebarParts.push(buildRelationshipContent(relationshipSection))
  }

  const sidebar = sidebarParts.length > 0
    ? `<aside class="doc-sidebar">${sidebarParts.join('\n')}</aside>`
    : ''

  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({ title: pageTitle, description: doc.abstract_text, siteConfig })}
<body>
${buildHeader(siteConfig)}
<main class="main-content${hasSidebar ? ' has-sidebar' : ''}">
  ${breadcrumbs}
  ${buildDocMeta(doc)}
  ${mobileToc}
  <article class="doc-article">
    ${content}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/search.js`)}" defer></script>
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/collection-filters.js`)}" defer></script>
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/page-toc.js`)}" defer></script>
</body>
</html>`
}

/** Batch-enrich topics section items with _resolvedRoleHeading from DB. */
function enrichTopicItems(sections, resolveRoleHeadings) {
  for (const section of sections) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind !== 'topics') continue

    const raw = section.contentJson ?? section.content_json
    let contentJson = null
    if (typeof raw === 'string') {
      try { contentJson = JSON.parse(raw) } catch { continue }
    } else if (typeof raw === 'object') {
      contentJson = raw
    }
    if (!Array.isArray(contentJson)) continue

    // Collect all item keys
    const keys = []
    for (const group of contentJson) {
      for (const item of group?.items ?? []) {
        if (item.key) keys.push(item.key)
      }
    }
    if (keys.length === 0) continue

    // Batch resolve
    const roleMap = resolveRoleHeadings(keys)

    // Enrich items
    for (const group of contentJson) {
      for (const item of group?.items ?? []) {
        if (item.key && roleMap.has(item.key)) {
          item._resolvedRoleHeading = roleMap.get(item.key)
        }
      }
    }

    // Write back serialized
    const serialized = JSON.stringify(contentJson)
    if (section.contentJson !== undefined) {
      section.contentJson = serialized
    } else {
      section.content_json = serialized
    }
  }
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
      return `<li data-filter-kind="${escapeAttr(kind)}"><a href="${href}">${escapeAttr(fw.display_name ?? fw.name ?? fw.slug)}</a>${countBadge}</li>`
    }).join('\n      ')

    sections.push(`<section class="framework-group" data-filter-kind="${escapeAttr(kind)}">
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
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/collection-filters.js`)}" defer></script>
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
      const filterKind = escapeAttr(doc.role_heading ?? doc.role ?? 'Other')
      // Show role_heading as metadata to distinguish duplicates (e.g. .!=(_:_:) across types)
      const meta = doc.role_heading ? `<span class="doc-item-meta">${escapeAttr(doc.role_heading)}</span>` : ''
      const abstractText = doc.abstract_text ?? doc.abstract ?? ''
      const abstract = abstractText
        ? `<span class="doc-item-meta">— ${escapeAttr(abstractText.length > 80 ? abstractText.slice(0, 80) + '...' : abstractText)}</span>`
        : ''
      return `<li data-filter-kind="${filterKind}"><a href="${href}">${title}</a>${meta}${abstract}</li>`
    }).join('\n      ')

    roleSections.push(`<section class="role-group" data-filter-kind="${escapeAttr(role)}">
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
<script src="${escapeAttr(`${siteConfig.baseUrl}/assets/collection-filters.js`)}" defer></script>
</body>
</html>`
}
