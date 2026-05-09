// DocC relationships extraction. Walks topicSections (child links),
// relationshipsSections (inheritance / conformance), and seeAlsoSections
// to produce the canonical { fromKey, toKey, relationType, section,
// sortOrder } records the storage layer expects.
//
// Pulled out of content/normalize.js as part of Phase B.

import { resolveRefKey } from './refs.js'

const RELATION_TYPE_MAP = {
  inheritsFrom: 'inherits_from',
  conformsTo: 'conforms_to',
  inheritedBy: 'inherited_by',
}

/**
 * @param {object} json   - DocC JSON payload (or normalized intermediate).
 * @param {string} key    - This document's canonical key (the `fromKey`).
 * @param {object} refs   - References map.
 * @param {(k: string) => string} mapKey
 * @returns {Array<{ fromKey: string, toKey: string, relationType: string, section: string|null, sortOrder: number }>}
 */
export function extractDocCRelationships(json, key, refs, mapKey) {
  const relationships = []
  let order = 0

  // Topics → 'child' relations
  for (const section of json?.topicSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const toKey = mapKey(resolveRefKey(id, refs))
      if (toKey) {
        relationships.push({
          fromKey: key, toKey,
          relationType: 'child',
          section: section.title ?? null,
          sortOrder: order++,
        })
      }
    }
  }

  // Relationships sections (inheritance, conformance, inheritedBy)
  for (const section of json?.relationshipsSections ?? []) {
    const relationType = RELATION_TYPE_MAP[section.type] ?? section.type ?? 'related'
    for (const id of section.identifiers ?? []) {
      const toKey = mapKey(resolveRefKey(id, refs))
      if (toKey) {
        relationships.push({
          fromKey: key, toKey,
          relationType,
          section: section.title ?? null,
          sortOrder: order++,
        })
      }
    }
  }

  // See Also → 'see_also' relations
  for (const section of json?.seeAlsoSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const toKey = mapKey(resolveRefKey(id, refs))
      if (toKey) {
        relationships.push({
          fromKey: key, toKey,
          relationType: 'see_also',
          section: section.title ?? null,
          sortOrder: order++,
        })
      }
    }
  }

  return relationships
}
