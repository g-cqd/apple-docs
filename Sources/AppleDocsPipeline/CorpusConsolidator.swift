import AppleDocsCore
public import AppleDocsSources
public import AppleDocsStorage

/// Repairs failed crawl entries, drops invalid operator / fragment paths and cross-adapter false positives,
/// sweeps orphan relationship edges, and retries recoverable failures (Bun `commands/consolidate.js`).
public enum CorpusConsolidator: Sendable {
    public struct Report: Hashable, Sendable {
        public var analyzed = 0
        public var cleanedInvalid = 0
        public var cleanedCrossAdapter = 0
        public var orphanRelationshipsRemoved = 0
        public var retriedQueued = 0
        public var retriedRecovered = 0
        public var retriedStillFailing = 0

        public init() {}
    }

    public static func run(
        client: UpstreamHTTPClient,
        store: CorpusStore,
        concurrency: Int = 32,
        dryRun: Bool = false
    ) async throws -> Report {
        let db = store.connection
        let roots = try store.listRoots()
        let rootBySlug = Dictionary(uniqueKeysWithValues: roots.map { ($0.slug, $0) })

        var (report, toDelete, toRetry) = try classifyFailedRows(on: db, rootBySlug: rootBySlug)
        let orphanCountRow = try db.queryOne(
            "SELECT COUNT(*) FROM document_relationships WHERE from_key NOT IN (SELECT key FROM documents)"
        )
        report.orphanRelationshipsRemoved = Int((try orphanCountRow?.integer(at: 0)) ?? 0)
        report.retriedQueued = toRetry.count
        if dryRun { return report }

        try applyCleanupAndRequeue(
            toDelete: toDelete,
            toRetry: toRetry,
            removeOrphans: report.orphanRelationshipsRemoved > 0,
            on: db
        )
        guard !toRetry.isEmpty else { return report }

        var adapters: [String: any SourceAdapter] = [:]
        for root in roots { adapters[root.slug] = SourceRegistry.adapter(for: root.sourceType) }
        let context = SyncOrchestrator.RunContext(
            adapters: adapters,
            client: client,
            store: store,
            options: SyncOrchestrator.Options(maxPages: max(1, toRetry.count), maxDepth: 0, concurrency: concurrency)
        )
        let counters = try await SyncOrchestrator.runWorkerPool(context: context)
        report.retriedRecovered = counters.modified + counters.skipped
        report.retriedStillFailing = counters.errors
        return report
    }

    private static func classifyFailedRows(
        on db: SQLiteConnection,
        rootBySlug: [String: CorpusRootRecord]
    ) throws -> (Report, [String], [String]) {
        let failedRows = try db.query("SELECT path, root_slug FROM crawl_state WHERE status = 'failed'")
        var report = Report()
        report.analyzed = failedRows.count
        var toDelete: [String] = []
        var toRetry: [String] = []
        for row in failedRows {
            let path = try row.text(at: 0)
            let recordedRoot = try row.text(at: 1)
            if isInvalidFailedPath(path) {
                report.cleanedInvalid += 1
                toDelete.append(path)
            } else if isCrossAdapterFalsePositive(path: path, recordedRoot: recordedRoot, rootBySlug: rootBySlug) {
                report.cleanedCrossAdapter += 1
                toDelete.append(path)
            } else {
                toRetry.append(path)
            }
        }
        return (report, toDelete, toRetry)
    }

    private static func applyCleanupAndRequeue(
        toDelete: [String],
        toRetry: [String],
        removeOrphans: Bool,
        on db: SQLiteConnection
    ) throws {
        try db.transaction {
            for path in toDelete {
                try db.execute("DELETE FROM crawl_state WHERE path = ?", bindings: [.text(path)])
            }
            if removeOrphans {
                try db.execute(
                    "DELETE FROM document_relationships WHERE from_key NOT IN (SELECT key FROM documents)"
                )
            }
            for path in toRetry {
                try db.execute("UPDATE crawl_state SET status = 'pending' WHERE path = ?", bindings: [.text(path)])
            }
        }
    }

    private static func isCrossAdapterFalsePositive(
        path: String,
        recordedRoot: String,
        rootBySlug: [String: CorpusRootRecord]
    ) -> Bool {
        let pathRoot = path.split(separator: "/").first.map(String.init) ?? ""
        guard let owner = rootBySlug[pathRoot] else { return false }
        return owner.sourceType != .appleDocC && owner.sourceType != .hig && recordedRoot != owner.slug
    }

    private static func isInvalidFailedPath(_ path: String) -> Bool {
        if path.isEmpty || path.contains("#") || path.contains("?") { return true }
        for seg in path.split(separator: "/") where WebSourceAdapter.isOperatorSegment(String(seg)) {
            return true
        }
        return (try? DocumentKey(path)) == nil
    }
}
