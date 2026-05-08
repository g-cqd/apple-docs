import { normalizeIdentifier } from './normalizer.js'

// Identifiers with this prefix point to symbols defined outside the current
// framework (Swift stdlib, other modules). Apple renders a link with a `url`
// field but doesn't serve a real DocC JSON page for them, so fetching 404s.
const EXTERNAL_ID_PREFIX = 'doc://com.externally.resolved.symbol/'

/**
 * Extract all referenced documentation paths from an Apple JSON doc page.
 * Prefers the `url` field from the references map over raw identifiers,
 * since some identifiers use nested paths while the actual page is at a different URL.
 * Returns an array of normalized identifier strings.
 */
export function extractReferences(json) {
  const ids = new Set()
  const refs = json.references ?? {}

  // Helper: resolve an identifier to its best URL using the references map.
  // Returns null for externally-resolved symbols, which have no DocC JSON page.
  const resolve = (id) => {
    if (typeof id === 'string' && id.startsWith(EXTERNAL_ID_PREFIX)) return null
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

  // Catch-all for cross-references that aren't part of any structured section
  // (topicSections / relationshipsSections / seeAlsoSections). Apple's
  // references map carries one entry per inline mention in the body, so this
  // sweep picks up legitimate links to other pages elsewhere in the corpus.
  //
  // It also picks up Apple's stale duplicate entries: when a child symbol gets
  // promoted to a standalone page (e.g. AppStoreServerAPI/hasMore), the
  // references map keeps the old nested URL for backwards compatibility
  // (AppStoreServerAPI/NotificationHistoryResponse/hasMore) but Apple stopped
  // publishing the data file, so following the URL 404s. Empirically the
  // ghost entries always have an empty `abstract` while genuine cross-refs
  // carry real prose — use that as the signal to skip them.
  for (const [id, ref] of Object.entries(refs)) {
    if (id.startsWith(EXTERNAL_ID_PREFIX)) continue
    if (ref.type !== 'topic') continue
    if (!ref.url?.includes('/documentation/')) continue
    const abstract = ref.abstract
    if (!Array.isArray(abstract) || abstract.length === 0) continue
    const norm = normalizeIdentifier(ref.url)
    if (norm) ids.add(norm)
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
