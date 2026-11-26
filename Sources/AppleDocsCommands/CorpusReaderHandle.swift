public import AppleDocsStorage

/// Shared pooled read-only corpus handle used by both `AppleDocsMCP` and `AppleDocsWeb`.
///
/// Owns a bounded ``SQLiteReaderPool`` and provides a single helper for running short read-only
/// ``CorpusStore`` queries off the cooperative executor without duplicating pool lifecycle code.
public final class CorpusReaderHandle: Sendable {
    public let databasePath: String
    public let pool: SQLiteReaderPool

    public init(databasePath: String, maxReaders: Int = 4) {
        self.databasePath = databasePath
        self.pool = SQLiteReaderPool(path: databasePath, maxReaders: maxReaders)
    }

    /// Runs a read-only ``SQLiteConnection`` closure on a pooled connection.
    public func withConnection<T: Sendable>(
        _ body: @escaping @Sendable (SQLiteConnection) throws -> T
    ) async throws -> T {
        try await pool.withConnection(body)
    }

    /// Runs a read-only ``CorpusStore`` closure on a detached task.
    public func withStore<T: Sendable>(
        _ body: @escaping @Sendable (CorpusStore) throws -> T
    ) async throws -> T {
        let path = databasePath
        return
            try await Task.detached {
                let store = try CorpusStore(path: path, options: .readOnly)
                defer { store.close() }
                return try body(store)
            }
            .value
    }

    /// Closes all pooled SQLite reader connections.
    public func close() async {
        await pool.close()
    }
}
