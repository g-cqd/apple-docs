import { renderHtml } from '../../content/render-html.js'
import { safeWebDocKey } from '../../lib/safe-path.js'
import { html, raw } from '../lib/html.js'
import {
  buildBreadcrumbListJsonLd,
  buildBreadcrumbs,
  buildDocMeta,
  buildFooter,
  buildHead,
  buildHeader,
  buildOriginalResourceBlock,
  buildPageToc,
  buildRelationshipContent,
  buildScripts,
  hasRenderableItems,
  parsePlatformsJson,
  renderTocHtml,
} from '../templates.js'

export function renderDocumentPage(/** @type {any} */ doc, /** @type {any} */ sections, /** @type {any} */ siteConfig, /** @type {any} */ opts = {}) {
  const sectionsList = sections ?? []

  // Enrich topics items with role_heading from DB (if resolver provided)
  if (opts.resolveRoleHeadings) {
    enrichTopicItems(sectionsList, opts.resolveRoleHeadings)
  }

  const pageTitle = `${doc.title ?? 'Untitled'} — ${siteConfig.siteName}`
  const renderOpts = {}
  if (opts.knownKeys) renderOpts.knownKeys = opts.knownKeys
  let content = renderHtml(doc, sectionsList, renderOpts)

  // Detect multi-language declarations for language toggle
  const hasLangToggle = content.includes('data-languages=')
  const breadcrumbs = doc.key
    ? buildBreadcrumbs(doc.key, {
        title: doc.title,
        framework: doc.framework_display ?? doc.framework,
        ancestorTitles: opts.ancestorTitles,
        knownKeys: opts.knownKeys,
      })
    : null

  // Sort sections for TOC (same order as renderHtml uses)
  const orderedSections = sectionsList
    .slice()
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0))
  const tocItems = buildPageToc(orderedSections)

  const relationshipSection = orderedSections.find((/** @type {any} */ s) => (s.sectionKind ?? s.section_kind) === 'relationships')

  const hasSidebar = tocItems.length >= 2

  // When sidebar renders relationships separately, mark the in-article duplicate as hidden from assistive tech
  if (hasSidebar) {
    content = content.replace('<section id="relationships">', '<section id="relationships" aria-hidden="true">')
  }

  // Build doc meta (badges + platforms)
  const docMeta = buildDocMeta(doc)

  // Compose sidebar as a stack of discrete blocks:
  // Original-resource → meta → language toggle → TOC → relationships.
  const sidebarParts = []
  const originalBlock = buildOriginalResourceBlock(doc.url)
  if (originalBlock.toString()) sidebarParts.push(originalBlock)
  if (docMeta.toString()) {
    sidebarParts.push(html`<div class="sidebar-block sidebar-meta">${docMeta}</div>`)
  }
  if (hasLangToggle) {
    sidebarParts.push(html`<div class="sidebar-block">
  <div class="lang-toggle" role="group" aria-label="Language">
    <button class="lang-btn active" data-lang="swift" aria-pressed="true">Swift</button>
    <button class="lang-btn" data-lang="occ" aria-pressed="false">ObjC</button>
  </div>
</div>`)
  }
  if (hasSidebar) {
    sidebarParts.push(html`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  }
  if (relationshipSection) {
    const relJson = relationshipSection.contentJson ?? relationshipSection.content_json ?? ''
    if (typeof relJson === 'string' ? hasRenderableItems(relJson) : true) {
      sidebarParts.push(html`<div class="sidebar-block">${buildRelationshipContent(relationshipSection)}</div>`)
    }
  }

  const sidebar = sidebarParts.length > 0 ? html`<aside class="doc-sidebar">${interleave(sidebarParts, html`\n`)}</aside>` : null

  const hasSidebarFinal = sidebarParts.length > 0

  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : null

  const webKey = doc.key ? safeWebDocKey(doc.key) : null
  const canonical = webKey ? `${siteConfig.baseUrl || ''}/docs/${webKey}/` : null
  // Advertise the Markdown variant (served at /docs/<key>.md) so agents
  // discover it without sniffing. A distinct URL → distinct cache key, so it
  // caches cleanly alongside the HTML (no Vary: Accept hazard).
  const mdAlternate =
    siteConfig.markdownDocs && webKey ? html`<link rel="alternate" type="text/markdown" href="${siteConfig.baseUrl || ''}/docs/${webKey}.md">` : null
  const docDescription = doc.abstract_text || `${doc.title ?? ''} — Apple developer documentation`.trim()
  const platforms = parsePlatformsJson(doc.platforms_json) || {}
  const platformNames = Object.keys(platforms)
    .filter((k) => platforms[k])
    .map(
      (k) =>
        ({
          ios: 'iOS',
          macos: 'macOS',
          watchos: 'watchOS',
          tvos: 'tvOS',
          visionos: 'visionOS',
          maccatalyst: 'Mac Catalyst',
          ipados: 'iPadOS',
        })[k] ?? k,
    )
  const programmingLanguage = doc.language === 'occ' || doc.language === 'objc' ? 'Objective-C' : 'Swift'
  const breadcrumbJsonLd = doc.key
    ? buildBreadcrumbListJsonLd(doc.key, siteConfig.baseUrl, {
        title: doc.title,
        framework: doc.framework_display ?? doc.framework,
        ancestorTitles: opts.ancestorTitles,
      })
    : null
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title ?? 'Untitled',
    inLanguage: 'en',
    isAccessibleForFree: true,
    mainEntityOfPage: canonical,
    publisher: {
      '@type': 'Organization',
      name: siteConfig.siteName,
      url: `${siteConfig.baseUrl || ''}/`,
    },
    ...(docDescription ? { description: docDescription } : {}),
    ...(siteConfig.buildDate ? { dateModified: siteConfig.buildDate } : {}),
    ...(doc.url ? { isBasedOn: doc.url } : {}),
    ...(programmingLanguage ? { programmingLanguage } : {}),
    ...(platformNames.length > 0 ? { audience: { '@type': 'Audience', audienceType: 'Developers' }, applicationSuite: platformNames.join(', ') } : {}),
    ...(breadcrumbJsonLd ? { breadcrumb: breadcrumbJsonLd } : {}),
  }

  return html`<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description: doc.abstract_text,
  siteConfig,
  canonical,
  alternate: doc.url || null,
  ogType: 'article',
  ogTitle: doc.title ?? pageTitle,
  ogDesc: docDescription,
  jsonLd,
  headExtra: mdAlternate,
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${hasSidebarFinal ? ' has-sidebar' : ''}">
  ${breadcrumbs}
  ${mobileToc}
  <article class="doc-article">
    ${raw(content)}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', ...(hasLangToggle ? ['lang-toggle'] : [])])}
</body>
</html>`
}

/** Splice an HtmlString separator between every element of `items`. */
function interleave(/** @type {any} */ items, /** @type {any} */ separator) {
  const out = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(separator)
    out.push(items[i])
  }
  return out
}

/** Batch-enrich topics section items with _resolvedRoleHeading from DB.
 *
 *  Deep-clones the parsed JSON before mutation. Aliasing
 *  `section.contentJson` directly when the upstream had already parsed
 *  it would be a correctness hazard: build.js batches sectionsByDoc
 *  per-root and reuses section rows across renders, so a second render
 *  of the same doc would see pre-enriched JSON with the
 *  `_resolvedRoleHeading` markers baked in. Dormant on the single-render-
 *  per-build path but real if anything ever retries a render.
 */
function enrichTopicItems(/** @type {any} */ sections, /** @type {any} */ resolveRoleHeadings) {
  for (const section of sections) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind !== 'topics') continue

    const raw = section.contentJson ?? section.content_json
    let contentJson = null
    if (typeof raw === 'string') {
      try {
        contentJson = JSON.parse(raw)
      } catch {
        continue
      }
    } else if (typeof raw === 'object' && raw !== null) {
      // Defensive clone — never mutate a shared upstream object.
      try {
        contentJson = structuredClone(raw)
      } catch {
        continue
      }
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
 * @param {Array<any>}  frameworks - Framework records (slug, name, kind, doc_count)
 * @param {any} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
