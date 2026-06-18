// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * v21 — drop the dead legacy `pages` FTS subsystem and the redundant
 * `document_relationships` indexes.
 *
 * Two independent rationalizations, both verified against the live corpus:
 *
 *   1. Legacy pages FTS. `pages_fts`, `titles_trigram`, and `pages_body_fts`
 *      were superseded by the `documents_*` FTS tables in v6. Nothing outside
 *      the migrations reads them anymore (the live search path uses
 *      `documents_fts` / `documents_trigram` / `documents_body_fts`), yet the
 *      `pages_ai/ad/au` triggers still maintain `pages_fts` + `titles_trigram`
 *      on every `pages` upsert — pure write-amplification during sync for
 *      indexes no query touches. We drop the triggers and the three tables.
 *      `pages` itself stays: it is the crawl/transport ledger (etag, status,
 *      404 counts) and is JOINed by `documents`.
 *
 *   2. Redundant relationship indexes. `document_relationships` declares
 *      `UNIQUE(from_key, to_key, relation_type)` (v6), whose auto-index
 *      (`sqlite_autoindex_document_relationships_1`) has `from_key` as its
 *      leftmost column and therefore already serves every hot `from_key`
 *      lookup (browse / topics / tree-view). Verified with EXPLAIN QUERY PLAN
 *      on the live DB: forcing that auto-index resolves `from_key = ?` as a
 *      COVERING search, so `idx_rel_from` is redundant. `idx_rel_to` only
 *      backs cold paths (reverse-delete `WHERE from_key=? OR to_key=?` and the
 *      integrity check), so it goes too.
 *
 * Reclaims ~270 MB on the full corpus, but NOT in-band: dropping objects is a
 * fast metadata operation, whereas VACUUM rewrites the whole file under an
 * exclusive lock and would stall a live hosted instance. Freed pages are
 * returned to the OS at the next `snapshot build` (VACUUM INTO + VACUUM) or a
 * manual off-peak `storage gc --vacuum`.
 *
 * Idempotent — every statement guards with IF EXISTS.
 */
export function up(db) {
  // 1. Legacy pages FTS subsystem.
  // Drop the maintenance triggers first so a subsequent `pages` write can't
  // reference an already-dropped FTS table. These triggers exist solely to
  // mirror pages rows into pages_fts / titles_trigram (v4); pages needs no
  // FTS sync once those tables are gone.
  db.run('DROP TRIGGER IF EXISTS pages_ai')
  db.run('DROP TRIGGER IF EXISTS pages_ad')
  db.run('DROP TRIGGER IF EXISTS pages_au')
  // Dropping each FTS5 virtual table also drops its shadow tables
  // (_data / _idx / _docsize / _config / _content).
  db.run('DROP TABLE IF EXISTS pages_fts')
  db.run('DROP TABLE IF EXISTS titles_trigram')
  db.run('DROP TABLE IF EXISTS pages_body_fts')

  // 2. Redundant document_relationships indexes (the UNIQUE auto-index
  // covers from_key; idx_rel_to only backs cold maintenance paths).
  db.run('DROP INDEX IF EXISTS idx_rel_from')
  db.run('DROP INDEX IF EXISTS idx_rel_to')
}
