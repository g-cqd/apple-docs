/**
 * v15 — drop the legacy `refs` table.
 *
 * Background: `refs` predates the `documents` + `document_relationships`
 * pair introduced in v6. v6 already backfilled every refs row into
 * document_relationships, and the only remaining writer
 * (src/pipeline/sync-guidelines.js) duplicated work that the DocC
 * normalizer already records as document_relationships rows.
 *
 * This migration also removes the parallel writes from sync-guidelines
 * at the source-code level (see same commit). Reads went away in
 * Phase B; we drop the table here so future contributors don't reach
 * for it.
 *
 * Note: the broader v15 envisioned in docs/plans/finalization.md also
 * folds `pages` and `document_relationships` into `documents`. Those
 * are deferred — both are deeply integrated working tables (~60 call
 * sites, framework-tree dependent) and warrant their own migration
 * with a real-corpus canary script. Tracked as a follow-up.
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
