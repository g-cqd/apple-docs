import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsStorage
import Foundation

/// Shared pooled read-only corpus handle used by both `AppleDocsMCP` and `AppleDocsWeb`.
///
/// Owns a bounded ``SQLiteReaderPool`` and lazily loads optional semantic search resources
/// (``Model2VecEmbedder`` + ``SemanticCorpusIndex``) when a local model directory and
/// `document_vectors` table are present, degrading cleanly to lexical-only search otherwise.
public final class CorpusReaderHandle: Sendable {
    public let databasePath: String
    public let resourcesDirectory: String
    public let pool: SQLiteReaderPool
    private let semanticLoader: SemanticStateActor

    public init(
        databasePath: String,
        resourcesDirectory: String? = nil,
        maxReaders: Int = 4
    ) {
        self.databasePath = databasePath
        self.resourcesDirectory = resourcesDirectory ?? CorpusPaths.defaultResourcesDirectory()
        self.pool = SQLiteReaderPool(path: databasePath, maxReaders: maxReaders)
        self.semanticLoader = SemanticStateActor(
            databasePath: databasePath,
            resourcesDirectory: self.resourcesDirectory
        )
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

    /// Returns lazily loaded `(Model2VecEmbedder, SemanticCorpusIndex)` if available on disk, else `nil`.
    public func semanticResources() async -> (embedder: Model2VecEmbedder, index: SemanticCorpusIndex)? {
        await semanticLoader.loadIfAvailable()
    }

    /// Closes all pooled SQLite reader connections.
    public func close() async {
        await pool.close()
    }
}

private actor SemanticStateActor {
    private let databasePath: String
    private let resourcesDirectory: String
    private var attempted = false
    private var loaded: (embedder: Model2VecEmbedder, index: SemanticCorpusIndex)?

    init(databasePath: String, resourcesDirectory: String) {
        self.databasePath = databasePath
        self.resourcesDirectory = resourcesDirectory
    }

    func loadIfAvailable() -> (embedder: Model2VecEmbedder, index: SemanticCorpusIndex)? {
        if attempted { return loaded }
        attempted = true
        let modelDir = URL(fileURLWithPath: resourcesDirectory, isDirectory: true)
            .appendingPathComponent("models/minishlab/potion-retrieval-32M", isDirectory: true)
            .path
        guard FileManager.default.fileExists(atPath: modelDir),
            let embedder = try? Model2VecEmbedder(modelDirectory: modelDir)
        else {
            return nil
        }
        guard let conn = try? SQLiteConnection(path: databasePath, options: .readOnly) else {
            return nil
        }
        defer { conn.close() }
        guard let index = try? SemanticCorpusIndex.load(from: conn), !index.documentIDs.isEmpty else {
            return nil
        }
        loaded = (embedder, index)
        return loaded
    }
}
