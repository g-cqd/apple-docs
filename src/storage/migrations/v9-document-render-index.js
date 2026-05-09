/** v9 — render-index table backing the incremental web-build cache. */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS document_render_index (
    doc_id           INTEGER PRIMARY KEY,
    sections_digest  TEXT    NOT NULL,
    template_version TEXT    NOT NULL,
    html_hash        TEXT    NOT NULL,
    updated_at       INTEGER NOT NULL
  )`)
}
