/**
 * v13 — case-insensitive title index. Hot search/lookup path: exact
 * symbol-title lookups previously scanned the whole documents table on
 * the full corpus.
 */
export function up(db) {
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_title_nocase ON documents(title COLLATE NOCASE)')
}
