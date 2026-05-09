
// Page-level templates have been extracted to per-page files in
// src/web/templates/. Each imports the shared helpers below from this
// module, so the public API stays at './templates.js' for callers.
export { renderSearchPage } from './templates/search.js'
export { renderNotFoundPage } from './templates/not-found.js'
export { renderFontsPage } from './templates/fonts.js'
export { renderSymbolsPage } from './templates/symbols.js'


export function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function assetUrl(siteConfig, file) {
  const base = `${siteConfig.baseUrl}/assets/${file}`
  if (!siteConfig.assetVersion) return base
  return `${base}?v=${encodeURIComponent(siteConfig.assetVersion)}`
}

// ---------------------------------------------------------------------------
// Shared page-level fragments
// ---------------------------------------------------------------------------

/**
 * Escape a JSON-LD blob so it cannot break out of `<script type="application/ld+json">`.
 * Only `<` and `>` need escaping — `application/ld+json` is parsed as JSON,
 * not JavaScript, so the rest of the string is safe — but tags inside JSON
 * keys/values would still terminate the script element.
 */
export function escapeJsonLd(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/**
 * Build the SEO meta block: canonical, alternate, OpenGraph, Twitter Card,
 * JSON-LD, and `<meta name="robots">`. Returns an empty string when the
 * caller hasn't provided enough context (e.g. legacy template paths that
 * don't pass `canonical`); doc/framework/index/search templates always pass
 * the right shape.
 */
export function buildSeoBlock({ siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
  if (!canonical) return ''
  const lines = []
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`)
  if (alternate) {
    let altHost = ''
    try { altHost = new URL(alternate).host } catch { /* alternate may be relative */ }
    lines.push(`<link rel="alternate" href="${escapeAttr(alternate)}"${altHost ? ` title="Original on ${escapeAttr(altHost)}"` : ''}>`)
  }
  lines.push(`<meta name="robots" content="${escapeAttr(robots ?? 'index, follow, max-image-preview:large')}">`)

  // OpenGraph + Twitter Card. Both consume the same title/description; we
  // don't ship og:image because Apple's docs don't have a standard hero
  // image we can mirror without licensing concerns.
  const og = {
    'og:type': ogType ?? 'website',
    'og:title': ogTitle ?? siteConfig.siteName,
    'og:url': canonical,
    'og:site_name': siteConfig.siteName,
  }
  if (ogDesc) og['og:description'] = ogDesc
  for (const [property, content] of Object.entries(og)) {
    lines.push(`<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}">`)
  }
  lines.push(`<meta name="twitter:card" content="summary">`)
  lines.push(`<meta name="twitter:title" content="${escapeAttr(ogTitle ?? siteConfig.siteName)}">`)
  if (ogDesc) lines.push(`<meta name="twitter:description" content="${escapeAttr(ogDesc)}">`)

  if (jsonLd) {
    lines.push(`<script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>`)
  }
  return lines.map(l => `  ${l}`).join('\n')
}

