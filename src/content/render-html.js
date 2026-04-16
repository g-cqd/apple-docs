import { coerceDocument as _coerceDocument, coerceSection as _coerceSection } from './coercion.js'
import { normalizeIdentifier } from '../apple/normalizer.js'
import { highlightCode } from './highlight.js'

const LINK_SECTION_TITLES = {
  topics: 'Topics',
  relationships: 'Relationships',
  see_also: 'See Also',
}

/**
 * Generate a URL-safe slug from heading text.
 * e.g. "See Also" → "see-also", "Overview" → "overview"
 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function renderHtml(document, sections = [], opts = {}) {
  const doc = coerceDocument(document)
  const orderedSections = sections
    .map(coerceSection)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const parts = []

  if (doc.title) {
    parts.push(`<h1>${escapeHtml(doc.title)}</h1>`)
  }

  for (const section of orderedSections) {
    const rendered = renderSectionHtml(section, opts)
    if (rendered) parts.push(rendered)
  }

  return parts.join('\n').trim()
}

function renderSectionHtml(section, opts = {}) {
  switch (section.sectionKind) {
    case 'abstract':
      return renderAbstractHtml(section)
    case 'declaration':
      return renderDeclarationHtml(section, opts)
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

function renderDeclarationHtml(section, opts = {}) {
  const declarations = safeJson(section.contentJson)
  const blocks = Array.isArray(declarations) ? declarations : []
  const knownKeys = opts.knownKeys
  const snippets = blocks
    .map(declaration => {
      const tokens = declaration?.tokens ?? []
      if (tokens.length === 0) return null
      const hasTypeLinks = knownKeys && tokens.some(t =>
        t._resolvedKey && (t.kind === 'typeIdentifier' || t.kind === 'attribute'))
      if (hasTypeLinks) {
        return renderDeclarationTokens(tokens, knownKeys)
      }
      // Fall back to Shiki for declarations without type link data
      const code = tokens.map(t => t.text ?? '').join('').trim()
      const language = declaration?.languages?.[0] ?? 'swift'
      if (!code) return null
      const highlighted = highlightCode(code, language)
      return highlighted ?? `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`
    })
    .filter(Boolean)

  if (snippets.length === 0 && section.contentText?.trim()) {
    const highlighted = highlightCode(section.contentText.trim(), 'swift')
    snippets.push(highlighted ?? `<pre><code class="language-swift">${escapeHtml(section.contentText.trim())}</code></pre>`)
  }

  if (snippets.length === 0) return ''
  return `<section id="declaration"><h2>Declaration</h2>${snippets.join('')}</section>`
}

/**
 * Render declaration tokens with semantic CSS classes and type links.
 * Used when tokens have resolved type references for interactive navigation.
 */
function renderDeclarationTokens(tokens, knownKeys) {
  const spans = tokens.map(token => {
    const text = escapeHtml(token.text ?? '')
    if (!text) return ''
    const kind = token.kind ?? 'text'

    // Link resolved types to their documentation pages
    if (token._resolvedKey && (kind === 'typeIdentifier' || kind === 'attribute')) {
      if (knownKeys.has(token._resolvedKey)) {
        return `<a href="/docs/${escapeHtml(token._resolvedKey)}/" class="code-type-link"><span class="decl-${kind}">${text}</span></a>`
      }
    }

    // Map token kinds to CSS classes
    switch (kind) {
      case 'keyword':
      case 'attribute':
        return `<span class="decl-keyword">${text}</span>`
      case 'typeIdentifier':
        return `<span class="decl-type">${text}</span>`
      case 'identifier':
        return `<span class="decl-identifier">${text}</span>`
      case 'genericParameter':
        return `<span class="decl-generic">${text}</span>`
      case 'externalParam':
      case 'internalParam':
        return `<span class="decl-param">${text}</span>`
      case 'number':
        return `<span class="decl-number">${text}</span>`
      default:
        return text
    }
  })
  return `<pre class="decl-tokens"><code>${spans.join('')}</code></pre>`
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
  return `<section id="parameters"><h2>Parameters</h2><ul>${items.join('')}</ul></section>`
}

