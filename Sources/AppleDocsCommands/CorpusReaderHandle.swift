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

    /// Starts loading the semantic tier (`Model2VecEmbedder` + `ChunkVectorStore`) asynchronously so the
    /// first `search_docs` / `/search` request finds it warm. Cancelled automatically on ``close()``.
    public func prewarmSemantic() {
        Task { [semanticLoader] in
            await semanticLoader.startWarmup()
        }
    }

    /// Closes all pooled SQLite reader connections and cancels any in-flight background warmup.
    public func close() async {
        await semanticLoader.shutdown()
        await pool.close()
    }
}

private actor SemanticStateActor {
    private let databasePath: String
    private let resourcesDirectory: String
    private var warmupTask: Task<CorpusSearch.Semantic?, Never>?
    private var closed = false

    init(databasePath: String, resourcesDirectory: String) {
        self.databasePath = databasePath
        self.resourcesDirectory = resourcesDirectory
    }

    func startWarmup() {
        guard !closed, warmupTask == nil else { return }
        let dbPath = databasePath
        let resDir = resourcesDirectory
        warmupTask = Task.detached(priority: .utility) {
            Self.loadSemanticSync(databasePath: dbPath, resourcesDirectory: resDir)
        }
    }

    func loadIfAvailable() async -> CorpusSearch.Semantic? {
        guard !closed else { return nil }
        startWarmup()
        return await warmupTask?.value
    }

    func shutdown() {
        closed = true
        warmupTask?.cancel()
        warmupTask = nil
    }

    private static func loadSemanticSync(
        databasePath: String,
        resourcesDirectory: String
    ) -> CorpusSearch.Semantic? {
        if Task.isCancelled { return nil }
        if ProcessInfo.processInfo.environment["APPLE_DOCS_SEMANTIC"] == "off" { return nil }
        let modelDir = CorpusPaths.defaultModelDirectory(resourcesDirectory: resourcesDirectory)
        guard FileManager.default.fileExists(atPath: modelDir),
            let embedder = try? Model2VecEmbedder(modelDirectory: modelDir),
            !Task.isCancelled
        else {
            return nil
        }
        guard let conn = try? SQLiteConnection(path: databasePath, options: .readOnly) else {
            return nil
        }
        defer { conn.close() }
        guard !Task.isCancelled, let store = (try? ChunkVectorStore.load(from: conn)) ?? nil else { return nil }
        return CorpusSearch.Semantic(embed: { embedder.embed($0) }, store: store)
    }
}
