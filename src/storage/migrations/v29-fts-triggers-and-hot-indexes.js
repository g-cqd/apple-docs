/**
 * v29 — repair external-content trigram maintenance + hot-path index set.
 *
 * 1. Trigram trigger corruption. v14 converted `documents_trigram` to an
 *    external-content FTS5 table (`content='documents'`), but the v6 triggers
 *    kept the plain `DELETE FROM documents_trigram WHERE rowid = …` form.
 *    For external-content tables that form computes the postings to remove by
 *    reading the CURRENT content row — already rewritten in AFTER UPDATE and
 *    already gone in AFTER DELETE — so old-title postings were never removed:
 *    renamed documents kept matching their old titles and the index grew
 *    monotonically. Repro-verified. The fix is the canonical command form
 *    (`INSERT INTO documents_trigram(documents_trigram, rowid, title)
 *    VALUES('delete', old.id, old.title)`), plus a one-time 'rebuild' to
 *    purge the garbage accumulated since v14. `documents_fts` is NOT external
 *    content, so its plain DELETE stays.
 *
 *    The rewritten UPDATE trigger also gains a WHEN guard: only fire when an
 *    FTS-indexed column actually changed. Without it, every USR/platform
 *    backfill and every no-op upsert (COALESCE resolving to the old value)
 *    paid a full postings delete+insert in both FTS tables.
 *
 * 2. Index rationalization (v21 precedent, verified against the live DB):
 *      - `idx_documents_key` duplicates the UNIQUE autoindex on documents.key
 *        (~25-30 MB of b-tree maintained on every one of 373k+ writes).
 *      - `idx_pages_title` / `idx_pages_role`: all title/role queries moved to
 *        `documents` in v6; the v4 trigram backfill that read them was dropped
 *        in v21. Zero remaining consumers.
 *      - `idx_pages_status`: status is ~100% 'active', and EXPLAIN QUERY PLAN
 *        shows the planner choosing it for `status='active'` scans — turning a
 *        table scan into an index scan plus 360k+ rowid lookups (measured
 *        ~0.7 s per adapter per update). Worse than no index.
 *      - `crawl_state` gains the index it always needed: `getPendingCrawl` and
 *        `getCrawlStats` run per crawl batch and were full 360k-row scans
 *        (EQP: `SCAN crawl_state`). Partial index on the pending rows keeps
 *        write amplification near zero at steady state (the set is empty).
 *
 * Idempotent — DROP/CREATE guarded with IF EXISTS / IF NOT EXISTS; the
 * trigram rebuild only runs when the table exists (lite snapshots ship
 * without it) and is safe to repeat.
 */
export function up(db) {
  // 1. Rewrite the FTS maintenance triggers.
  db.run('DROP TRIGGER IF EXISTS documents_au')
  db.run('DROP TRIGGER IF EXISTS documents_ad')

  const hasFts = tableExists(db, 'documents_fts')
  const hasTrigram = tableExists(db, 'documents_trigram')

  if (hasFts || hasTrigram) {
    db.run(`
      CREATE TRIGGER documents_au AFTER UPDATE ON documents
      WHEN old.title IS NOT new.title
        OR old.abstract_text IS NOT new.abstract_text
        OR old.declaration_text IS NOT new.declaration_text
        OR old.headings IS NOT new.headings
        OR old.key IS NOT new.key
      BEGIN
        ${hasFts ? `
        DELETE FROM documents_fts WHERE rowid = old.id;
        INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
        VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);` : ''}
        ${hasTrigram ? `
        INSERT INTO documents_trigram(documents_trigram, rowid, title) VALUES ('delete', old.id, old.title);
        INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);` : ''}
      END
    `)
    db.run(`
      CREATE TRIGGER documents_ad AFTER DELETE ON documents
      BEGIN
        ${hasFts ? 'DELETE FROM documents_fts WHERE rowid = old.id;' : ''}
        ${hasTrigram ? "INSERT INTO documents_trigram(documents_trigram, rowid, title) VALUES ('delete', old.id, old.title);" : ''}
      END
    `)
  }

  // One-time purge of the phantom postings the broken triggers left behind.
  if (hasTrigram) {
    db.run("INSERT INTO documents_trigram(documents_trigram) VALUES ('rebuild')")
  }

  // Per-root index ETag for the update phase's HEAD-check gate: a 304 on
  // Apple's /tutorials/data/index/<slug> skips every per-page check under
  // that root.
  try { db.run('ALTER TABLE roots ADD COLUMN index_etag TEXT') } catch { /* re-run */ }

  // 2. Index set.
  db.run('DROP INDEX IF EXISTS idx_documents_key')
  db.run('DROP INDEX IF EXISTS idx_pages_title')
  db.run('DROP INDEX IF EXISTS idx_pages_role')
  db.run('DROP INDEX IF EXISTS idx_pages_status')
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_crawl_root_status
    ON crawl_state(root_slug, status)
  `)
}

function tableExists(db, name) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}
