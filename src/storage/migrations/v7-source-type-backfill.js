/**
 * v7 — backfill source_type on roots/pages/documents from the canonical
 * slug→source map. Runs after v5 (which only handled the design/hig and
 * guidelines cases) so the rest of the multi-source roots get tagged.
 */

import { ROOT_SOURCE_TYPE_BY_SLUG } from '../source-types.js'

export function up(db) {
  for (const [slug, sourceType] of ROOT_SOURCE_TYPE_BY_SLUG) {
    db.run('UPDATE roots SET source_type = ? WHERE slug = ?', [sourceType, slug])
    db.run(`
      UPDATE pages
      SET source_type = ?
      WHERE root_id IN (SELECT id FROM roots WHERE slug = ?)
    `, [sourceType, slug])
    db.run(`
      UPDATE documents
      SET source_type = ?
      WHERE key = ? OR key LIKE ?
    `, [sourceType, slug, `${slug}/%`])
  }
}
