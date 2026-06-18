// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * v23 — `document_raw`: the raw upstream Apple DocC payloads, zstd-compressed,
 * one BLOB per document.
 *
 * document_sections is DERIVED from these payloads; shipping them inside the
 * single snapshot DB (compressed) keeps the snapshot one artifact while still
 * enabling on-device re-normalization (hydrate) and the raw-render fallback —
 * without leaving ~5 GB of loose files on disk. `storage materialize raw-json`
 * unpacks them to files when an operator actually wants them.
 *
 * Empty/absent table → readers fall back to document_sections (no raw needed
 * for reading or search). Additive and idempotent.
 */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS document_raw (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    raw         BLOB NOT NULL
  )`)
}
