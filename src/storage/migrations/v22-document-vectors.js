/**
 * v22 — `document_vectors`: binary-quantized embedding store for the optional
 * hybrid semantic-search tier.
 *
 * One 48-byte BLOB per document (384-bit sign-quantized all-MiniLM-L6-v2
 * embedding of title + abstract + headings). Populated out-of-band by
 * `apple-docs index embeddings` (or baked into the snapshot at build time) —
 * the migration only creates the (empty) table. An empty/absent table means
 * the semantic tier stays dormant and search is purely lexical.
 *
 * Additive and idempotent.
 */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS document_vectors (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    vec         BLOB NOT NULL
  )`)
}
