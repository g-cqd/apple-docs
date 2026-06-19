import { slugify } from '../../content/render-html.js'
import { safeWebDocKey } from '../../lib/safe-path.js'
import { html, raw } from '../lib/html.js'

/** @returns {import('../lib/html.js').HtmlString} */
export function buildRelationshipContent(/** @type {any} */ section) {
  const contentJson = section?.content_json ?? section?.contentJson ?? null
  let groups = null
  if (contentJson && typeof contentJson === 'string') {
    try {
      groups = JSON.parse(contentJson)
    } catch {
      /* ignore */
    }
  } else if (contentJson && typeof contentJson === 'object') {
    groups = contentJson
  }

  /** @type {import('../lib/html.js').HtmlString[]} */
  const parts = [html`<h2>Relationships</h2>`]

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        parts.push(html`<h3 class="sidebar-group-title">${group.title}</h3>`)
      }
      const items = (group?.items ?? []).map((/** @type {any} */ item) => {
        if (item?.key) {
          return html`<li><a href="/docs/${safeWebDocKey(item.key)}/"><code>${item.title ?? item.key}</code></a></li>`
        }
        return html`<li>${item?.title ?? item?.identifier ?? ''}</li>`
      })
      if (items.length > 0) {
        parts.push(html`<ul class="sidebar-list">${items}</ul>`)
      }
    }
  } else {
    parts.push(html`<p class="sidebar-hint">See relationships section in the article.</p>`)
  }

  // Historical layout joined with `\n  ` (newline + two-space indent).
  const interleaved = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) interleaved.push(raw('\n  '))
    interleaved.push(parts[i])
  }
  return html`${interleaved}`
}

// ---------------------------------------------------------------------------
// Page TOC (Table of Contents)
// ---------------------------------------------------------------------------

/** Build TOC item list from ordered sections. Skips abstract and empty sections. */
export function buildPageToc(/** @type {any} */ sections) {
  const items = []
  for (const section of sections ?? []) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind === 'abstract') continue

    // Skip sections that have no renderable content
    const text = section.contentText ?? section.content_text ?? ''
    const json = section.contentJson ?? section.content_json ?? null
    const hasText = typeof text === 'string' && text.trim().length > 0
    const hasJson = json != null && (typeof json === 'string' ? json.trim().length > 0 : true)
    if (!hasText && !hasJson) continue

    // For link sections (topics, relationships, see_also), check if the parsed
    // JSON actually has items — an empty group list produces no visible content
    if (kind === 'topics' || kind === 'relationships' || kind === 'see_also') {
      if (!hasRenderableItems(json)) continue
    }

    let id
    let label
    switch (kind) {
      case 'declaration':
        id = 'declaration'
        label = 'Declaration'
        break
      case 'parameters':
        id = 'parameters'
        label = 'Parameters'
        break
      case 'properties':
        label = section.heading ?? 'Properties'
        id = slugify(label)
        break
      case 'rest_endpoint':
        label = section.heading ?? 'URL'
        id = slugify(label)
        break
      case 'rest_parameters':
        label = section.heading ?? 'Parameters'
        id = slugify(label)
        break
      case 'rest_responses':
        label = section.heading ?? 'Response Codes'
        id = slugify(label)
        break
      case 'possible_values':
        label = section.heading ?? 'Possible Values'
        id = slugify(label)
        break
      case 'mentioned_in':
        id = 'mentioned-in'
        label = 'Mentioned in'
        break
      case 'discussion':
        label = section.heading ?? 'Overview'
        id = slugify(label)
        break
      case 'topics':
        id = 'topics'
        label = 'Topics'
        break
      case 'relationships':
        continue // rendered in sidebar, not in article body
      case 'see_also':
        id = 'see-also'
        label = 'See Also'
        break
      default:
        label = section.heading ?? 'Section'
        id = slugify(label)
    }
    if (id) items.push({ id, label })
  }
  return items
}

/** Check if a JSON content string (or parsed object) for a link section has at least one renderable item. */
export function hasRenderableItems(/** @type {any} */ json) {
  if (!json) return false
  let groups = null
  if (typeof json === 'string') {
    try {
      groups = JSON.parse(json)
    } catch {
      return false
    }
  } else if (Array.isArray(json)) {
    groups = json
  } else {
    return false
  }
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    const items = group?.items ?? []
    if (items.length > 0) return true
  }
  return false
}

/**
 * Render the TOC HTML. In mobile mode, wraps in a <details> element.
 * @returns {import('../lib/html.js').HtmlString}
 */
export function renderTocHtml(/** @type {any} */ tocItems, mobile = false) {
  if (tocItems.length < 2) return html``
  const list = tocItems.map((/** @type {any} */ item) => html`<li><a href="#${item.id}">${item.label}</a></li>`)
  const listHtml = html`<ul>${list}</ul>`
  if (mobile) {
    return html`<details class="page-toc-mobile"><summary>Contents</summary><nav class="page-toc">${listHtml}</nav></details>`
  }
  return html`<nav class="page-toc">${listHtml}</nav>`
}
