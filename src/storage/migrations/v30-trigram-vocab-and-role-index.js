/**
 * v30 — fuzzy-tier trigram vocabulary + two small index rationalizations.
 *
 * 1. `documents_trigram_vocab`: an fts5vocab('row') companion over
 *    `documents_trigram`. Zero storage — it is a virtual view over the FTS
 *    index's own term dictionary. The fuzzy tier uses it to rank the query's
 *    trigrams by document frequency and OR only the rarest few: previously a
 *    20-char query ORed ~18 trigrams and FTS5 had to union enormous posting
 *    lists ("ion", "ing", …) across 690k titles per fuzzy query.
 *
 * 2. `idx_documents_role_sample`: partial index for the sample-code
 *    adapter's discovery query (`WHERE role = 'sampleCode'`), which was an
 *    EQP-verified full documents scan (~1.3 s) once per sync. Partial keeps
 *    write amplification negligible (a few thousand rows).
 *
 * 3. Drop `idx_sections_kind` (v6): no query filters on section_kind alone —
 *    pure write amplification on a 1.1M-row table.
 *
 * Idempotent — IF EXISTS / IF NOT EXISTS throughout; the vocab table is only
 * created when the trigram table exists (lite snapshots ship without it).
 */
export function up(db) {
  const hasTrigram = !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents_trigram'")
    .get()
  if (hasTrigram) {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram_vocab
      USING fts5vocab(documents_trigram, 'row')
    `)
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_documents_role_sample
    ON documents(role) WHERE role = 'sampleCode'
  `)
  db.run('DROP INDEX IF EXISTS idx_sections_kind')
}
