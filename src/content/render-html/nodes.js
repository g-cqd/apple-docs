// DocC content-node → HTML rendering. Walks the structured `contentJson`
// representation that normalize.js produces and emits the corresponding
// HTML tree. Block and inline node handlers live in the same module
// because they call into each other through every level.
//
// Pulled out of content/render-html.js as part of Phase B.

import { normalizeIdentifier } from '../../apple/normalizer.js'
import { highlightCode } from '../highlight.js'
import { escapeHtml, isSafeHref, readableNameFromKey, resolveReferenceUrl } from './helpers.js'

export function renderContentNodesToHtml(nodes) {
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
        `<li>${renderContentNodesToHtml(item.content ?? [])}</li>`,
      ).join('')}</ul>`

    case 'orderedList':
      return `<ol>${(node.items ?? []).map(item =>
        `<li>${renderContentNodesToHtml(item.content ?? [])}</li>`,
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

export function renderInlineNodesToHtml(nodes) {
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
      const refUrl = resolveReferenceUrl(node.identifier)
      if (refUrl) {
        const displayTitle = title || refUrl.title
        return `<a href="${escapeHtml(refUrl.href)}">${escapeHtml(displayTitle)}</a>`
      }
      return `<code>${escapeHtml(title || node.identifier || '')}</code>`
    }

    case 'link': {
      // Prefer the corpus-internal route when normalize.js mapped the destination
      // (e.g. https://developer.apple.com/library/archive/... → apple-archive/...)
      // so the user stays on this site.
      const internalKey = node._resolvedKey
      const rawHref = internalKey ? `/docs/${internalKey}/` : (node.destination ?? '#')
      const href = isSafeHref(rawHref) ? rawHref : '#'
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
