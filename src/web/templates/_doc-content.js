import { slugify } from '../../content/render-html.js'
import { escapeAttr } from '../templates.js'

export function buildRelationshipContent(section) {
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
            return `<li><a href="/docs/${escapeAttr(item.key)}/"><code>${escapeAttr(item.title ?? item.key)}</code></a></li>`
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

/** Build TOC item list from ordered sections. Skips abstract and empty sections. */
export function buildPageToc(sections) {
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

    let id, label
    switch (kind) {
      case 'declaration':
        id = 'declaration'; label = 'Declaration'; break
      case 'parameters':
        id = 'parameters'; label = 'Parameters'; break
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
        id = 'mentioned-in'; label = 'Mentioned in'; break
      case 'discussion':
        label = section.heading ?? 'Overview'
        id = slugify(label)
        break
      case 'topics':
        id = 'topics'; label = 'Topics'; break
      case 'relationships':
        continue // rendered in sidebar, not in article body
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

/** Check if a JSON content string (or parsed object) for a link section has at least one renderable item. */
export function hasRenderableItems(json) {
  if (!json) return false
  let groups = null
  if (typeof json === 'string') {
    try { groups = JSON.parse(json) } catch { return false }
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

/** Render the TOC HTML. In mobile mode, wraps in a <details> element. */
export function renderTocHtml(tocItems, mobile = false) {
  if (tocItems.length < 2) return ''
  const listHtml = `<ul>${tocItems.map(item =>
    `<li><a href="#${escapeAttr(item.id)}">${escapeAttr(item.label)}</a></li>`
  ).join('')}</ul>`

  if (mobile) {
    return `<details class="page-toc-mobile"><summary>Contents</summary><nav class="page-toc">${listHtml}</nav></details>`
  }
  return `<nav class="page-toc">${listHtml}</nav>`
}

