import { html, raw } from './lib/html.js'

// Page-level templates have been extracted to per-page files in
// src/web/templates/. Each imports the shared helpers below from this
// module, so the public API stays at './templates.js' for callers.
export { renderSearchPage } from './templates/search.js'
export { renderNotFoundPage } from './templates/not-found.js'
export { renderFontsPage } from './templates/fonts.js'
export { renderSymbolsPage } from './templates/symbols.js'


// Thin alias over `Bun.escapeHTML` so existing call sites keep their
// intent label. Bun's native implementation is faster than chained
// `replaceAll`s and escapes the same set of characters (`& < > " '`)
// — the only wire-level difference is `&#x27;` vs `&#39;` for the
// apostrophe, which is semantically identical in HTML.
//
// Still exported because per-page templates that haven't migrated to
// the DSL (`src/web/lib/html.js`) yet rely on it. Phase 1 of the DSL
// migration drops every caller; this helper goes away once that lands.
export function escapeAttr(value) {
  return Bun.escapeHTML(String(value ?? ''))
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
function escapeJsonLd(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/**
 * Build the SEO meta block: canonical, alternate, OpenGraph, Twitter Card,
 * JSON-LD, and `<meta name="robots">`. Returns an empty HtmlString when the
 * caller hasn't provided enough context (e.g. legacy template paths that
 * don't pass `canonical`); doc/framework/index/search templates always pass
 * the right shape.
 *
 * @returns {import('./lib/html.js').HtmlString}
 */
function buildSeoBlock({ siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
  if (!canonical) return html``
  let altHost = ''
  if (alternate) {
    try { altHost = new URL(alternate).host } catch { /* alternate may be relative */ }
  }
  const altTitle = altHost ? ` title="Original on ${Bun.escapeHTML(altHost)}"` : ''
  const ogProperties = [
    ['og:type', ogType ?? 'website'],
    ['og:title', ogTitle ?? siteConfig.siteName],
    ['og:url', canonical],
    ['og:site_name', siteConfig.siteName],
  ]
  if (ogDesc) ogProperties.push(['og:description', ogDesc])
  // Each emitted line is indented two spaces to match the historical
  // string layout — this keeps byte-level test snapshots stable
  // through the DSL migration.
  const lines = [
    html`  <link rel="canonical" href="${canonical}">`,
    alternate ? html`  <link rel="alternate" href="${alternate}"${raw(altTitle)}>` : null,
    html`  <meta name="robots" content="${robots ?? 'index, follow, max-image-preview:large'}">`,
    ...ogProperties.map(([property, content]) =>
      html`  <meta property="${property}" content="${content}">`,
    ),
    html`  <meta name="twitter:card" content="summary">`,
    html`  <meta name="twitter:title" content="${ogTitle ?? siteConfig.siteName}">`,
    ogDesc ? html`  <meta name="twitter:description" content="${ogDesc}">` : null,
    jsonLd ? html`  <script type="application/ld+json">${raw(escapeJsonLd(jsonLd))}</script>` : null,
  ].filter(Boolean)
  // Interleave with newlines so the joined output matches the previous
  // `lines.join('\n')` shape exactly.
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push(raw('\n'))
    out.push(lines[i])
  }
  return html`${out}`
}

/** @returns {import('./lib/html.js').HtmlString} */
export function buildHead({ title, description, siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
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
  const descMeta = description
    ? html`<meta name="description" content="${description}">`
    : raw('')
  return html`<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${descMeta}
${seo}
  <link rel="preload" href="${cssHref}" as="style">
  <link rel="stylesheet" href="${cssHref}">
  <script src="${headScriptHref}" defer></script>
</head>`
}

/** @returns {import('./lib/html.js').HtmlString} */
export function buildHeader(siteConfig) {
  const homeHref = `${siteConfig.baseUrl}/`
  // /fonts and /symbols deliberately removed from the global header nav —
  // they remain reachable from the home page's Design section. Keeping them
  // out of the header avoids overflow ≤480px (P2 finding #1) and shortens
  // the visual weight of the chrome on every page.
  return html`<header class="site-header">
  <nav class="site-nav">
    <a class="site-name" href="${homeHref}">${siteConfig.siteName}</a>
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

/** @returns {import('./lib/html.js').HtmlString} */
export function buildFooter(siteConfig) {
  const buildDate = siteConfig.buildDate ?? new Date().toISOString().slice(0, 10)
  // Snapshot tag is sourced from the installed DB's snapshot_meta at build
  // time (see src/web/build.js); fall back to an em-dash when the corpus
  // predates the tag column so an older deploy still renders a valid footer.
  // Snapshot tag links to the GitHub release the instance is serving.
  // <code> here is semantic (it's a literal release tag like "snapshot-20260511")
  // — not a styling decision; the earlier "no <code>" feedback was about a
  // bare tag with no link, which read as gratuitous monospace styling.
  const snapshotLine = siteConfig.snapshotTag
    ? html`<span class="footer-snapshot">Snapshot <a href="https://github.com/g-cqd/apple-docs/releases/tag/${siteConfig.snapshotTag}" rel="noopener noreferrer"><code>${siteConfig.snapshotTag}</code></a></span>`
    : null
  return html`<footer class="site-footer">
  <p>
    Built on ${buildDate}${snapshotLine ? html` &middot; ${snapshotLine}` : null}
    &middot; by <a href="https://github.com/g-cqd" rel="noopener noreferrer">@g-cqd</a>
    &middot; based on <a href="https://developer.apple.com" rel="noopener noreferrer">Apple Developer Documentation</a>
  </p>
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

/** @returns {import('./lib/html.js').HtmlString} */
export function buildScripts(siteConfig, groups) {
  const files = []
  if (siteConfig.bundled) {
    for (const group of groups) {
      if (group === 'core') continue
      files.push(`${group}.js`)
    }
  } else {
    for (const group of groups) {
      if (BUNDLES[group]) {
        for (const f of BUNDLES[group]) files.push(f)
      } else {
        files.push(`${group}.js`)
      }
    }
  }
  const tags = files.map((file, i) => {
    const sep = i > 0 ? raw('\n') : raw('')
    return html`${sep}<script src="${assetUrl(siteConfig, file)}" defer></script>`
  })
  return html`${tags}`
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
 *
 * @returns {import('./lib/html.js').HtmlString}
 */
export function buildBreadcrumbs(key, opts = {}) {
  if (!key || typeof key !== 'string') return html``
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return html``

  // Use the document title for the last segment instead of the raw path
  const lastLabel = opts.title ?? segments[segments.length - 1]
  if (segments.length === 1) {
    return html`<nav class="breadcrumbs" aria-label="Breadcrumb"><span>${lastLabel}</span></nav>`
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
      parts.push(html`<span aria-current="page">${label}</span>`)
    } else if (knownKeys && !isFrameworkRoot && !knownKeys.has(partialKey)) {
      // Intermediate hop has no corresponding page — keep the label visible
      // for context but don't dangle a 404 link off it.
      parts.push(html`<span>${label}</span>`)
    } else {
      const href = `/docs/${partialKey}/`
      parts.push(html`<a href="${href}">${label}</a>`)
    }
  }

  // Interleave with the breadcrumb separator span, matching the
  // historical `parts.join('<span class="breadcrumb-sep">…</span>')`.
  const sep = html`<span class="breadcrumb-sep" aria-hidden="true"> / </span>`
  const interleaved = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) interleaved.push(sep)
    interleaved.push(parts[i])
  }
  return html`<nav class="breadcrumbs" aria-label="Breadcrumb">${interleaved}</nav>`
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
function hostLabel(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * Render the "Original resource" sidebar block. Returns an empty
 * HtmlString when no upstream URL is available.
 *
 * @returns {import('./lib/html.js').HtmlString}
 */
export function buildOriginalResourceBlock(url) {
  if (!url) return html``
  const host = hostLabel(url) || 'source'
  return html`<div class="sidebar-block sidebar-source">
  <a href="${url}" target="_blank" rel="noopener noreferrer" class="sidebar-source-link">Open on ${host}</a>
</div>`
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

/** @returns {import('./lib/html.js').HtmlString} */
export function buildDocMeta(doc) {
  const badges = []
  const frameworkLabel = doc.framework_display ?? doc.framework
  if (frameworkLabel) {
    badges.push(html`<span class="badge badge-framework">${frameworkLabel}</span>`)
  }
  if (doc.role_heading) {
    badges.push(html`<span class="badge badge-role">${doc.role_heading}</span>`)
  }
  if (doc.is_deprecated) {
    badges.push(html`<span class="badge badge-deprecated">Deprecated</span>`)
  }
  if (doc.is_beta) {
    badges.push(html`<span class="badge badge-beta">Beta</span>`)
  }

  // Platform availability badges
  const platforms = parsePlatformsJson(doc.platforms_json)
  const platformBadges = buildPlatformBadges(platforms)

  const parts = []
  if (badges.length > 0) parts.push(html`<div class="doc-meta">${badges}</div>`)
  if (platformBadges) parts.push(platformBadges)
  // Historical layout joined parts with `\n  ` (newline + two-space indent).
  const interleaved = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) interleaved.push(raw('\n  '))
    interleaved.push(parts[i])
  }
  return html`${interleaved}`
}

/** Parse platforms_json from DB (string or object). */
export function parsePlatformsJson(platformsJson) {
  if (!platformsJson) return null
  if (typeof platformsJson === 'object') return platformsJson
  try { return JSON.parse(platformsJson) } catch { return null }
}

/** Build a platform availability line from a platforms map. */
function buildPlatformBadges(platforms) {
  if (!platforms || typeof platforms !== 'object') return null
  const platformNames = {
    ios: 'iOS', macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS',
    visionos: 'visionOS', maccatalyst: 'Mac Catalyst', ipados: 'iPadOS',
  }
  const items = []
  for (const [slug, version] of Object.entries(platforms)) {
    if (!version) continue
    const name = platformNames[slug] ?? slug
    items.push(html`<span class="badge badge-platform">${name} ${version}+</span>`)
  }
  if (items.length === 0) return null
  return html`<div class="doc-availability">${items}</div>`
}

// ---------------------------------------------------------------------------
// Relationship sidebar
// ---------------------------------------------------------------------------

// Doc-content helpers (relationship sidebar, page TOC, TOC HTML) live in
// templates/_doc-content.js. Re-exported so existing call sites work.
export {
  buildPageToc,
  buildRelationshipContent,
  hasRenderableItems,
  renderTocHtml,
} from './templates/_doc-content.js'

// ---------------------------------------------------------------------------
// Re-exports — page-level templates live in per-page files now.
// ---------------------------------------------------------------------------

// `attr` re-export so per-page templates can build conditional
// attribute fragments without importing the DSL module directly.
// (Kept narrow on purpose — most templates only need `html` + `raw`
// from the DSL plus the spine helpers here.)
export { attr } from './lib/html.js'

export { renderDocumentPage } from './templates/document.js'

export { renderIndexPage } from './templates/index-page.js'

export { renderFrameworkPage, buildFrameworkTreeData } from './templates/framework.js'
