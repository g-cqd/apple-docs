/**
 * Roots repository: documentation root rows + the page_count maintenance
 * helper. Schema lives in migrations/v1-initial-schema.js.
 *
 * `upsertRoot` derives source_type from the slug + kind via
 * deriveRootSourceType so callers don't have to track the canonical map.
 */

import { deriveRootSourceType } from '../source-types.js'

/** @param {import('bun:sqlite').Database} db */
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
    /**
     * @param {string} slug @param {string} displayName @param {string} kind @param {string} source
     * @param {string | null} [seedPath] @param {string | null} [sourceType]
     */
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
    /** @param {string | null} [kind] */
    getRoots(kind = null) {
      return kind ? getByKindStmt.all(kind) : getAllStmt.all()
    },
    /** @param {string} slug */
    getRootBySlug(slug) {
      return getBySlugStmt.get(slug)
    },
    /** @param {number} id */
    getRootById(id) {
      return getByIdStmt.get(id)
    },
    /** Resolve by exact slug, then case-insensitive slug match, then
     *  case-insensitive display_name contains, then slug substring. */
    /** @param {string} input */
    resolveRoot(input) {
      const exact = getBySlugStmt.get(input)
      if (exact) return exact
      const lower = input.toLowerCase()
      const all = getAllStmt.all()
      return (
        all.find((r) => r.slug.toLowerCase() === lower) ??
        all.find((r) => r.display_name.toLowerCase().includes(lower)) ??
        all.find((r) => r.slug.includes(lower)) ??
        null
      )
    },
    /** @param {string} slug */
    updateRootPageCount(slug) {
      updatePageCountStmt.run(slug)
    },
  }
}
