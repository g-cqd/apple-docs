/**
 * Roots repository: documentation root rows + the page_count maintenance
 * helper. Schema lives in migrations/v1-initial-schema.js.
 *
 * `upsertRoot` derives source_type from the slug + kind via
 * deriveRootSourceType so callers don't have to track the canonical map.
 */

import { deriveRootSourceType } from '../source-types.js'

export function createRootsRepo(db) {
  const upsertStmt = db.query(`
    INSERT INTO roots (slug, display_name, kind, status, source, seed_path, source_type, first_seen, last_seen)
    VALUES ($slug, $display_name, $kind, 'active', $source, $seed_path, $source_type, $now, $now)
    ON CONFLICT(slug) DO UPDATE SET
      display_name = $display_name,
      kind = CASE WHEN excluded.kind != 'unknown' THEN excluded.kind ELSE roots.kind END,
      seed_path = COALESCE($seed_path, roots.seed_path),
      last_seen = $now,
      source = $source,
      source_type = COALESCE($source_type, roots.source_type)
    RETURNING id
  `)
  const getAllStmt = db.query('SELECT * FROM roots ORDER BY slug')
  const getByKindStmt = db.query('SELECT * FROM roots WHERE kind = ? ORDER BY slug')
  const getBySlugStmt = db.query('SELECT * FROM roots WHERE slug = ?')
  const getByIdStmt = db.query('SELECT * FROM roots WHERE id = ?')
  const updatePageCountStmt = db.query(
    "UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages WHERE root_id = roots.id AND status = 'active') WHERE slug = ?",
  )

  return {
    upsertRoot(slug, displayName, kind, source, seedPath = null, sourceType = null) {
      return upsertStmt.get({
        $slug: slug,
        $display_name: displayName,
        $kind: kind,
        $source: source,
        $seed_path: seedPath,
        $source_type: sourceType ?? deriveRootSourceType(slug, kind),
        $now: new Date().toISOString(),
      })
    },
    getRoots(kind = null) {
      return kind ? getByKindStmt.all(kind) : getAllStmt.all()
    },
    getRootBySlug(slug) {
      return getBySlugStmt.get(slug)
    },
    getRootById(id) {
      return getByIdStmt.get(id)
    },
    /** Resolve by exact slug, then case-insensitive slug match, then
     *  case-insensitive display_name contains, then slug substring. */
    resolveRoot(input) {
      const exact = getBySlugStmt.get(input)
      if (exact) return exact
      const lower = input.toLowerCase()
      const all = getAllStmt.all()
      return all.find(r => r.slug.toLowerCase() === lower)
        ?? all.find(r => r.display_name.toLowerCase().includes(lower))
        ?? all.find(r => r.slug.includes(lower))
        ?? null
    },
    updateRootPageCount(slug) {
      updatePageCountStmt.run(slug)
    },
  }
}
