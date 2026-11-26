import AppleDocsContent
public import AppleDocsCore
public import AppleDocsSources
public import AppleDocsStorage

/// Resumable, durable multi-phase sync orchestrator over `crawl_state`, `sync_checkpoint`,
/// ``SourceAdapter``, ``UpstreamHTTPClient``, and ``CorpusStore``.
public enum SyncOrchestrator: Sendable {
    /// Execution bounds and policy for one resumable sync run.
    public struct Options: Hashable, Sendable {
        public let maxPages: Int
        public let maxDepth: Int
        public let tombstoneThreshold: Int

        public init(maxPages: Int = 100, maxDepth: Int = 3, tombstoneThreshold: Int = 2) {
            self.maxPages = max(1, maxPages)
            self.maxDepth = max(0, maxDepth)
            self.tombstoneThreshold = max(1, tombstoneThreshold)
        }
    }

    /// Summary statistics returned by ``sync(adapter:seeds:client:into:options:)``.
    public struct RunReport: Hashable, Sendable {
        public let source: SourceKind
        public let fetchedModified: Int
        public let skippedNotModified: Int
        public let tombstoned: Int
        public let errors: Int
        public let discoveredQueued: Int
    }

    /// Executes a resumable discover -> crawl -> convert -> checkpoint cycle for `adapter`.
    public static func sync(
        adapter: any SourceAdapter,
        seeds: [DocumentKey]? = nil,
        client: UpstreamHTTPClient,
        into store: CorpusStore,
        options: Options = Options()
    ) async throws -> RunReport {
        let root = adapter.defaultRoot
        try seedQueue(root: root, seeds: seeds ?? adapter.seedKeys, into: store)
        let context = RunContext(rootSlug: root.slug, adapter: adapter, client: client, store: store, options: options)
        var counters = Counters()

        for _ in 0 ..< options.maxPages {
            guard
                let next = try dequeueNextPending(rootSlug: root.slug, maxDepth: options.maxDepth, on: store.connection)
            else {
                break
            }
            await processEntry(next, context: context, counters: &counters)
        }

        try writeCheckpoint(
            key: "sync:\(adapter.kind.rawValue):last_phase",
            value: SyncPhase.consolidate.rawValue,
            on: store.connection
        )
        return RunReport(
            source: adapter.kind,
            fetchedModified: counters.modified,
            skippedNotModified: counters.skipped,
            tombstoned: counters.tombstoned,
            errors: counters.errors,
            discoveredQueued: counters.discovered
        )
    }

    private struct RunContext {
        let rootSlug: String
        let adapter: any SourceAdapter
        let client: UpstreamHTTPClient
        let store: CorpusStore
        let options: Options
    }

    private struct Counters {
        var modified = 0
        var skipped = 0
        var tombstoned = 0
        var errors = 0
        var discovered = 0
    }

    private static func seedQueue(root: CorpusRootRecord, seeds: [DocumentKey], into store: CorpusStore) throws {
        try store.connection.transaction {
            try store.upsertRoot(root)
            for seed in seeds {
                try enqueue(path: seed.rawValue, rootSlug: root.slug, depth: 0, on: store.connection)
            }
        }
    }

    private static func processEntry(
        _ entry: (path: String, depth: Int),
        context: RunContext,
        counters: inout Counters
    ) async {
        let db = context.store.connection
        guard let key = try? DocumentKey(entry.path) else {
            try? markState(path: entry.path, status: "failed", error: "invalid key", on: db)
            counters.errors += 1
            return
        }
        do {
            let previousETag = try readCheckpoint(key: "etag:\(key.rawValue)", on: db)
            let outcome = try await context.adapter.fetch(key: key, previousETag: previousETag, client: context.client)
            switch outcome {
                case .notModified:
                    try clearTombstoneCounter(forKey: key, on: db)
                    try markState(path: key.rawValue, status: "done", error: nil, on: db)
                    counters.skipped += 1
                case .notFound:
                    if try recordNotFound(
                        forKey: key,
                        threshold: context.options.tombstoneThreshold,
                        in: context.store
                    ) {
                        counters.tombstoned += 1
                    }
                    try markState(path: key.rawValue, status: "not_found", error: "HTTP 404", on: db)
                case .modified(let payload, let etag, let discoveredKeys):
                    let added = try commitModified(
                        payload: payload,
                        etag: etag,
                        discoveredKeys: discoveredKeys,
                        depth: entry.depth,
                        context: context
                    )
                    counters.discovered += added
                    counters.modified += 1
            }
        } catch {
            try? markState(path: key.rawValue, status: "failed", error: String(describing: error), on: db)
            counters.errors += 1
        }
    }

    private static func commitModified(
        payload: SourcePayload,
        etag: String?,
        discoveredKeys: [DocumentKey],
        depth: Int,
        context: RunContext
    ) throws -> Int {
        let key = payload.key
        let db = context.store.connection
        let converted = try SyncPipeline.convert(payload)
        var added = 0
        try db.transaction {
            let docID = try context.store.upsertDocument(converted.document)
            try context.store.replaceSections(forDocumentID: docID, sections: converted.sections)
            for rel in converted.relationships {
                try context.store.upsertRelationship(rel)
            }
            if let etag, !etag.isEmpty {
                try writeCheckpoint(key: "etag:\(key.rawValue)", value: etag, on: db)
            }
            try clearTombstoneCounter(forKey: key, on: db)
            if depth < context.options.maxDepth {
                for child in discoveredKeys
                where try enqueue(path: child.rawValue, rootSlug: context.rootSlug, depth: depth + 1, on: db) {
                    added += 1
                }
            }
            try markState(path: key.rawValue, status: "done", error: nil, on: db)
        }
        return added
    }
}