export function buildHead({ title, description, siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
  const escapedTitle = escapeAttr(title)
  const escapedDesc = escapeAttr(description ?? '')
  const cssHref = assetUrl(siteConfig, 'style.css')
  const headScriptHref = assetUrl(siteConfig, siteConfig.bundled ? 'core.js' : 'theme.js')
  const seo = buildSeoBlock({
    siteConfig,
    canonical,
    alternate,
    ogType,
    ogTitle: ogTitle ?? title,
    ogDesc: ogDesc ?? description,
    jsonLd,
    robots,
  })
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  ${escapedDesc ? `<meta name="description" content="${escapedDesc}">` : ''}
${seo}
  <link rel="preload" href="${escapeAttr(cssHref)}" as="style">
  <link rel="stylesheet" href="${escapeAttr(cssHref)}">
  <script src="${escapeAttr(headScriptHref)}" defer></script>
</head>`
}

export function buildHeader(siteConfig) {
  const homeHref = `${siteConfig.baseUrl}/`
  // /fonts and /symbols deliberately removed from the global header nav —
  // they remain reachable from the home page's Design section. Keeping them
  // out of the header avoids overflow ≤480px (P2 finding #1) and shortens
  // the visual weight of the chrome on every page.
  return `<header class="site-header">
  <nav class="site-nav">
    <a class="site-name" href="${escapeAttr(homeHref)}">${escapeAttr(siteConfig.siteName)}</a>
    <div class="search-container">
      <input class="search-input" type="search" placeholder="Search…" aria-label="Search documentation" autocomplete="off" aria-expanded="false" aria-controls="search-listbox" aria-activedescendant="" aria-autocomplete="list">
      <button class="search-clear" type="button" aria-label="Clear search" hidden>&times;</button>
      <div class="search-dropdown" id="search-listbox" hidden></div>
      <div id="header-search-status" aria-live="assertive" class="sr-only"></div>
    </div>
    <fieldset class="theme-switcher" role="radiogroup" aria-label="Color scheme">
      <button class="theme-option" type="button" role="radio" data-theme-value="light" aria-label="Light theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg></button>
      <button class="theme-option" type="button" role="radio" data-theme-value="auto" aria-label="System theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" fill="currentColor"/><path d="M8 2.5A5.5 5.5 0 0 1 8 13.5" fill="currentColor"/></svg></button>
      <button class="theme-option" type="button" role="radio" data-theme-value="dark" aria-label="Dark theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3 4.5 4.5 0 0 0 13 9.5z"/></svg></button>
    </fieldset>
  </nav>
</header>`
}

export function buildFooter(siteConfig) {
  const buildDate = escapeAttr(siteConfig.buildDate ?? new Date().toISOString().slice(0, 10))
  return `<footer class="site-footer">
  <p>Built on ${buildDate}</p>
</footer>`
}

// ---------------------------------------------------------------------------
// Script tags — bundled (static build) vs individual (dev server)
// ---------------------------------------------------------------------------

/**
 * Script bundles map. When siteConfig.bundled is true, emit bundles.
 * When false (dev server), emit individual script tags.
 */
const BUNDLES = {
  core: ['theme.js', 'search.js', 'page-toc.js'],
  listing: ['collection-filters.js', 'tree-view.js'],
}

export function buildScripts(siteConfig, groups) {
  if (siteConfig.bundled) {
    return groups
      .filter(g => g !== 'core')
      .map(g => {
        const file = BUNDLES[g] ? `${g}.js` : `${g}.js`
        return `<script src="${escapeAttr(assetUrl(siteConfig, file))}" defer></script>`
      })
      .join('\n')
  }
  // Dev mode — emit individual files
  const files = []
  for (const g of groups) {
    if (BUNDLES[g]) {
      for (const f of BUNDLES[g]) files.push(f)
    } else {
      files.push(`${g}.js`)
    }
  }
  return files.map(f =>
    `<script src="${escapeAttr(assetUrl(siteConfig, f))}" defer></script>`
  ).join('\n')
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
export function buildBreadcrumbs(key, opts = {}) {
  if (!key || typeof key !== 'string') return ''
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return ''

  // Use the document title for the last segment instead of the raw path
  const lastLabel = opts.title ?? segments[segments.length - 1]
  if (segments.length === 1) {
    return `<nav class="breadcrumbs" aria-label="Breadcrumb"><span>${escapeAttr(lastLabel)}</span></nav>`
  }

  // Ancestor title lookup (maps partial key path -> display title)
  const ancestorTitles = opts.ancestorTitles ?? new Map()
  // Set of corpus keys that actually resolve to a rendered page. Intermediate
  // path segments are common in non-DocC sources (swift-book/LanguageGuide/X,
  // apple-archive/documentation/AppleApplications/Conceptual/...) where the
  // joining segments are filesystem directories with no corresponding page.
  // Linking those produces 404s; render them as plain text instead.
  const knownKeys = opts.knownKeys ?? null

  const parts = []
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1
    const partialKey = segments.slice(0, i + 1).join('/')

    let label
    if (isLast) {
      label = lastLabel
    } else if (i === 0 && opts.framework) {
      // First segment is the framework slug — use the display name
      label = opts.framework
    } else if (ancestorTitles.has(partialKey)) {
      label = ancestorTitles.get(partialKey)
    } else {
      label = segments[i]
    }

    // The root segment (`/docs/<framework>/`) always resolves: it's served
    // either by a stored doc page or by renderFrameworkPage at the
    // framework slug. Don't gate it through knownKeys.
    const isFrameworkRoot = i === 0
    if (isLast) {
      parts.push(`<span aria-current="page">${escapeAttr(label)}</span>`)
    } else if (knownKeys && !isFrameworkRoot && !knownKeys.has(partialKey)) {
      // Intermediate hop has no corresponding page — keep the label visible
      // for context but don't dangle a 404 link off it.
      parts.push(`<span>${escapeAttr(label)}</span>`)
    } else {
      const href = `/docs/${partialKey}/`
      parts.push(`<a href="${escapeAttr(href)}">${escapeAttr(label)}</a>`)
    }
  }

  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${parts.join('<span class="breadcrumb-sep" aria-hidden="true"> / </span>')}</nav>`
}

// ---------------------------------------------------------------------------
// Original-resource link helpers
// ---------------------------------------------------------------------------

/**
 * Derive the upstream URL for a root/framework record. Documents carry a
 * per-page `url` column, but framework landing pages don't — we synthesize
 * from source_type + slug.
 */
export function frameworkOriginalUrl(root) {
  if (!root) return null
  if (root.url) return root.url
  const slug = root.slug ?? ''
  switch (root.source_type) {
    case 'hig': return 'https://developer.apple.com/design/human-interface-guidelines'
    case 'guidelines': return 'https://developer.apple.com/app-store/review/guidelines/'
    case 'wwdc': return 'https://developer.apple.com/videos/'
    case 'sample-code': return 'https://developer.apple.com/sample-code/'
    case 'swift-evolution': return 'https://www.swift.org/swift-evolution/'
    case 'swift-book': return 'https://docs.swift.org/swift-book/'
    case 'swift-org': return 'https://www.swift.org/'
    case 'apple-archive': return 'https://developer.apple.com/library/archive/'
    case 'packages': return 'https://swiftpackageindex.com/'
    default: return slug ? `https://developer.apple.com/documentation/${slug}` : null
  }
}

/** Short hostname label ("developer.apple.com") used in the link text. */
export function hostLabel(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * Render the "Original resource" sidebar block. Returns an empty string when
 * no upstream URL is available.
 */
export function buildOriginalResourceBlock(url) {
  if (!url) return ''
  const host = hostLabel(url)
  return `<div class="sidebar-block sidebar-source">
  <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-source-link">Open on ${escapeAttr(host || 'source')}</a>
</div>`
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

export function buildDocMeta(doc) {
  const badges = []
  const frameworkLabel = doc.framework_display ?? doc.framework
  if (frameworkLabel) {
    badges.push(`<span class="badge badge-framework">${escapeAttr(frameworkLabel)}</span>`)
  }
  if (doc.role_heading) {
    badges.push(`<span class="badge badge-role">${escapeAttr(doc.role_heading)}</span>`)
  }
  if (doc.is_deprecated) {
    badges.push('<span class="badge badge-deprecated">Deprecated</span>')
  }
  if (doc.is_beta) {
    badges.push('<span class="badge badge-beta">Beta</span>')
  }

  // Platform availability badges
  const platforms = parsePlatformsJson(doc.platforms_json)
  const platformBadges = buildPlatformBadges(platforms)

  const parts = []
  if (badges.length > 0) parts.push(`<div class="doc-meta">${badges.join('')}</div>`)
  if (platformBadges) parts.push(platformBadges)
  return parts.join('\n  ')
}

/** Parse platforms_json from DB (string or object). */
export function parsePlatformsJson(platformsJson) {
  if (!platformsJson) return null
  if (typeof platformsJson === 'object') return platformsJson
  try { return JSON.parse(platformsJson) } catch { return null }
}

/** Build a platform availability line from a platforms map. */
export function buildPlatformBadges(platforms) {
  if (!platforms || typeof platforms !== 'object') return ''
  const platformNames = {
    ios: 'iOS', macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS',
    visionos: 'visionOS', maccatalyst: 'Mac Catalyst', ipados: 'iPadOS',
  }
  const items = []
  for (const [slug, version] of Object.entries(platforms)) {
    if (!version) continue
    const name = platformNames[slug] ?? slug
    items.push(`<span class="badge badge-platform">${escapeAttr(name)} ${escapeAttr(version)}+</span>`)
  }
  if (items.length === 0) return ''
  return `<div class="doc-availability">${items.join('')}</div>`
}

// ---------------------------------------------------------------------------
// Relationship sidebar
// ---------------------------------------------------------------------------

/** Returns the inner HTML content of the relationships sidebar (without the wrapping <aside>). */
// Doc-content helpers (relationship sidebar, page TOC, TOC HTML) live in
// templates/_doc-content.js. Re-exported so existing call sites work.
export {
  buildPageToc,
  buildRelationshipContent,
  hasRenderableItems,
  renderTocHtml,
} from './templates/_doc-content.js'

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

// renderDocumentPage / renderIndexPage / renderFrameworkPage +

// buildFrameworkTreeData live in dedicated per-page files now.

export { renderDocumentPage } from './templates/document.js'

export { renderIndexPage } from './templates/index-page.js'

export { renderFrameworkPage, buildFrameworkTreeData } from './templates/framework.js'
