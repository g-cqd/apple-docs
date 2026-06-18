/**
 * v22 — `document_vectors`: binary-quantized embedding store for the optional
 * hybrid semantic-search tier.
 *
 * One BLOB per document (sign-quantized embedding of title + abstract +
 * headings — currently 64 bytes / 512-bit model2vec; older snapshots hold
 * 48-byte / 384-bit MiniLM codes, which the reader skips as width-mismatched).
 * The column is width-agnostic; `search/embedding.js` owns the live size.
 * Populated out-of-band by
 * `apple-docs index embeddings` (or baked into the snapshot at build time) —
 * the migration only creates the (empty) table. An empty/absent table means
 * the semantic tier stays dormant and search is purely lexical.
 *
 * Additive and idempotent.
 */
/** @param {import('bun:sqlite').Database} db */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS document_vectors (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    vec         BLOB NOT NULL
  )`)
}
