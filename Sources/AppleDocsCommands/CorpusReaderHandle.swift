import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsStorage
import Foundation

/// Shared pooled read-only corpus handle used by both `AppleDocsMCP` and `AppleDocsWeb`.
///
/// Owns a bounded ``SQLiteReaderPool`` and lazily loads the optional semantic tier (``Model2VecEmbedder`` +
/// ``ChunkVectorStore``) when a local model directory and corpus vectors are present (and
/// `APPLE_DOCS_SEMANTIC` is not `off`), degrading cleanly to lexical-only search otherwise.
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

    /// Runs a read-only ``CorpusStore`` closure over a pooled connection (no per-call open).
    public func withStore<T: Sendable>(
        _ body: @escaping @Sendable (CorpusStore) throws -> T
    ) async throws -> T {
        try await pool.withConnection { connection in
            try body(CorpusStore(borrowing: connection))
        }
    }

    /// The semantic tier's inputs, loaded once on first use; `nil` when unavailable.
    public func semanticResources() async -> CorpusSearch.Semantic? {
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
    private var loaded: CorpusSearch.Semantic?

    init(databasePath: String, resourcesDirectory: String) {
        self.databasePath = databasePath
        self.resourcesDirectory = resourcesDirectory
    }

    func loadIfAvailable() -> CorpusSearch.Semantic? {
        if attempted { return loaded }
        attempted = true
        if ProcessInfo.processInfo.environment["APPLE_DOCS_SEMANTIC"] == "off" { return nil }
        let modelDir = CorpusPaths.defaultModelDirectory(resourcesDirectory: resourcesDirectory)
        guard FileManager.default.fileExists(atPath: modelDir),
            let embedder = try? Model2VecEmbedder(modelDirectory: modelDir)
        else {
            return nil
        }
        guard let conn = try? SQLiteConnection(path: databasePath, options: .readOnly) else {
            return nil
        }
        defer { conn.close() }
        guard let store = (try? ChunkVectorStore.load(from: conn)) ?? nil else { return nil }
        loaded = CorpusSearch.Semantic(embed: { embedder.embed($0) }, store: store)
        return loaded
    }
}
