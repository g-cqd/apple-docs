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

    /// Loads the store, or `nil` when the corpus has no usable vectors. Rows are streamed straight into the packed
    /// buffers, so memory holds the vectors (≈ 59 MiB for the full corpus), never the result set.
    public static func load(from connection: SQLiteConnection) throws(SQLiteError) -> ChunkVectorStore? {
        let chunkCount = (try? connection.queryOne("SELECT COUNT(*) FROM document_chunks")?.integer(at: 0)) ?? 0
        if chunkCount > 0 { return try loadChunks(from: connection, count: Int(chunkCount)) }
        return try loadLegacy(from: connection)
    }

    private static func loadChunks(from connection: SQLiteConnection, count: Int) throws(SQLiteError)
        -> ChunkVectorStore?
    {
        let sampleWidth = try connection.queryOne("SELECT length(vec_bin) FROM document_chunks LIMIT 1")?.integer(at: 0)
        let metaDims = (try? connection.queryOne("SELECT value FROM snapshot_meta WHERE key = 'embed_dims'"))
            .flatMap { try? $0?.text(at: 0) }.flatMap { Int($0) }
        let dimensions = metaDims.flatMap { $0 > 0 ? $0 : nil } ?? Int(sampleWidth ?? 0) * 8
        guard dimensions > 0 else { return nil }
        let width = (dimensions + 7) / 8
        let buffers = try pack(
            "SELECT chunk_id, document_id, vec_bin FROM document_chunks ORDER BY document_id, ord",
            capacity: count,
            width: width,
            withChunkIDs: true,
            on: connection
        )
        guard !buffers.documentIDs.isEmpty else { return nil }
        return ChunkVectorStore(
            mode: .chunk,
            dimensions: dimensions,
            byteWidth: width,
            packed: buffers.packed,
            documentIDs: buffers.documentIDs,
            chunkIDs: buffers.chunkIDs
        )
    }

    private static func loadLegacy(from connection: SQLiteConnection) throws(SQLiteError) -> ChunkVectorStore? {
        let width = 64  // VECTOR_BYTES (512 dimensions)
        guard
            let buffers = try? pack(
                "SELECT 0, document_id, vec FROM document_vectors",
                capacity: 0,
                width: width,
                withChunkIDs: false,
                on: connection
            ), !buffers.documentIDs.isEmpty
        else { return nil }
        return ChunkVectorStore(
            mode: .legacy,
            dimensions: width * 8,
            byteWidth: width,
            packed: buffers.packed,
            documentIDs: buffers.documentIDs,
            chunkIDs: []
        )
    }

    /// Streams `(chunk_id, document_id, bits)` rows of `sql` into packed buffers (rows of another width skipped).
    private static func pack(
        _ sql: String,
        capacity: Int,
        width: Int,
        withChunkIDs: Bool,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> (packed: [UInt8], documentIDs: [Int64], chunkIDs: [Int64]) {
        var packed: [UInt8] = []
        var documentIDs: [Int64] = []
        var chunkIDs: [Int64] = []
        packed.reserveCapacity(capacity * width)
        documentIDs.reserveCapacity(capacity)
        if withChunkIDs { chunkIDs.reserveCapacity(capacity) }
        do {
            try connection.forEachRow(sql) { row in
                guard let bits = try? row.optionalBlob(at: 2), bits.count == width else { return }
                packed.append(contentsOf: bits)
                documentIDs.append(try row.integer(at: 1))
                if withChunkIDs { chunkIDs.append(try row.integer(at: 0)) }
            }
        } catch let error as SQLiteError {
            throw error
        } catch {
            throw .closed
        }
        return (packed, documentIDs, chunkIDs)
    }

    /// Entry `index`'s packed sign bits.
    func bits(at index: Int) -> ArraySlice<UInt8> {
        packed[index * byteWidth ..< (index + 1) * byteWidth]
    }
}
