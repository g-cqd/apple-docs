/**
 * Build checkpoint helpers — section batching, render-fingerprint digest,
 * and the template-version stamp used to invalidate the per-doc render
 * index when the chrome surface changes.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256 } from '../../lib/hash.js'

export function batchFetchSections(db, docIds, chunkSize) {
  const result = new Map()
  for (let i = 0; i < docIds.length; i += chunkSize) {
    const chunk = docIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.db.query(
      `SELECT document_id, section_kind, heading, content_text, content_json, sort_order
       FROM document_sections
       WHERE document_id IN (${placeholders})
       ORDER BY document_id, sort_order, id`
    ).all(...chunk)
    for (const row of rows) {
      let arr = result.get(row.document_id)
      if (!arr) {
        arr = []
        result.set(row.document_id, arr)
      }
      arr.push(row)
    }
  }
  return result
}

/**
 * Cheap fingerprint of a doc's sections for the incremental skip path. We
 * deliberately don't hash the full content — only the shape (kinds + lengths)
 * — because the goal is "did this doc change since the render was cached?",
 * not "is the rendered HTML byte-identical?". A full content hash would more
 * than double the per-doc CPU cost during the digest phase, which is hot.
 */
export function computeSectionsDigest(sections) {
  if (!sections || sections.length === 0) return 'empty'
  const parts = []
  for (const s of sections) {
    parts.push(s.section_kind)
    parts.push(String((s.content_text ?? '').length))
    const json = s.content_json
    parts.push(typeof json === 'string' ? String(json.length) : json ? '1' : '0')
    parts.push(String(s.sort_order ?? 0))
  }
  return sha256(parts.join('|')).slice(0, 16)
}

/**
 * Hash of the template surface — bumping any of these files invalidates the
 * render index. Keep the list tight: anything that contributes HTML output
 * during `renderDocumentPage` must be included.
 *
 * Previously the path resolution was wrong (joined from
 * `src/web/build/` instead of from `src/web/`), so the template-version
 * stamp silently hashed three `missing:…` strings instead of the
 * actual file bytes. The spine refactor in commits 49f9eae and
 * d8b342f split the rendering pipeline across `templates.js`,
 * `templates/*.js`, and `lib/html.js`; this list now mirrors that.
 */
export function computeTemplateVersion() {
  // import.meta.url here is .../src/web/build/checkpoint.js; templates
  // live one directory up under src/web/.
  const webDir = join(dirname(new URL(import.meta.url).pathname), '..')
  const files = [
    join(webDir, 'templates.js'),
    join(webDir, 'lib', 'html.js'),
    join(webDir, 'templates', 'document.js'),
    join(webDir, 'templates', '_doc-content.js'),
    join(webDir, 'templates', 'framework.js'),
    join(webDir, 'templates', 'index-page.js'),
    join(webDir, 'templates', 'search.js'),
    join(webDir, 'templates', 'fonts.js'),
    join(webDir, 'templates', 'symbols.js'),
    join(webDir, 'templates', 'not-found.js'),
    join(webDir, '..', 'content', 'render-html.js'),
    join(webDir, 'assets', 'style.css'),
  ]
  const hasher = new Bun.CryptoHasher('sha256')
  for (const f of files) {
    try {
      hasher.update(readFileSync(f))
    } catch {
      // file missing — fold its absence into the hash so a removed file still
      // rotates the version
      hasher.update(`missing:${f}`)
    }
  }
  return hasher.digest('hex').slice(0, 16)
}

/**
 * Run a synchronous render inside a `Promise.race` against a hard timeout.
 * The render is wrapped in `Promise.resolve().then(...)` so that if it throws
 * we get a rejected promise rather than an uncaught synchronous error. The
 * timer is cleared on either path to keep the event loop tidy.
 */
