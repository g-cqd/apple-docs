/**
 * v25 — `document_chunks`: per-chunk embedding store for the body-aware
 * semantic tier.
 *
 * Each document is split into a small set of chunks (chunk 0 = the
 * title/abstract/headings anchor — identical to the old whole-doc embedding —
 * plus heading-aware body chunks from `document_sections`; see
 * search/chunker.js). Per chunk we store the sign-quantized binary code
 * (`vec_bin`, the cheap Hamming shortlist) and an int8 + f32-scale code
 * (`vec_i8`, the rescore stage). `text` is the zstd-compressed chunk source
 * (section-codec) — nullable and droppable on lite snapshots since chunks are
 * regenerable from `document_sections`.
 *
 * `document_vectors` (v22) is deliberately KEPT: the index build also upserts
 * each doc's anchor code there, so old readers and the cheap `getVectorCount()`
 * availability gate keep working. An empty `document_chunks` ⇒ the reader uses
 * the legacy whole-doc path (no forced re-index).
 *
 * Additive and idempotent.
 */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,
    text        BLOB,
    vec_bin     BLOB NOT NULL,
    vec_i8      BLOB,
    UNIQUE(document_id, ord)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id)')
}
