import AppleDocsContent
import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage

extension SyncOrchestrator {
    /// Applies one fetched batch inside a single SQLite transaction.
    static func commitBatch(
        _ entries: [FetchedEntry],
        context: RunContext,
        counters: inout Counters
    ) throws {
        let db = context.store.connection
        try db.transaction {
            for entry in entries {
                try commitEntry(entry, context: context, counters: &counters, on: db)
            }
        }
    }

    private static func commitEntry(
        _ entry: FetchedEntry,
        context: RunContext,
        counters: inout Counters,
        on db: SQLiteConnection
    ) throws {
        guard let key = entry.key else {
            try markState(path: entry.path, status: "failed", error: "invalid key", on: db)
            counters.errors += 1
            return
        }
        switch entry.outcome {
            case .failure(let error):
                try markState(path: key.rawValue, status: "failed", error: String(describing: error), on: db)
                counters.errors += 1
            case .success(.notModified):
                try clearTombstoneCounter(forKey: key, on: db)
                try markState(path: key.rawValue, status: "done", error: nil, on: db)
                counters.skipped += 1
            case .success(.notFound):
                if try recordNotFound(forKey: key, threshold: context.options.tombstoneThreshold, in: context.store) {
                    counters.tombstoned += 1
                }
                try markState(path: key.rawValue, status: "not_found", error: "HTTP 404", on: db)
            case .success(.modified(let payload, let etag, let discoveredKeys)):
                do {
                    counters.discovered += try applyModified(
                        payload: payload,
                        etag: etag,
                        discoveredKeys: discoveredKeys,
                        entry: entry,
                        context: context
                    )
                    counters.modified += 1
                } catch {
                    try markState(path: key.rawValue, status: "failed", error: String(describing: error), on: db)
                    counters.errors += 1
                }
        }
    }

    private static func applyModified(
        payload: SourcePayload,
        etag: String?,
        discoveredKeys: [DocumentKey],
        entry: FetchedEntry,
        context: RunContext
    ) throws -> Int {
        let key = payload.key
        let db = context.store.connection
        let converted = try SyncPipeline.persist(payload, into: context.store)
        try clearTombstoneCounter(forKey: key, on: db)
        var added = 0
        if entry.depth < context.options.maxDepth {
            for child in converted.discoveredKeys + discoveredKeys {
                if context.options.stayWithinSeedRoot, child.rootSlug != entry.rootSlug { continue }
                if try enqueue(path: child.rawValue, rootSlug: entry.rootSlug, depth: entry.depth + 1, on: db) {
                    added += 1
                }
            }
        }
        try db.execute(
            "UPDATE crawl_state SET status = 'done', error = NULL, etag = ? WHERE path = ?",
            bindings: [.optionalText(etag.flatMap { $0.isEmpty ? nil : $0 }), .text(entry.path)]
        )
        try deleteCheckpoint(key: "etag:\(key.rawValue)", on: db)
        return added
    }
}
