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
  let countMemo // undefined = unread; busted by the write paths below + resetCountCache
  const allBinStmt = db.query('SELECT chunk_id, document_id, vec_bin FROM document_chunks ORDER BY document_id, ord')
  const upsertStmt = db.query(
    'INSERT OR REPLACE INTO document_chunks(document_id, ord, text, vec_bin, vec_i8) VALUES ($doc, $ord, $text, $bin, $i8)',
  )
  const deleteByDocStmt = db.query('DELETE FROM document_chunks WHERE document_id = ?')

  return {
    /** Row count of the per-chunk vector table; 0 ⇒ legacy whole-doc path.
     *  Memoized (§10(B)); the writes below bust it. */
    getChunkCount() {
      if (countMemo === undefined) {
        countMemo = safeCall(() => countStmt.get().c, { default: 0, log: 'warn-once', label: 'chunks.count' })
      }
      return countMemo
    },
    /** Bust the memoized chunk count (after a re-embed via a non-repo path). */
    resetCountCache() {
      countMemo = undefined
    },
    /** All chunk binary codes: `[{ chunk_id, document_id, vec_bin }]` (doc/ord order). */
    getAllChunkVectors() {
      return safeCall(() => allBinStmt.all(), { default: [], log: 'warn-once', label: 'chunks.allVectors' })
    },
    /** int8 codes for a shortlist in one round-trip: Map chunk_id → vec_i8.
     *  Batched at 500 ids to stay under SQLite's bound-parameter ceiling. */
    getChunkI8Batch(chunkIds) {
      const out = new Map()
      for (let i = 0; i < chunkIds.length; i += 500) {
        const ids = chunkIds.slice(i, i + 500)
        const rows = safeCall(
          () => db.query(`SELECT chunk_id, vec_i8 FROM document_chunks WHERE chunk_id IN (${ids.map(() => '?').join(',')})`).all(...ids),
          { default: [], log: 'warn-once', label: 'chunks.i8Batch' },
        )
        for (const r of rows) if (r.vec_i8) out.set(r.chunk_id, r.vec_i8)
      }
      return out
    },
    /** Upsert one chunk's codes (keyed on document_id+ord). */
    upsertChunk({ documentId, ord, text = null, vecBin, vecI8 = null }) {
      upsertStmt.run({ $doc: documentId, $ord: ord, $text: text, $bin: vecBin, $i8: vecI8 })
      countMemo = undefined
    },
    /** Drop every chunk of a document (re-index / delete path). */
    deleteChunksByDocId(documentId) {
      deleteByDocStmt.run(documentId)
      countMemo = undefined
    },
  }
}
