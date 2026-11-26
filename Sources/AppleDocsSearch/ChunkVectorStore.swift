public import AppleDocsStorage

/// The binary vector index Bun's semantic tier scans (`search/semantic.js` `loadVectors`): chunk vectors
/// (`document_chunks.vec_bin`, ordered by document then chunk) when present, else legacy per-document vectors.
public final class ChunkVectorStore: Sendable {
    public enum Mode: Sendable { case chunk, legacy }

    public let mode: Mode
    public let dimensions: Int
    public let byteWidth: Int
    /// Row-major packed sign bits, `byteWidth` bytes per entry.
    let packed: [UInt8]
    let documentIDs: [Int64]
    /// Chunk row ids (chunk mode) for the int8 rescoring lookup.
    let chunkIDs: [Int64]

    public var count: Int { documentIDs.count }

    private init(mode: Mode, dimensions: Int, byteWidth: Int, packed: [UInt8], documentIDs: [Int64], chunkIDs: [Int64])
    {
        self.mode = mode
        self.dimensions = dimensions
        self.byteWidth = byteWidth
        self.packed = packed
        self.documentIDs = documentIDs
        self.chunkIDs = chunkIDs
    }

    /// Loads the store, or `nil` when the corpus has no usable vectors.
    public static func load(from connection: SQLiteConnection) throws(SQLiteError) -> ChunkVectorStore? {
        let chunkCount = (try? connection.queryOne("SELECT COUNT(*) FROM document_chunks")?.integer(at: 0)) ?? 0
        if chunkCount > 0 { return try loadChunks(from: connection) }
        return try loadLegacy(from: connection)
    }

    private static func loadChunks(from connection: SQLiteConnection) throws(SQLiteError) -> ChunkVectorStore? {
        let rows = try connection.query(
            "SELECT chunk_id, document_id, vec_bin FROM document_chunks ORDER BY document_id, ord"
        )
        guard let sample = rows.lazy.compactMap({ try? $0.optionalBlob(at: 2) }).first else { return nil }
        let metaDims = (try? connection.queryOne("SELECT value FROM snapshot_meta WHERE key = 'embed_dims'"))
            .flatMap { try? $0?.text(at: 0) }.flatMap { Int($0) }
        let dimensions = metaDims.flatMap { $0 > 0 ? $0 : nil } ?? sample.count * 8
        let width = (dimensions + 7) / 8
        let (packed, documentIDs, chunkIDs) = try pack(
            rows,
            width: width,
            blobColumn: 2,
            documentColumn: 1,
            chunkColumn: 0
        )
        guard !documentIDs.isEmpty else { return nil }
        return ChunkVectorStore(
            mode: .chunk,
            dimensions: dimensions,
            byteWidth: width,
            packed: packed,
            documentIDs: documentIDs,
            chunkIDs: chunkIDs
        )
    }

    private static func loadLegacy(from connection: SQLiteConnection) throws(SQLiteError) -> ChunkVectorStore? {
        let width = 64  // VECTOR_BYTES (512 dimensions)
        guard let rows = try? connection.query("SELECT document_id, vec FROM document_vectors") else { return nil }
        let (packed, documentIDs, _) = try pack(
            rows,
            width: width,
            blobColumn: 1,
            documentColumn: 0,
            chunkColumn: nil
        )
        guard !documentIDs.isEmpty else { return nil }
        return ChunkVectorStore(
            mode: .legacy,
            dimensions: width * 8,
            byteWidth: width,
            packed: packed,
            documentIDs: documentIDs,
            chunkIDs: []
        )
    }

    /// Concatenates every row's `width`-byte bit vector (rows with another width are skipped).
    private static func pack(
        _ rows: [SQLiteRow],
        width: Int,
        blobColumn: Int,
        documentColumn: Int,
        chunkColumn: Int?
    ) throws(SQLiteError) -> (packed: [UInt8], documentIDs: [Int64], chunkIDs: [Int64]) {
        var packed: [UInt8] = []
        packed.reserveCapacity(rows.count * width)
        var documentIDs: [Int64] = []
        var chunkIDs: [Int64] = []
        documentIDs.reserveCapacity(rows.count)
        for row in rows {
            guard let bits = try? row.optionalBlob(at: blobColumn), bits.count == width else { continue }
            packed.append(contentsOf: bits)
            documentIDs.append(try row.integer(at: documentColumn))
            if let chunkColumn { chunkIDs.append(try row.integer(at: chunkColumn)) }
        }
        return (packed, documentIDs, chunkIDs)
    }

    /// Entry `index`'s packed sign bits.
    func bits(at index: Int) -> ArraySlice<UInt8> {
        packed[index * byteWidth ..< (index + 1) * byteWidth]
    }
}
