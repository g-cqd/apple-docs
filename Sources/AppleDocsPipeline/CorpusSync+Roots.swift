import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage
import Foundation

extension CorpusSync {
    static let sweepCheckpoint = "docc_full_sweep_at"

    struct DiscoverySummary {
        var rootsAdded = 0
        var keysSeeded = 0
        var failures: [String: String] = [:]
    }

    private typealias AdapterDiscoveryOutcome = (kind: SourceKind, result: Result<SourceDiscovery, SourceError>)

    /// Upserts the catalog's roots (Bun `discoverRoots`); returns how many entries it listed.
    static func refreshCatalog(client: UpstreamHTTPClient, store: CorpusStore) async throws -> Int {
        let roots = try await AppleRootCatalog.fetch(client: client)
        try store.connection.transaction {
            for root in roots { try store.upsertDiscoveredRoot(root) }
        }
        return Set(roots.map(\.slug)).count
    }

    /// Runs `discover()` in parallel for every selected non-DocC/HIG source adapter, upserts their roots, and
    /// enqueues their discovered keys into `crawl_state`.
    static func discoverNonDocCSources(
        adaptersByKind: [SourceKind: any SourceAdapter],
        client: UpstreamHTTPClient,
        store: CorpusStore,
        options: Options
    ) async throws -> DiscoverySummary {
        let nonCatalog = adaptersByKind.keys
            .filter { $0 != .appleDocC && $0 != .hig }
            .sorted { $0.rawValue < $1.rawValue }
        guard !nonCatalog.isEmpty else { return DiscoverySummary() }

        // @dl:disable -- task-group collector over per-source discovery tasks
        let outcomes = await withTaskGroup(
            of: AdapterDiscoveryOutcome.self,
            returning: [AdapterDiscoveryOutcome].self
        ) { group in
            for kind in nonCatalog {
                guard let adapter = adaptersByKind[kind] else { continue }
                let full = options.full
                group.addTask { (kind, await runAdapterDiscovery(adapter: adapter, client: client, full: full)) }
            }
            var out: [AdapterDiscoveryOutcome] = []
            for await item in group { out.append(item) }
            return out
        }
        // @dl:enable

        var summary = DiscoverySummary()
        let db = store.connection
        try db.transaction {
            for item in outcomes {
                try applyDiscoveryOutcome(item, into: store, on: db, options: options, summary: &summary)
            }
        }
        return summary
    }

    private static func applyDiscoveryOutcome(
        _ item: AdapterDiscoveryOutcome,
        into store: CorpusStore,
        on db: SQLiteConnection,
        options: Options,
        summary: inout DiscoverySummary
    ) throws {
        switch item.result {
            case .failure(let error):
                summary.failures[item.kind.rawValue] = String(describing: error)
            case .success(let discovery):
                for root in discovery.roots where options.roots?.contains(root.slug) ?? true {
                    try store.upsertDiscoveredRoot(root)
                    summary.rootsAdded += 1
                }
                var keys = discovery.keys
                if item.kind == .sampleCode {
                    keys.append(contentsOf: try corpusSampleCodeKeys(on: db))
                }
                for key in keys where options.roots?.contains(key.rootSlug) ?? true {
                    if try SyncOrchestrator.enqueue(path: key.rawValue, rootSlug: key.rootSlug, depth: 0, on: db) {
                        summary.keysSeeded += 1
                    }
                }
        }
    }

    private static func runAdapterDiscovery(
        adapter: any SourceAdapter,
        client: UpstreamHTTPClient,
        full: Bool
    ) async -> Result<SourceDiscovery, SourceError> {
        do {
            return .success(try await adapter.discover(client: client, full: full))
        } catch {
            return .failure(error)
        }
    }

    private static func corpusSampleCodeKeys(on db: SQLiteConnection) throws -> [DocumentKey] {
        let rows = try db.query(
            "SELECT key, source_metadata FROM documents WHERE source_type = 'apple-docc' AND role = 'sampleCode'"
        )
        var out: [DocumentKey] = []
        for row in rows {
            let meta = try row.optionalText(at: 1) ?? ""
            if meta.contains("\"enrichedFrom\"") { continue }
            let docKey = try row.text(at: 0)
            let prefixed = docKey.hasPrefix("sample-code/") ? docKey : "sample-code/\(docKey)"
            if let key = try? DocumentKey(prefixed) { out.append(key) }
        }
        return out
    }

    static func selectRoots(store: CorpusStore, options: Options) throws -> [CorpusRootRecord] {
        try store.listRoots()
            .filter { root in
                options.sources.contains(root.sourceType) && (options.roots?.contains(root.slug) ?? true)
            }
    }

    static func startSweepIfDue(store: CorpusStore, options: Options) throws -> Bool {
        let db = store.connection
        let stored = try db.queryOne(
            "SELECT value FROM sync_checkpoint WHERE key = ?",
            bindings: [.text(sweepCheckpoint)]
        )
        let last = try stored?.optionalText(at: 0).flatMap(parseISO8601)
        let due = options.full || last.map { options.now.timeIntervalSince($0) > options.fullSweepInterval } ?? true
        if due {
            try db.execute(
                """
                INSERT INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                bindings: [.text(sweepCheckpoint), .text(formatISO8601(options.now))]
            )
        }
        return due
    }

    static func prepareQueue(
        roots: [CorpusRootRecord],
        revalidate: [String],
        retryFailed: Bool,
        store: CorpusStore
    ) throws {
        let db = store.connection
        let statuses = retryFailed ? "'done', 'not_found', 'failed'" : "'done', 'not_found'"
        try db.transaction {
            for root in roots {
                try SyncOrchestrator.enqueue(path: root.seedPath ?? root.slug, rootSlug: root.slug, depth: 0, on: db)
            }
            for slug in revalidate {
                try db.execute(
                    "UPDATE crawl_state SET status = 'pending' WHERE root_slug = ? AND status IN (\(statuses))",
                    bindings: [.text(slug)]
                )
            }
        }
    }

    static func formatISO8601(_ date: Date) -> String {
        date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
    }

    static func parseISO8601(_ text: String) -> Date? {
        (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}
