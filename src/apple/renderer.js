import { normalizeIdentifier } from './normalizer.js'
import { toFrontMatter } from '../lib/yaml.js'

/**
 * Render a full Apple DocC JSON page to Markdown.
 * @param {object} json - The Apple documentation JSON
 * @param {string} canonicalPath - The canonical path of this page (e.g. 'swiftui/view')
 * @returns {string} Complete Markdown document
 */
export function renderPage(json, canonicalPath) {
  const meta = json.metadata ?? {}
  const refs = json.references ?? {}
  const parts = []

  // YAML front matter
  const fm = {
    title: meta.title,
    framework: meta.modules?.[0]?.name,
    role: meta.role,
    role_heading: meta.roleHeading,
    platforms: (meta.platforms ?? []).map(p => p.introducedAt ? `${p.name} ${p.introducedAt}+` : p.name).filter(Boolean),
    path: canonicalPath,
  }
  parts.push(toFrontMatter(fm))
  parts.push('')

  // Title
  if (meta.title) {
    parts.push(`# ${meta.title}`)
    parts.push('')
  }

  // Abstract
  if (json.abstract?.length) {
    parts.push(renderInline(json.abstract, refs, canonicalPath))
    parts.push('')
  }

  // Primary content sections
  for (const section of json.primaryContentSections ?? []) {
    switch (section.kind) {
      case 'declarations':
        parts.push(renderDeclarations(section))
        break
      case 'parameters':
        parts.push(renderParameters(section))
        break
      case 'content':
        parts.push(renderContentNodes(section.content ?? [], refs, canonicalPath))
        break
      case 'mentions':
        // Skip mentions section (it's metadata, not content)
        break
      default:
        // Unknown section kind — render content if present
        if (section.content) {
          parts.push(renderContentNodes(section.content, refs, canonicalPath))
        }
        break
    }
  }

  // Topics
  if (json.topicSections?.length) {
    parts.push('## Topics')
    parts.push('')
    for (const section of json.topicSections) {
      parts.push(renderLinkSection(section, refs, canonicalPath))
    }
  }

  // Relationships
  if (json.relationshipsSections?.length) {
    parts.push('## Relationships')
    parts.push('')
    for (const section of json.relationshipsSections) {
      parts.push(renderLinkSection(section, refs, canonicalPath))
    }
  }

  // See Also
  if (json.seeAlsoSections?.length) {
    parts.push('## See Also')
    parts.push('')
    for (const section of json.seeAlsoSections) {
      parts.push(renderLinkSection(section, refs, canonicalPath))
    }
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// --- Section renderers ---

function renderDeclarations(section) {
  const lines = ['## Declaration', '']
  for (const decl of section.declarations ?? []) {
    const code = (decl.tokens ?? []).map(t => t.text).join('')
    const lang = decl.languages?.[0] ?? 'swift'
    lines.push('```' + lang)
    lines.push(code)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

function renderParameters(section) {
  const lines = ['## Parameters', '']
  for (const param of section.parameters ?? []) {
    const name = param.name ?? ''
    const desc = param.content
      ? param.content.map(n => renderContentNode(n, {}, '')).join(' ').trim()
      : ''
    lines.push(`- \`${name}\`: ${desc}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderLinkSection(section, refs, fromPath) {
  const lines = []
  if (section.title) {
    lines.push(`### ${section.title}`)
    lines.push('')
  }
  for (const id of section.identifiers ?? []) {
    const ref = refs[id]
    const normPath = normalizeIdentifier(id)
    const title = ref?.title ?? normPath ?? id
    if (normPath) {
      const rel = relativePath(fromPath, normPath)
      lines.push(`- [${title}](${rel}.md)`)
    } else {
      lines.push(`- ${title}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

// --- Content node renderers ---

function renderContentNodes(nodes, refs, fromPath) {
  return nodes.map(n => renderContentNode(n, refs, fromPath)).join('\n')
}

function renderContentNode(node, refs, fromPath) {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.inlineContent ?? [], refs, fromPath) + '\n'

    case 'heading':
      return '#'.repeat(node.level ?? 2) + ' ' + (node.text ?? renderInline(node.inlineContent ?? [], refs, fromPath)) + '\n'

    case 'codeListing': {
      const lang = node.syntax ?? ''
      const code = (node.code ?? []).join('\n')
      return '```' + lang + '\n' + code + '\n```\n'
    }

    case 'unorderedList':
      return (node.items ?? []).map(item =>
        renderListItem(item, '- ', refs, fromPath)
      ).join('\n') + '\n'

    case 'orderedList':
      return (node.items ?? []).map((item, i) =>
        renderListItem(item, `${i + 1}. `, refs, fromPath)
      ).join('\n') + '\n'

    case 'aside': {
      const style = node.style ?? 'Note'
      const content = renderContentNodes(node.content ?? [], refs, fromPath).trim()
      return `> **${style}:** ${content}\n`
    }

    case 'table':
      return renderTable(node, refs, fromPath)

    case 'links':
      // Links section: render as list
      return (node.items ?? []).map(id => {
        const ref = refs[id]
        const normPath = normalizeIdentifier(id)
        const title = ref?.title ?? normPath ?? id
        if (normPath) {
          return `- [${title}](${relativePath(fromPath, normPath)}.md)`
        }
        return `- ${title}`
      }).join('\n') + '\n'

    default:
      // Try to render inline content if present
      if (node.inlineContent) {
        return renderInline(node.inlineContent, refs, fromPath) + '\n'
      }
      if (node.content) {
        return renderContentNodes(node.content, refs, fromPath)
      }
      return ''
  }
}

function renderListItem(item, prefix, refs, fromPath) {
  const content = (item.content ?? []).map(n => renderContentNode(n, refs, fromPath)).join('').trim()
  return prefix + content
}

function renderTable(node, refs, fromPath) {
  const rows = node.rows ?? []
  if (rows.length === 0) return ''

  const renderCell = (cell) => {
    return (cell.content ?? []).map(n => renderContentNode(n, refs, fromPath)).join('').trim().replace(/\n/g, ' ')
  }

  const header = rows[0]
  const headerCells = (header.cells ?? header).map?.(c => Array.isArray(c) ? c : c) ?? []
  // Handle both { cells: [...] } format and direct array format
  const getRowCells = (row) => {
    if (Array.isArray(row)) return row
    return row.cells ?? []
  }

  const hCells = getRowCells(rows[0]).map(renderCell)
  const lines = [
    '| ' + hCells.join(' | ') + ' |',
    '| ' + hCells.map(() => '---').join(' | ') + ' |',
  ]

  for (let i = 1; i < rows.length; i++) {
    const cells = getRowCells(rows[i]).map(renderCell)
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  lines.push('')
  return lines.join('\n')
}

// --- Inline content renderer ---

function renderInline(nodes, refs, fromPath) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(node => renderInlineNode(node, refs, fromPath)).join('')
}

function renderInlineNode(node, refs, fromPath) {
  switch (node.type) {
    case 'text':
      return node.text ?? ''

    case 'codeVoice':
      return `\`${node.code ?? ''}\``

    case 'emphasis':
      return `*${renderInline(node.inlineContent ?? [], refs, fromPath)}*`

    case 'strong':
      return `**${renderInline(node.inlineContent ?? [], refs, fromPath)}**`

    case 'newTerm':
      return `**${renderInline(node.inlineContent ?? [], refs, fromPath)}**`

    case 'reference': {
      const ref = refs[node.identifier]
      const title = ref?.title ?? node.identifier ?? ''
      const normPath = normalizeIdentifier(node.identifier ?? ref?.url)
      if (normPath && node.isActive !== false) {
        const rel = relativePath(fromPath, normPath)
        return `[${title}](${rel}.md)`
      }
      return `\`${title}\``
    }

    case 'link':
      return `[${node.title ?? node.destination ?? ''}](${node.destination ?? ''})`

    case 'superscript':
      return renderInline(node.inlineContent ?? [], refs, fromPath)

    case 'subscript':
      return renderInline(node.inlineContent ?? [], refs, fromPath)

    case 'strikethrough':
      return `~~${renderInline(node.inlineContent ?? [], refs, fromPath)}~~`

    case 'inlineHead':
      return `**${renderInline(node.inlineContent ?? [], refs, fromPath)}**`

    case 'image':
      return `![${node.alt ?? ''}](${node.source ?? ''})`

    default:
      return node.text ?? node.code ?? ''
  }
}

// --- Path utilities ---

/**
 * Compute a relative path from one doc to another.
 * Both paths are canonical (e.g. 'swiftui/view', 'swiftui/view/body').
 */
export function relativePath(fromPath, toPath) {
  if (!fromPath || !toPath) return toPath || ''
  if (fromPath === toPath) return toPath.split('/').pop()

  const fromParts = fromPath.split('/')
  const toParts = toPath.split('/')

  // Compare directory-to-directory, then append target filename
  const fromDir = fromParts.slice(0, -1)
  const toDir = toParts.slice(0, -1)
  const toFile = toParts[toParts.length - 1]

  let common = 0
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++
  }

  const parts = []
  for (let i = 0; i < fromDir.length - common; i++) parts.push('..')
  parts.push(...toDir.slice(common))
  parts.push(toFile)

  return parts.join('/')
}
