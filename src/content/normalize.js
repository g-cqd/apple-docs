// Top-level normalizer dispatch. The DocC and guidelines normalizers
// both produce the canonical { document, sections, relationships } shape;
// this module routes raw payloads to the right one based on sourceType.
//
// The DocC implementation lives in normalize/docc.js, guidelines in
// normalize/guidelines.js, with the shared helpers split into
// normalize/{render-content,refs,metadata}.js.

import { normalizeDocC } from './normalize/docc.js'
import { normalizeGuidelines } from './normalize/guidelines.js'

export { renderContentNodesToText } from './normalize/render-content.js'

/**
 * Normalize a raw Apple DocC (or guidelines) payload into a canonical document
 * model suitable for database insertion and search indexing.
 *
 * @param {any} rawPayload - Raw JSON/object payload as fetched or parsed.
 * @param {string} key        - Canonical path key, e.g. 'swiftui/view'.
 * @param {string} sourceType - One of: 'apple-docc', 'hig', 'guidelines', 'swift-docc'.
 * @param {any} [opts]
 * @returns {{ document: any, sections: any[], relationships: any[] }}
 */
export function normalize(rawPayload, key, sourceType, opts = {}) {
  if (sourceType === 'guidelines') {
    return normalizeGuidelines(rawPayload, key)
  }
  // 'apple-docc', 'hig', and 'swift-docc' share the same DocC JSON format
  return normalizeDocC(rawPayload, key, sourceType, opts)
}
