// Chunk-vector reads for the native semantic tier (Stage 1). Mirrors the Bun
// chunks repo (src/storage/repos/chunks.js) query-for-query so the native
// candidate retrieval is bit-identical:
//   getChunkCount    -> SELECT COUNT(*) FROM document_chunks
//   getAllChunkVectors -> SELECT chunk_id, document_id, vec_bin FROM document_chunks
//                         ORDER BY document_id, ord        (the load-bearing row order)
//   getChunkI8Batch  -> SELECT chunk_id, vec_i8 FROM document_chunks WHERE chunk_id IN (…),
//                       batched at 500 ids (the SQLite bound-parameter ceiling)
//   getVectorCount   -> SELECT COUNT(*) FROM document_vectors   (the legacy availability gate)
// Read style follows ReadDoc.swift / Taxonomy.swift: conn.prepareUncached +
// PreparedStatement step/int/blob. Additive — no existing ADStorage file changes.

extension StorageConnection {
    /// `SELECT COUNT(*) FROM document_chunks` — 0 ⇒ the chunk path is dormant
    /// (the legacy `document_vectors` path would be tried). Mirrors
    /// chunks.getChunkCount (without the JS memo; one read per call).
    public func getChunkCount() -> Int {
        guard let stmt = conn.prepareUncached("SELECT COUNT(*) FROM document_chunks"),
            stmt.step() == SQLite.row
        else { return 0 }
        return Int(stmt.int(0) ?? 0)
    }

    /// `SELECT COUNT(*) FROM document_vectors` — the legacy whole-doc store size,
    /// the cheap semantic-availability gate (`getVectorCount() > 0 || getChunkCount() > 0`).
    /// Mirrors search.getVectorCount.
    public func getVectorCount() -> Int {
        guard let stmt = conn.prepareUncached("SELECT COUNT(*) FROM document_vectors"),
            stmt.step() == SQLite.row
        else { return 0 }
        return Int(stmt.int(0) ?? 0)
    }

    /// All chunk binary codes in the exact `ORDER BY document_id, ord` the JS
    /// reader uses — the array index of each returned row is the downstream
    /// Hamming tie-break key, so this order is load-bearing and must not change.
    /// Rows whose `vec_bin` is NULL are dropped (the column is NOT NULL in the
    /// live schema; the guard matches the JS `r.vec_bin` truthiness filter).
    public func getAllChunkVectors() -> [(chunkId: Int, documentId: Int, vecBin: [UInt8])] {
        let sql = "SELECT chunk_id, document_id, vec_bin FROM document_chunks ORDER BY document_id, ord"
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        var out: [(chunkId: Int, documentId: Int, vecBin: [UInt8])] = []
        while stmt.step() == SQLite.row {
            guard let chunkId = stmt.int(0), let documentId = stmt.int(1), let vecBin = stmt.blob(2)
            else { continue }
            out.append((chunkId: Int(chunkId), documentId: Int(documentId), vecBin: vecBin))
        }
        return out
    }

    /// The snapshot's embedding width: the `embed_dims` snapshot_meta value when
    /// it parses to a positive integer, else `fallback`. Mirrors the JS
    /// `readDims` (`getSnapshotMeta('embed_dims')` → parseInt → finite & > 0).
    /// The native side uses `Int(_:)` (strict), which is the common case here
    /// (the value is a bare integer string); a non-integer meta falls back like
    /// the JS NaN guard.
    public func getEmbedDims(fallback: Int) -> Int {
        guard
            let stmt = conn.prepareUncached("SELECT value FROM snapshot_meta WHERE key = 'embed_dims'"),
            stmt.step() == SQLite.row, let value = stmt.text(0), let n = Int(value), n > 0
        else { return fallback }
        return n
    }

    /// int8 rescore codes for a shortlist in one round-trip per batch:
    /// `chunk_id → vec_i8`. Batched at 500 ids (the JS `i += 500` slice) to stay
    /// under SQLite's bound-parameter ceiling; NULL `vec_i8` rows are skipped
    /// (the JS `if (r.vec_i8)` filter). Mirrors chunks.getChunkI8Batch.
    public func getChunkI8Batch(_ ids: [Int]) -> [Int: [UInt8]] {
        var out: [Int: [UInt8]] = [:]
        var start = 0
        while start < ids.count {
            let end = min(start + 500, ids.count)
            let batch = ids[start ..< end]
            let placeholders = Array(repeating: "?", count: batch.count).joined(separator: ",")
            let sql = "SELECT chunk_id, vec_i8 FROM document_chunks WHERE chunk_id IN (\(placeholders))"
            if let stmt = conn.prepareUncached(sql) {
                var index: Int32 = 1
                for id in batch {
                    stmt.bindInt64(index, Int64(id))
                    index += 1
                }
                while stmt.step() == SQLite.row {
                    guard let chunkId = stmt.int(0), let vecI8 = stmt.blob(1) else { continue }
                    out[Int(chunkId)] = vecI8
                }
            }
            start = end
        }
        return out
    }
}
