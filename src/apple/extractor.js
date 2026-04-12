import { normalizeIdentifier } from './normalizer.js'

/**
 * Extract all referenced documentation paths from an Apple JSON doc page.
 * Prefers the `url` field from the references map over raw identifiers,
 * since some identifiers use nested paths while the actual page is at a different URL.
 * Returns an array of normalized identifier strings.
 */
export function extractReferences(json) {
  const ids = new Set()
  const refs = json.references ?? {}

  // Helper: resolve an identifier to its best URL using the references map
  const resolve = (id) => {
    const ref = refs[id]
    // Prefer the url field — it points to the actual page path
    if (ref?.url) {
      const norm = normalizeIdentifier(ref.url)
      if (norm) return norm
    }
    // Fall back to normalizing the identifier directly
    return normalizeIdentifier(id)
  }

  // topicSections[].identifiers
  for (const section of json.topicSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const norm = resolve(id)
      if (norm) ids.add(norm)
    }
  }

  // relationshipsSections[].identifiers
  for (const section of json.relationshipsSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const norm = resolve(id)
      if (norm) ids.add(norm)
    }
  }

  // seeAlsoSections[].identifiers
  for (const section of json.seeAlsoSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const norm = resolve(id)
      if (norm) ids.add(norm)
    }
  }

  // references that are documentation topics (catch any not in sections)
  for (const [key, ref] of Object.entries(refs)) {
    if (ref.type === 'topic' && ref.url?.includes('/documentation/')) {
      const norm = normalizeIdentifier(ref.url)
      if (norm) ids.add(norm)
    }
  }

  return [...ids]
}

/**
 * Extract page metadata from Apple JSON.
 * Returns { title, role, roleHeading, abstract, platforms, declaration }.
 */
export function extractMetadata(json) {
  const meta = json.metadata ?? {}

  const title = meta.title ?? null
  const role = meta.role ?? null
  const roleHeading = meta.roleHeading ?? null

  // Render abstract inline content to plain text
  const abstract = renderInlineToText(json.abstract ?? [])

  // Platforms
  const platforms = (meta.platforms ?? []).map(p => {
    const name = p.name ?? ''
    const intro = p.introducedAt ?? ''
    return intro ? `${name} ${intro}+` : name
  }).filter(Boolean)

  // Declaration: from primaryContentSections where kind === 'declarations'
  let declaration = null
  for (const section of json.primaryContentSections ?? []) {
    if (section.kind === 'declarations') {
      const decl = section.declarations?.[0]
      if (decl?.tokens) {
        declaration = decl.tokens.map(t => t.text).join('')
      }
      break
    }
  }

  return { title, role, roleHeading, abstract, platforms, declaration }
}

/**
 * Render an array of inline content nodes to plain text.
 */
export function renderInlineToText(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null

  return nodes.map(node => {
    switch (node.type) {
      case 'text': return node.text ?? ''
      case 'codeVoice': return node.code ?? ''
      case 'emphasis': return renderInlineToText(node.inlineContent ?? []) ?? ''
      case 'strong': return renderInlineToText(node.inlineContent ?? []) ?? ''
      case 'reference': return node.title ?? node.identifier ?? ''
      case 'newTerm': return renderInlineToText(node.inlineContent ?? []) ?? ''
      case 'inlineHead': return renderInlineToText(node.inlineContent ?? []) ?? ''
      default: return node.text ?? node.code ?? ''
    }
  }).join('')
}
