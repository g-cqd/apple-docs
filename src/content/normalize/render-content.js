// Render DocC block + inline content nodes to plain text. Mirrors the
// shape consumed by extractor.js but additionally walks the references
// map so reference titles surface in the rendered output.

import { normalizeIdentifier } from '../../apple/normalizer.js'

// Hard cap on DocC node-tree recursion depth. Mirrors the Swift renderer, whose walk is bounded by
// ADJSON's `parse(maxDepth: 512)` (see ADContent/PageMarkdown.swift): beyond 512 nested levels a
// subtree renders as empty instead of overflowing the call stack on hostile/malformed input. Real
// Apple payloads are ≲ 10 levels, so the cap never triggers on real data and JS↔Swift stays byte-identical.
const MAX_RENDER_DEPTH = 512

export function renderContentNodesToText(nodes, refs, depth = 0) {
  if (!Array.isArray(nodes) || depth > MAX_RENDER_DEPTH) return ''
  return nodes.map((node) => renderNode(node, refs, depth)).join('')
}

function renderNode(node, refs, depth) {
  if (!node || typeof node !== 'object') return ''

  switch (node.type) {
    case 'paragraph':
      return `${renderInlineNodes(node.inlineContent ?? [], refs, depth + 1)}\n`

    case 'heading': {
      const text = node.text ?? renderInlineNodes(node.inlineContent ?? [], refs, depth + 1)
      return `${text ?? ''}\n`
    }

    case 'codeListing':
      return `${(node.code ?? []).join('\n')}\n`

    case 'unorderedList':
    case 'orderedList':
      return (node.items ?? []).map((item) => renderContentNodesToText(item.content ?? [], refs, depth + 1)).join('')

    case 'aside': {
      const style = node.style ?? 'Note'
      const inner = renderContentNodesToText(node.content ?? [], refs, depth + 1).trim()
      return `${style}: ${inner}\n`
    }

    case 'table': {
      const rows = node.rows ?? []
      return `${rows
        .map((row) => {
          const cells = Array.isArray(row) ? row : (row.cells ?? [])
          return cells.map((cell) => renderContentNodesToText(cell.content ?? [], refs, depth + 1).trim()).join(' | ')
        })
        .join('\n')}\n`
    }

    case 'links':
      return `${(node.items ?? [])
        .map((id) => {
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
      return renderInlineNodes(node.inlineContent ?? [], refs, depth + 1)

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
        return renderInlineNodes(node.inlineContent, refs, depth + 1)
      }
      if (Array.isArray(node.content)) {
        return renderContentNodesToText(node.content, refs, depth + 1)
      }
      return ''
  }
}

/**
 * Render an array of inline nodes to plain text.
 * Mirrors the logic in extractor.js but also handles reference lookups.
 */
export function renderInlineNodes(nodes, refs, depth = 0) {
  if (!Array.isArray(nodes) || depth > MAX_RENDER_DEPTH) return ''
  return nodes
    .map((node) => {
      switch (node.type) {
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
          return renderInlineNodes(node.inlineContent ?? [], refs, depth + 1)
        case 'reference': {
          const ref = refs?.[node.identifier]
          return ref?.title ?? node.title ?? node.identifier ?? ''
        }
        case 'link':
          return node.title ?? node.destination ?? ''
        default:
          return node.text ?? node.code ?? ''
      }
    })
    .join('')
}
