// Render DocC block + inline content nodes to plain text. Mirrors the
// shape consumed by extractor.js but additionally walks the references
// map so reference titles surface in the rendered output.

import { normalizeIdentifier } from '../../apple/normalizer.js'

export function renderContentNodesToText(nodes, refs) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(node => renderNode(node, refs)).join('')
}

function renderNode(node, refs) {
  if (!node || typeof node !== 'object') return ''

  switch (node.type) {
    case 'paragraph':
      return `${renderInlineNodes(node.inlineContent ?? [], refs)}\n`

    case 'heading': {
      const text = node.text ?? renderInlineNodes(node.inlineContent ?? [], refs)
      return `${text ?? ''}\n`
    }

    case 'codeListing':
      return `${(node.code ?? []).join('\n')}\n`

    case 'unorderedList':
    case 'orderedList':
      return (node.items ?? [])
        .map(item => renderContentNodesToText(item.content ?? [], refs))
        .join('')

    case 'aside': {
      const style = node.style ?? 'Note'
      const inner = renderContentNodesToText(node.content ?? [], refs).trim()
      return `${style}: ${inner}\n`
    }

    case 'table': {
      const rows = node.rows ?? []
      return `${rows
        .map(row => {
          const cells = Array.isArray(row) ? row : (row.cells ?? [])
          return cells
            .map(cell => renderContentNodesToText(cell.content ?? [], refs).trim())
            .join(' | ')
        })
        .join('\n')}\n`
    }

    case 'links':
      return `${(node.items ?? [])
        .map(id => {
          const ref = refs?.[id]
          return ref?.title ?? normalizeIdentifier(id) ?? id
        })
        .join('\n')}\n`

    case 'text':
      return node.text ?? ''

    case 'codeVoice':
      return node.code ?? ''

    case 'emphasis':
    case 'strong':
    case 'newTerm':
    case 'inlineHead':
    case 'superscript':
    case 'subscript':
    case 'strikethrough':
      return renderInlineNodes(node.inlineContent ?? [], refs)

    case 'reference': {
      const ref = refs?.[node.identifier]
      return ref?.title ?? node.title ?? node.identifier ?? ''
    }

    case 'link':
      return node.title ?? node.destination ?? ''

    default:
      // Best-effort: try text, code, then recurse into inlineContent / content
      if (node.text) return node.text
      if (node.code) return String(node.code)
      if (Array.isArray(node.inlineContent)) {
        return renderInlineNodes(node.inlineContent, refs)
      }
      if (Array.isArray(node.content)) {
        return renderContentNodesToText(node.content, refs)
      }
      return ''
  }
}

/**
 * Render an array of inline nodes to plain text.
 * Mirrors the logic in extractor.js but also handles reference lookups.
 */
export function renderInlineNodes(nodes, refs) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return node.text ?? ''
      case 'codeVoice': return node.code ?? ''
      case 'emphasis':
      case 'strong':
      case 'newTerm':
      case 'inlineHead':
      case 'superscript':
      case 'subscript':
      case 'strikethrough':
        return renderInlineNodes(node.inlineContent ?? [], refs)
      case 'reference': {
        const ref = refs?.[node.identifier]
        return ref?.title ?? node.title ?? node.identifier ?? ''
      }
      case 'link': return node.title ?? node.destination ?? ''
      default: return node.text ?? node.code ?? ''
    }
  }).join('')
}
