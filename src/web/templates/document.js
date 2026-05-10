import {
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
import { renderHtml } from '../../content/render-html.js'

export function renderDocumentPage(doc, sections, siteConfig, opts = {}) {
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
  const breadcrumbs = doc.key ? buildBreadcrumbs(doc.key, {
    title: doc.title,
    framework: doc.framework_display ?? doc.framework,
    ancestorTitles: opts.ancestorTitles,
    knownKeys: opts.knownKeys,
  }) : ''

  // Sort sections for TOC (same order as renderHtml uses)
  const orderedSections = sectionsList.slice().sort((a, b) =>
    (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0)
  )
  const tocItems = buildPageToc(orderedSections)

  const relationshipSection = orderedSections.find(s =>
    (s.sectionKind ?? s.section_kind) === 'relationships'
  )

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
  if (originalBlock) sidebarParts.push(originalBlock)
  if (docMeta) {
    sidebarParts.push(`<div class="sidebar-block sidebar-meta">${docMeta}</div>`)
  }
  if (hasLangToggle) {
    sidebarParts.push(`<div class="sidebar-block">
  <div class="lang-toggle" role="group" aria-label="Language">
    <button class="lang-btn active" data-lang="swift" aria-pressed="true">Swift</button>
    <button class="lang-btn" data-lang="occ" aria-pressed="false">ObjC</button>
  </div>
</div>`)
  }
  if (hasSidebar) {
    sidebarParts.push(`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  }
  if (relationshipSection) {
    const relJson = relationshipSection.contentJson ?? relationshipSection.content_json ?? ''
    if (typeof relJson === 'string' ? hasRenderableItems(relJson) : true) {
      sidebarParts.push(`<div class="sidebar-block">${buildRelationshipContent(relationshipSection)}</div>`)
    }
  }

  const sidebar = sidebarParts.length > 0
    ? `<aside class="doc-sidebar">${sidebarParts.join('\n')}</aside>`
    : ''

  const hasSidebarFinal = sidebar.length > 0

  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  const canonical = doc.key ? `${siteConfig.baseUrl || ''}/docs/${doc.key}/` : null
  const docDescription = doc.abstract_text || `${doc.title ?? ''} — Apple developer documentation`.trim()
  const platforms = parsePlatformsJson(doc.platforms_json) || {}
  const platformNames = Object.keys(platforms).filter(k => platforms[k]).map(k => ({
    ios: 'iOS', macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS', visionos: 'visionOS',
    maccatalyst: 'Mac Catalyst', ipados: 'iPadOS',
  }[k] ?? k))
  const programmingLanguage = (doc.language === 'occ' || doc.language === 'objc') ? 'Objective-C' : 'Swift'
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
  }

  return `<!DOCTYPE html>
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
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${hasSidebarFinal ? ' has-sidebar' : ''}">
  ${breadcrumbs}
  ${mobileToc}
  <article class="doc-article">
    ${content}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', ...(hasLangToggle ? ['lang-toggle'] : [])])}
</body>
</html>`
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
function enrichTopicItems(sections, resolveRoleHeadings) {
  for (const section of sections) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind !== 'topics') continue

    const raw = section.contentJson ?? section.content_json
    let contentJson = null
    if (typeof raw === 'string') {
      try { contentJson = JSON.parse(raw) } catch { continue }
    } else if (typeof raw === 'object' && raw !== null) {
      // Defensive clone — never mutate a shared upstream object.
      try { contentJson = structuredClone(raw) } catch { continue }
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
