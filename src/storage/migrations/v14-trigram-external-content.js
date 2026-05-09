/**
 * v14 — switch documents_trigram to FTS5 external-content backed by the
 * documents table.
 *
 * The v6 migration created documents_trigram as a self-contained FTS5
 * table that stored its own copy of every doc title. Switching to
 * `content='documents'` + `content_rowid='id'` lets FTS5 read titles
 * back from the source table when answering queries — the index keeps
 * its tokenizer state but stops duplicating the column text on disk.
 * On a 350K-doc corpus that's ~30-50 MB of duplicated title bytes
 * eliminated.
 *
 * The trigram column shape (`title`) matches documents.title exactly,
 * so the v6 triggers (which INSERT (rowid, title) on insert/update and
 * DELETE on delete) keep working without modification — FTS5 accepts
 * the same insert/delete API on external-content tables.
 *
 * The sister table documents_fts uses renamed column projections
 * (`abstract`, `declaration`) that don't match documents.abstract_text /
 * documents.declaration_text, so its external-content migration is
 * deferred — would need a coordinated column rename across triggers and
 * the search planner. The v14 win on disk savings stands on its own.
 */
export function up(db) {
  db.run('DROP TABLE IF EXISTS documents_trigram')
  db.run(`CREATE VIRTUAL TABLE documents_trigram USING fts5(
    title,
    content='documents',
    content_rowid='id',
    tokenize='trigram case_sensitive 0'
  )`)
  // Backfill from documents. The post-v6 triggers continue to maintain
  // the index on subsequent writes.
  db.run('INSERT INTO documents_trigram(rowid, title) SELECT id, title FROM documents WHERE title IS NOT NULL')
}
