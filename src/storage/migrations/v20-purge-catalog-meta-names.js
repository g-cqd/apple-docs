/**
 * v20 — purge catalog meta-entry rows (`symbols`, `year_to_release`)
 * from `sf_symbols`. These names appear at the top of Apple's
 * symbol_categories / symbol_search / name_availability plists as
 * navigation nodes, not real drawable glyphs. They get filtered at
 * ingest time (see `CATALOG_META_NAMES` in
 * `src/resources/apple-symbols/sync.js`), but DBs persisted before
 * that filter shipped still carry the rows and surface them as
 * "fails to render" entries to the prerender + UI layers.
 *
 * Idempotent — deleting non-existent rows is a no-op.
 */

export function up(db) {
  db.run(
    "DELETE FROM sf_symbols WHERE name IN ('symbols', 'year_to_release')",
  )
}
