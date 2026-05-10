// References resolution. DocC ships a flat `references` map keyed by
// identifier; downstream code needs three things:
//   1. Resolve an identifier to a corpus key (`resolveRefKey`).
//   2. Project link sections into resolved-title shape for storage.
//   3. Walk every content node and decorate references with their title
//      + key so the render layer doesn't re-resolve per node.

import { normalizeIdentifier } from '../../apple/normalizer.js'
import { mapUrlToKey } from '../../lib/link-resolver.js'

const identity = (v) => v

/**
 * Resolve a DocC identifier to its canonical corpus key.
 *
 * Tries three sources in order:
 *   1. The references map's `url` field via `normalizeIdentifier` (handles
 *      relative paths like `/documentation/swiftui/view`).
 *   2. The references map's `url` field via `mapUrlToKey` (handles absolute
 *      URLs like `https://developer.apple.com/library/archive/...` or
 *      `https://developer.apple.com/videos/play/wwdc2024/10001` — anything
 *      our cross-source link rules know about).
 *   3. The identifier itself via `normalizeIdentifier`.
 */
export function resolveRefKey(id, refs) {
  const ref = refs?.[id]
  if (ref?.url) {
    const norm = normalizeIdentifier(ref.url)
    if (norm) return norm
    // Full https URL — try the cross-source pattern map. This is what catches
    // archive guide refs, WWDC video refs, and swift.org/docs.swift.org refs
    // that DocC emits as external links instead of `doc://` identifiers.
    const mapped = mapUrlToKey(ref.url)
    if (mapped) return mapped
  }
  return normalizeIdentifier(id)
}

/**
 * Render an array of link-section objects (topicSections / seeAlsoSections)
 * to a plain-text string: section title, then referenced doc titles, newline-separated.
 */
export function renderLinkSectionsToText(sections, refs) {
  const lines = []
  for (const section of sections ?? []) {
    if (section.title) lines.push(section.title)
    for (const id of section.identifiers ?? []) {
      const ref = refs?.[id]
      const title = ref?.title ?? normalizeIdentifier(id) ?? id
      if (title) lines.push(title)
    }
  }
  return lines.join('\n') || null
}

export function normalizeLinkSections(sections, refs, mapKey = identity) {
  return (sections ?? []).map(section => ({
    title: section.title ?? null,
    type: section.type ?? null,
    items: (section.identifiers ?? []).map(id => {
      const ref = refs?.[id]
      return {
        identifier: id,
        key: mapKey(resolveRefKey(id, refs)),
        title: ref?.title ?? normalizeIdentifier(id) ?? id,
      }
    }),
  }))
}

/**
 * Deep-clone content nodes and resolve all reference identifiers to include
 * human-readable titles and canonical keys for HTML rendering.
 */
export function resolveContentReferences(nodes, refs, mapKey = identity) {
  if (!Array.isArray(nodes)) return nodes
  return nodes.map(node => resolveNodeRefs(node, refs, mapKey))
}

function resolveNodeRefs(node, refs, mapKey = identity) {
  if (!node || typeof node !== 'object') return node

  // Reference inline node — embed title and key
  if (node.type === 'reference') {
    const ref = refs?.[node.identifier]
    const key = mapKey(resolveRefKey(node.identifier, refs))
    const title = ref?.title ?? node.title ?? null
    return { ...node, _resolvedTitle: title, _resolvedKey: key }
  }

  // Links block node — resolve each item identifier
  if (node.type === 'links' && Array.isArray(node.items)) {
    const resolvedItems = node.items.map(id => {
      const ref = refs?.[id]
      const key = mapKey(resolveRefKey(id, refs))
      const title = ref?.title ?? null
      return { identifier: id, _resolvedTitle: title, _resolvedKey: key }
    })
    return { ...node, items: resolvedItems }
  }

  // Inline `link` node — DocC emits these for free-form anchors like
  // `<a href="https://developer.apple.com/...">`. The destination is a raw
  // URL with no `_resolvedKey`; check whether it maps to a corpus key so the
  // render layer can emit `/docs/<key>/` directly when present.
  if (node.type === 'link' && typeof node.destination === 'string') {
    const candidate = mapUrlToKey(node.destination)
    if (candidate) {
      const key = mapKey(candidate)
      if (key) return { ...node, _resolvedKey: key }
    }
  }

  // Recurse into child content
  const clone = { ...node }
  if (Array.isArray(clone.inlineContent)) {
    clone.inlineContent = clone.inlineContent.map(child => resolveNodeRefs(child, refs, mapKey))
  }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map(child => resolveNodeRefs(child, refs, mapKey))
  }
  if (Array.isArray(clone.items)) {
    clone.items = clone.items.map(item => {
      if (item?.content) return { ...item, content: item.content.map(child => resolveNodeRefs(child, refs, mapKey)) }
      return item
    })
  }
  // Term list items
  if (node.type === 'termList' && Array.isArray(clone.items)) {
    clone.items = clone.items.map(item => {
      const resolved = { ...item }
      if (resolved.term?.inlineContent) {
        resolved.term = { ...resolved.term, inlineContent: resolved.term.inlineContent.map(child => resolveNodeRefs(child, refs, mapKey)) }
      }
      if (resolved.definition?.content) {
        resolved.definition = { ...resolved.definition, content: resolved.definition.content.map(child => resolveNodeRefs(child, refs, mapKey)) }
      }
      return resolved
    })
  }
  return clone
}
