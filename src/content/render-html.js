import { coerceDocument as _coerceDocument, coerceSection as _coerceSection } from './coercion.js'
import { normalizeIdentifier } from '../apple/normalizer.js'

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
      return renderAbstractHtml(section)
    case 'declaration':
      return renderDeclarationHtml(section)
    case 'parameters':
      return renderParametersHtml(section)
    case 'discussion':
      return renderDiscussionHtml(section)
    case 'topics':
    case 'relationships':
    case 'see_also':
      return renderLinkSectionHtml(LINK_SECTION_TITLES[section.sectionKind] ?? section.heading ?? 'Related', section)
    default:
      return renderDiscussionHtml(section) || ''
  }
}

function renderAbstractHtml(section) {
  const nodes = safeJson(section.contentJson)
  if (Array.isArray(nodes) && nodes.length > 0) {
    return `<p>${renderInlineNodesToHtml(nodes)}</p>`
  }
  if (section.contentText?.trim()) {
    return `<p>${escapeHtml(section.contentText)}</p>`
  }
  return ''
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
      const html = renderContentNodesToHtml(parameter?.content ?? [])
      return `<li><strong>${escapeHtml(parameter?.name ?? 'Value')}</strong>: ${html}</li>`
    })
    : section.contentText?.trim()
      ? section.contentText.trim().split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`)
      : []

  if (items.length === 0) return ''
  return `<section><h2>Parameters</h2><ul>${items.join('')}</ul></section>`
}

function renderDiscussionHtml(section) {
  const heading = section.heading ?? 'Overview'
  const nodes = safeJson(section.contentJson)

  if (Array.isArray(nodes) && nodes.length > 0) {
    // Skip the first heading node if it duplicates the section heading
    const filtered = skipDuplicateHeading(nodes, heading)
    const body = renderContentNodesToHtml(filtered)
    if (!body.trim()) return ''
    return `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`
  }

  // Fallback: render markdown/plain text content as HTML
  if (!section.contentText?.trim()) return ''
  const body = markdownToHtml(section.contentText.trim())
  return `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`
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
          ? `<li><a href="/docs/${escapeHtml(item.key)}/">${escapeHtml(item.title ?? item.key)}</a></li>`
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

// ---------------------------------------------------------------------------
// Structured content → HTML rendering
// ---------------------------------------------------------------------------

function renderContentNodesToHtml(nodes) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(renderBlockNodeToHtml).join('')
}

function renderBlockNodeToHtml(node) {
  if (!node || typeof node !== 'object') return ''

  switch (node.type) {
    case 'paragraph':
      return `<p>${renderInlineNodesToHtml(node.inlineContent ?? [])}</p>`

    case 'heading': {
      const level = Math.min(Math.max(node.level ?? 3, 2), 6)
      const text = node.text ?? renderInlineNodesToHtml(node.inlineContent ?? [])
      const anchor = node.anchor ? ` id="${escapeHtml(node.anchor)}"` : ''
      return `<h${level}${anchor}>${escapeHtml(text)}</h${level}>`
    }

    case 'codeListing': {
      const lang = node.syntax ?? 'swift'
      const code = (node.code ?? []).join('\n')
      return `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`
    }

    case 'unorderedList':
      return `<ul>${(node.items ?? []).map(item =>
        `<li>${renderContentNodesToHtml(item.content ?? [])}</li>`
      ).join('')}</ul>`

    case 'orderedList':
      return `<ol>${(node.items ?? []).map(item =>
        `<li>${renderContentNodesToHtml(item.content ?? [])}</li>`
      ).join('')}</ol>`

    case 'aside': {
      const style = node.style ?? 'Note'
      const inner = renderContentNodesToHtml(node.content ?? [])
      return `<aside><p><strong>${escapeHtml(style)}:</strong></p>${inner}</aside>`
    }

    case 'table': {
      const headerStyle = node.header ?? 'none'
      const rows = node.rows ?? []
      if (rows.length === 0) return ''
      const parts = ['<table>']
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const cells = Array.isArray(row) ? row : (row.cells ?? [])
        const isHeader = (headerStyle === 'row' && i === 0)
          || (headerStyle === 'both' && i === 0)
        const tag = isHeader ? 'th' : 'td'
        const wrapper = isHeader ? 'thead' : (i === 1 && headerStyle !== 'none' ? 'tbody' : '')
        if (wrapper === 'thead') parts.push('<thead>')
        if (wrapper === 'tbody') parts.push('<tbody>')
        parts.push('<tr>')
        for (const cell of cells) {
          const cellContent = renderContentNodesToHtml(cell.content ?? cell ?? [])
          parts.push(`<${tag}>${cellContent}</${tag}>`)
        }
        parts.push('</tr>')
        if (wrapper === 'thead') parts.push('</thead>')
      }
      if (headerStyle !== 'none' && rows.length > 1) parts.push('</tbody>')
      parts.push('</table>')
      return parts.join('')
    }

    case 'links':
      return `<ul>${(node.items ?? []).map(item => {
        if (typeof item === 'object' && item?._resolvedKey) {
          const title = item._resolvedTitle ?? readableNameFromKey(item._resolvedKey)
          return `<li><a href="/docs/${escapeHtml(item._resolvedKey)}/">${escapeHtml(title)}</a></li>`
        }
        const id = typeof item === 'string' ? item : (item?.identifier ?? item?.title ?? '')
        const key = normalizeIdentifier(id)
        if (key) {
          const title = (typeof item === 'object' ? item?._resolvedTitle : null) ?? readableNameFromKey(key)
          return `<li><a href="/docs/${escapeHtml(key)}/">${escapeHtml(title)}</a></li>`
        }
        return `<li>${escapeHtml(typeof item === 'string' ? item : (item?.title ?? ''))}</li>`
      }).join('')}</ul>`

    case 'termList':
      return `<dl>${(node.items ?? []).map(item => {
        const term = item.term ? renderInlineNodesToHtml(item.term.inlineContent ?? []) : ''
        const def = renderContentNodesToHtml(item.definition?.content ?? [])
        return `<dt>${term}</dt><dd>${def}</dd>`
      }).join('')}</dl>`

    default:
      // Inline node appearing at block level — wrap in <p>
      if (node.type === 'text' || node.type === 'codeVoice' || node.type === 'emphasis'
        || node.type === 'strong' || node.type === 'reference' || node.type === 'link') {
        return `<p>${renderInlineNodeToHtml(node)}</p>`
      }
      // Best-effort for unknown block types
      if (Array.isArray(node.content)) {
        return renderContentNodesToHtml(node.content)
      }
      if (Array.isArray(node.inlineContent)) {
        return `<p>${renderInlineNodesToHtml(node.inlineContent)}</p>`
      }
      if (node.text) return `<p>${escapeHtml(node.text)}</p>`
      return ''
  }
}

function renderInlineNodesToHtml(nodes) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(renderInlineNodeToHtml).join('')
}

function renderInlineNodeToHtml(node) {
  if (!node || typeof node !== 'object') return ''

  switch (node.type) {
    case 'text':
      return escapeHtml(node.text ?? '')

    case 'codeVoice':
      return `<code>${escapeHtml(node.code ?? '')}</code>`

    case 'emphasis':
      return `<em>${renderInlineNodesToHtml(node.inlineContent ?? [])}</em>`

    case 'strong':
      return `<strong>${renderInlineNodesToHtml(node.inlineContent ?? [])}</strong>`

    case 'newTerm':
      return `<em>${renderInlineNodesToHtml(node.inlineContent ?? [])}</em>`

    case 'superscript':
      return `<sup>${renderInlineNodesToHtml(node.inlineContent ?? [])}</sup>`

    case 'subscript':
      return `<sub>${renderInlineNodesToHtml(node.inlineContent ?? [])}</sub>`

    case 'strikethrough':
      return `<s>${renderInlineNodesToHtml(node.inlineContent ?? [])}</s>`

    case 'inlineHead':
      return `<strong>${renderInlineNodesToHtml(node.inlineContent ?? [])}</strong>`

    case 'reference': {
      // Use resolved data from normalization, or fall back to extracting from identifier
      const key = node._resolvedKey ?? normalizeIdentifier(node.identifier)
      const title = node._resolvedTitle ?? (key ? readableNameFromKey(key) : (node.identifier ?? ''))
      if (key) {
        return `<a href="/docs/${escapeHtml(key)}/">${escapeHtml(title)}</a>`
      }
      return `<code>${escapeHtml(title)}</code>`
    }

    case 'link': {
      const href = node.destination ?? '#'
      const title = node.title ?? (renderInlineNodesToHtml(node.inlineContent ?? []) || href)
      return `<a href="${escapeHtml(href)}">${typeof title === 'string' ? escapeHtml(title) : title}</a>`
    }

    case 'image': {
      const alt = escapeHtml(node.alt ?? node.title ?? '')
      return `<span>[${alt || 'Image'}]</span>`
    }

    default:
      return escapeHtml(node.text ?? node.code ?? '')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Skip the first heading node if it matches the section heading
 * (prevents "Overview" / "Overview" duplication).
 */
function skipDuplicateHeading(nodes, sectionHeading) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes
  const first = nodes[0]
  if (first.type === 'heading') {
    const headingText = first.text ?? ''
    if (headingText.toLowerCase() === sectionHeading.toLowerCase()) {
      return nodes.slice(1)
    }
  }
  return nodes
}

/**
 * Extract a human-readable name from the last segment of a canonical key.
 * e.g. "swiftui/animation/linear" → "linear"
 */
function readableNameFromKey(key) {
  if (!key) return ''
  const segments = key.split('/')
  const last = segments[segments.length - 1]
  // Convert kebab-case to Title Case
  return last
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function coerceDocument(document) {
  return _coerceDocument(document)
}

function coerceSection(section) {
  return _coerceSection(section, { includeContentJson: true })
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
