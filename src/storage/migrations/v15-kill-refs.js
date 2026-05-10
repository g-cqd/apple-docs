/**
 * v15 — drop the legacy `refs` table.
 *
 * Background: `refs` predates the `documents` + `document_relationships`
 * pair introduced in v6. v6 already backfilled every refs row into
 * document_relationships, and the only remaining writer
 * (src/pipeline/sync-guidelines.js) duplicated work that the DocC
 * normalizer already records as document_relationships rows.
 *
 * The parallel writes from sync-guidelines were removed alongside this
 * migration so the table can go without leaving callers behind.
 */
export function up(db) {
  // Drop dependent indexes first; SQLite will drop them with the table
  // anyway but explicit DROP avoids surprises when this runs against a
  // partially-migrated DB (e.g., a manual rollback that left an index
  // alone).
  db.run('DROP INDEX IF EXISTS idx_refs_source')
  db.run('DROP INDEX IF EXISTS idx_refs_target')
  db.run('DROP TABLE IF EXISTS refs')
}