function renderDiscussionHtml(section) {
  const heading = section.heading ?? 'Overview'
  const sectionId = slugify(heading)
  const nodes = safeJson(section.contentJson)

  if (Array.isArray(nodes) && nodes.length > 0) {
    // Skip the first heading node if it duplicates the section heading
    const filtered = skipDuplicateHeading(nodes, heading)
    const body = renderContentNodesToHtml(filtered)
    if (!body.trim()) return ''
    return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2>${body}</section>`
  }

  // Fallback: render markdown/plain text content as HTML
  if (!section.contentText?.trim()) return ''
  const body = markdownToHtml(section.contentText.trim())
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2>${body}</section>`
}

function renderLinkSectionHtml(title, section) {
  const sectionId = slugify(title)
  const groups = safeJson(section.contentJson)
  const body = []

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        body.push(`<h3>${escapeHtml(group.title)}</h3>`)
      }
      const items = (group?.items ?? [])
        .map(item => {
          const filterAttr = item?._resolvedRoleHeading
            ? ` data-filter-kind="${escapeHtml(item._resolvedRoleHeading)}"`
            : ''
          return item?.key
            ? `<li${filterAttr}><a href="/docs/${escapeHtml(item.key)}/">${escapeHtml(item.title ?? item.key)}</a></li>`
            : `<li>${escapeHtml(item?.title ?? item?.identifier ?? '')}</li>`
        })
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
  return `<section id="${sectionId}"><h2>${escapeHtml(title)}</h2>${body.join('')}</section>`
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
      const highlighted = highlightCode(code, lang)
      return highlighted ?? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`
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
        // Try external URL / video reference
        const refUrl = resolveReferenceUrl(id)
        if (refUrl) {
          const title = (typeof item === 'object' ? item?._resolvedTitle : null) ?? refUrl.title
          return `<li><a href="${escapeHtml(refUrl.href)}">${escapeHtml(title)}</a></li>`
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
      const title = node._resolvedTitle ?? (key ? readableNameFromKey(key) : null)
      if (key) {
        return `<a href="/docs/${escapeHtml(key)}/">${escapeHtml(title)}</a>`
      }
      // External URL references — render as clickable links
      const refUrl = resolveReferenceUrl(node.identifier)
      if (refUrl) {
        const displayTitle = title || refUrl.title
        return `<a href="${escapeHtml(refUrl.href)}">${escapeHtml(displayTitle)}</a>`
      }
      return `<code>${escapeHtml(title || node.identifier || '')}</code>`
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

// ---------------------------------------------------------------------------
// Lightweight markdown → HTML converter (for Swift Book, WWDC, Swift Evolution)
// ---------------------------------------------------------------------------

function markdownToHtml(md) {
  if (!md) return ''

  // Strip stray XML declarations/processing instructions
  const cleaned = md.replace(/<\?[^?]*\?>/g, '').trim()
  if (!cleaned) return ''

  const lines = cleaned.split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Blank line — skip
    if (line.trim() === '') { i++; continue }

    // HTML comment — skip entirely
    if (line.trim().startsWith('<!--')) {
      // Consume until closing -->
      let comment = line
      while (!comment.includes('-->') && i + 1 < lines.length) {
        i++
        comment += '\n' + lines[i]
      }
      i++
      continue
    }

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})(\w*)/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2] || 'swift'
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      const fencedCode = codeLines.join('\n')
      const highlighted = highlightCode(fencedCode, lang)
      out.push(highlighted ?? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(fencedCode)}</code></pre>`)
      continue
    }

    // ATX Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 1, 6) // bump by 1 since h2 is section heading
      out.push(`<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const quoteLines = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${markdownToHtml(quoteLines.join('\n'))}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^[\-\*\+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[\-\*\+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-\*\+]\s+/, ''))
        i++
      }
      out.push(`<ul>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\d+[\.\)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+[\.\)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[\.\)]\s+/, ''))
        i++
      }
      out.push(`<ol>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`)
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines = []
    while (i < lines.length && lines[i].trim() !== '' &&
      !lines[i].match(/^(`{3,}|~{3,})/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^>\s/) &&
      !lines[i].match(/^[\-\*\+]\s+/) &&
      !lines[i].match(/^\d+[\.\)]\s+/) &&
      !lines[i].match(/^[-*_]{3,}\s*$/) &&
      !lines[i].trim().startsWith('<!--')) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      out.push(`<p>${inlineMarkdown(paraLines.join(' '))}</p>`)
    }
  }

  return out.join('')
}

/**
 * Convert inline markdown syntax to HTML.
 */
function inlineMarkdown(text) {
  // Pre-process: convert <doc:PageName> and <doc:PageName#Section> references before escaping
  let pre = text.replace(/<doc:([^>#]+)(?:#([^>]+))?>/g, (_match, page, section) => {
    const displayName = section
      ? `${page.replace(/-/g, ' ')} — ${section.replace(/-/g, ' ')}`
      : page.replace(/-/g, ' ')
    // Link to a search-friendly path — use the page name as the last segment
    return `[${displayName}](/docs/swift-book/?q=${encodeURIComponent(page)})`
  })

  let s = escapeHtml(pre)
  // Images: ![alt](url) — render alt text only (no images in docs)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt) => alt ? `<em>[${alt}]</em>` : '')
  // Remove empty image/link brackets: ![] or []
  s = s.replace(/!\[\]/g, '')
  s = s.replace(/\[\]\([^)]*\)/g, '')
  s = s.replace(/\[\]/g, '')
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // Bold+italic: ***text*** or ___text___
  s = s.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
  s = s.replace(/_{3}(.+?)_{3}/g, '<strong><em>$1</em></strong>')
  // Bold: **text** or __text__
  s = s.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
  s = s.replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')
  // Italic: *text* or _text_ (avoid matching underscores inside words)
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>')
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return s
}

/**
 * Resolve a reference identifier to an external URL when normalizeIdentifier fails.
 * Handles https:// URLs, video doc:// refs, and other non-documentation references.
 * @returns {{ href: string, title: string } | null}
 */
function resolveReferenceUrl(identifier) {
  if (!identifier) return null

  // Direct https:// or http:// URL
  if (/^https?:\/\//.test(identifier)) {
    // Extract readable title from URL
    const url = identifier.replace(/\/+$/, '')
    const lastSegment = url.split('/').pop() || url
    const title = lastSegment
      .replace(/[-_]/g, ' ')
      .replace(/\.\w+$/, '') // strip file extensions
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    return { href: identifier, title: title || identifier }
  }

  // doc:// video references: doc://com.apple.documentation/videos/play/wwdc2025/281
  const videoMatch = identifier.match(/doc:\/\/[^/]+\/videos\/play\/(\w+)\/(\d+)/)
  if (videoMatch) {
    const event = videoMatch[1].toUpperCase()
    const sessionId = videoMatch[2]
    return {
      href: `https://developer.apple.com/videos/play/${videoMatch[1]}/${sessionId}/`,
      title: `${event} Session ${sessionId}`,
    }
  }

  // doc:// with non-documentation paths (e.g. tutorials, videos)
  const docNonDocMatch = identifier.match(/doc:\/\/[^/]+\/(.+)/)
  if (docNonDocMatch) {
    const path = docNonDocMatch[1]
    return {
      href: `https://developer.apple.com/${path}`,
      title: readableNameFromKey(path),
    }
  }

  return null
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
