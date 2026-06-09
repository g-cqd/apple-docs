/**
 * Chunk-vector repository (v25): persistence for the body-aware semantic index.
 *
 * Each document is split into chunks (search/chunker.js); per chunk we store a
 * sign-quantized binary code (`vec_bin`, the Hamming shortlist) and an int8 +
 * f32-scale code (`vec_i8`, the rescore stage). The reader keeps only the small
 * binary codes resident and pulls each shortlisted chunk's int8 code on demand,
 * so RAM stays near the legacy whole-doc footprint even though int8 ≈ 8× the
 * bytes on disk. An empty table ⇒ the reader falls back to the legacy
 * `document_vectors` path (no forced re-index).
 *
 * The table is created by migration v25, which always runs before this repo is
 * built, so the statements prepare unconditionally.
 */

import { safeCall } from '../../lib/safe-call.js'

export function createChunksRepo(db) {
  const countStmt = db.query('SELECT COUNT(*) AS c FROM document_chunks')
  const allBinStmt = db.query('SELECT chunk_id, document_id, vec_bin FROM document_chunks ORDER BY document_id, ord')
  const i8ByIdStmt = db.query('SELECT vec_i8 FROM document_chunks WHERE chunk_id = ?')
  const upsertStmt = db.query(
    'INSERT OR REPLACE INTO document_chunks(document_id, ord, text, vec_bin, vec_i8) VALUES ($doc, $ord, $text, $bin, $i8)',
  )
  const deleteByDocStmt = db.query('DELETE FROM document_chunks WHERE document_id = ?')

  return {
    /** Row count of the per-chunk vector table; 0 ⇒ legacy whole-doc path. */
    getChunkCount() {
      return safeCall(() => countStmt.get().c, { default: 0, log: 'warn-once', label: 'chunks.count' })
    },
    /** All chunk binary codes: `[{ chunk_id, document_id, vec_bin }]` (doc/ord order). */
    getAllChunkVectors() {
      return safeCall(() => allBinStmt.all(), { default: [], log: 'warn-once', label: 'chunks.allVectors' })
    },
    /** A single chunk's int8 code (rescore stage); null when absent. */
    getChunkI8(chunkId) {
      const row = safeCall(() => i8ByIdStmt.get(chunkId), { default: null, log: 'warn-once', label: 'chunks.i8' })
      return row?.vec_i8 ?? null
    },
    /** Upsert one chunk's codes (keyed on document_id+ord). */
    upsertChunk({ documentId, ord, text = null, vecBin, vecI8 = null }) {
      upsertStmt.run({ $doc: documentId, $ord: ord, $text: text, $bin: vecBin, $i8: vecI8 })
    },
    /** Drop every chunk of a document (re-index / delete path). */
    deleteChunksByDocId(documentId) {
      deleteByDocStmt.run(documentId)
    },
  }
}
