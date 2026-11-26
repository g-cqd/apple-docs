import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage
import Foundation

extension CorpusSync {
    static let sweepCheckpoint = "docc_full_sweep_at"

    /// Upserts the catalog's roots (Bun `discoverRoots`); returns how many entries it listed.
    static func refreshCatalog(client: UpstreamHTTPClient, store: CorpusStore) async throws -> Int {
        let roots = try await AppleRootCatalog.fetch(client: client)
        try store.connection.transaction {
            for root in roots { try store.upsertDiscoveredRoot(root) }
        }
        return Set(roots.map(\.slug)).count
    }

    static func selectRoots(store: CorpusStore, options: Options) throws -> [CorpusRootRecord] {
        try store.listRoots()
            .filter { root in
                options.sources.contains(root.sourceType) && (options.roots?.contains(root.slug) ?? true)
            }
    }

    /// Whether this run revalidates every page (`full`, first run, or the last sweep is older than the interval);
    /// records the sweep start when it does (Bun writes `docc_full_sweep_at` before checking).
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

    /// Seeds every root's seed page and returns the pages of `revalidate` roots to the queue (conditional GETs).
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

    /// `Date.prototype.toISOString()` format (`2026-08-05T17:14:30.390Z`), shared with Bun corpora.
    static func formatISO8601(_ date: Date) -> String {
        date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
    }

    static func parseISO8601(_ text: String) -> Date? {
        (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}
