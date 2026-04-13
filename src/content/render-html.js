import { renderContentNodesToText } from './normalize.js'

const LINK_SECTION_TITLES = {
  topics: 'Topics',
  relationships: 'Relationships',
  see_also: 'See Also',
}

export function renderHtml(document, sections = []) {
  const doc = coerceDocument(document)
  const orderedSections = sections
    .map(coerceSection)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const parts = []

  if (doc.title) {
    parts.push(`<h1>${escapeHtml(doc.title)}</h1>`)
  }

  for (const section of orderedSections) {
    const rendered = renderSectionHtml(section)
    if (rendered) parts.push(rendered)
  }

  return parts.join('\n').trim()
}

function renderSectionHtml(section) {
  switch (section.sectionKind) {
    case 'abstract':
      return `<p>${escapeHtml(section.contentText ?? '')}</p>`
    case 'declaration':
      return renderDeclarationHtml(section)
    case 'parameters':
      return renderParametersHtml(section)
    case 'discussion':
      return renderBlockSection(section.heading ?? 'Overview', section.contentText)
    case 'topics':
    case 'relationships':
    case 'see_also':
      return renderLinkSectionHtml(LINK_SECTION_TITLES[section.sectionKind] ?? section.heading ?? 'Related', section)
    default:
      if (!section.contentText?.trim()) return ''
      return renderBlockSection(section.heading ?? 'Section', section.contentText)
  }
}

function renderDeclarationHtml(section) {
  const declarations = safeJson(section.contentJson)
  const blocks = Array.isArray(declarations) ? declarations : []
  const snippets = blocks
    .map(declaration => {
      const code = (declaration?.tokens ?? []).map(token => token.text ?? '').join('').trim()
      const language = declaration?.languages?.[0] ?? 'swift'
      if (!code) return null
      return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`
    })
    .filter(Boolean)

  if (snippets.length === 0 && section.contentText?.trim()) {
    snippets.push(`<pre><code class="language-swift">${escapeHtml(section.contentText.trim())}</code></pre>`)
  }

  if (snippets.length === 0) return ''
  return `<section><h2>Declaration</h2>${snippets.join('')}</section>`
}

function renderParametersHtml(section) {
  const parameters = safeJson(section.contentJson)
  const items = Array.isArray(parameters)
    ? parameters.map(parameter => {
      const description = renderContentNodesToText(parameter?.content ?? [], {})
        .replace(/\s+/g, ' ')
        .trim()
      return `<li><strong>${escapeHtml(parameter?.name ?? 'Value')}</strong>: ${escapeHtml(description)}</li>`
    })
    : section.contentText?.trim()
      ? section.contentText.trim().split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`)
      : []

  if (items.length === 0) return ''
  return `<section><h2>Parameters</h2><ul>${items.join('')}</ul></section>`
}

function renderBlockSection(title, text) {
  if (!text?.trim()) return ''
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map(paragraph => `<p>${escapeHtml(paragraph.replace(/\n+/g, ' ').trim())}</p>`)
    .join('')
  return `<section><h2>${escapeHtml(title)}</h2>${paragraphs}</section>`
}

function renderLinkSectionHtml(title, section) {
  const groups = safeJson(section.contentJson)
  const body = []

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        body.push(`<h3>${escapeHtml(group.title)}</h3>`)
      }
      const items = (group?.items ?? [])
        .map(item => item?.key
          ? `<li><a href="${escapeHtml(item.key)}.html">${escapeHtml(item.title ?? item.key)}</a></li>`
          : `<li>${escapeHtml(item?.title ?? item?.identifier ?? '')}</li>`)
        .join('')
      if (items) {
        body.push(`<ul>${items}</ul>`)
      }
    }
  } else if (section.contentText?.trim()) {
    const items = section.contentText.trim().split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`).join('')
    body.push(`<ul>${items}</ul>`)
  }

  if (body.length === 0) return ''
  return `<section><h2>${escapeHtml(title)}</h2>${body.join('')}</section>`
}

function coerceDocument(document) {
  return {
    title: document?.title ?? null,
  }
}

function coerceSection(section) {
  return {
    sectionKind: section?.sectionKind ?? section?.section_kind ?? null,
    heading: section?.heading ?? null,
    contentText: section?.contentText ?? section?.content_text ?? '',
    contentJson: section?.contentJson ?? section?.content_json ?? null,
    sortOrder: section?.sortOrder ?? section?.sort_order ?? 0,
  }
}

function safeJson(value) {
  if (!value || typeof value !== 'string') return value ?? null
  try { return JSON.parse(value) } catch { return null }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
