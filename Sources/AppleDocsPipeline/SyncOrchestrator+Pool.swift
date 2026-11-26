import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage

extension SyncOrchestrator {
    /// Drives the refilling fetch pool: dispatch up to `concurrency` pages, commit each as it completes, then
    /// top the pool back up from `crawl_state` (which now includes children discovered by that commit).
    static func runWorkerPool(context: RunContext) async throws -> Counters {
        let outcome = await withTaskGroup(of: FetchedEntry.self, returning: Result<Counters, any Error>.self) {
            group in
            var state = PoolState()
            do {
                try releaseClaims(context: context)
                try fill(&group, state: &state, context: context)
                while let entry = await group.next() {
                    state.inFlight.remove(entry.path)
                    try commitBatch([entry], context: context, counters: &state.counters)
                    try fill(&group, state: &state, context: context)
                }
                return .success(state.counters)
            } catch {
                group.cancelAll()
                return .failure(error)
            }
        }
        return try outcome.get()
    }

    struct PoolState {
        var counters = Counters()
        var inFlight: Set<String> = []
        var dispatched = 0
    }

    private static func fill(
        _ group: inout TaskGroup<FetchedEntry>,
        state: inout PoolState,
        context: RunContext
    ) throws(SQLiteError) {
        let options = context.options
        let wanted = min(options.concurrency - state.inFlight.count, options.maxPages - state.dispatched)
        guard wanted > 0 else { return }
        let client = context.client
        for pending in try claimPending(limit: wanted, context: context) {
            guard let adapter = context.adapters[pending.rootSlug] else { continue }
            state.inFlight.insert(pending.path)
            state.dispatched += 1
            group.addTask { await fetchOne(pending, adapter: adapter, client: client) }
        }
    }

    /// Atomically marks up to `limit` pending rows of the run's roots `fetching` (breadth-first order) and returns
    /// them; a crash leaves them `fetching`, which ``releaseClaims(context:)`` returns to the queue next run.
    static func claimPending(
        limit: Int,
        context: RunContext
    ) throws(SQLiteError) -> [PendingFetch] {
        let rows = try context.store.connection.query(
            """
            UPDATE crawl_state SET status = 'fetching'
            WHERE path IN (
                SELECT path FROM crawl_state
                WHERE status = 'pending' AND depth <= ? AND root_slug IN (SELECT value FROM json_each(?))
                ORDER BY depth, path
                LIMIT ?
            )
            RETURNING path, depth, root_slug,
                COALESCE(etag, (SELECT value FROM sync_checkpoint WHERE key = 'etag:' || crawl_state.path))
            """,
            bindings: [
                .integer(Int64(context.options.maxDepth)), .text(context.rootsJSON), .integer(Int64(max(1, limit)))
            ]
        )
        var claimed: [PendingFetch] = []
        claimed.reserveCapacity(rows.count)
        for row in rows {
            let path = try row.text(at: 0)
            claimed.append(
                PendingFetch(
                    path: path,
                    depth: Int(try row.integer(at: 1)),
                    rootSlug: try row.text(at: 2),
                    key: try? DocumentKey(path),
                    etag: try row.optionalText(at: 3)
                )
            )
        }
        return claimed.sorted { ($0.depth, $0.path) < ($1.depth, $1.path) }
    }

    /// Returns rows claimed by an interrupted run to the queue.
    static func releaseClaims(context: RunContext) throws(SQLiteError) {
        try context.store.connection.execute(
            """
            UPDATE crawl_state SET status = 'pending'
            WHERE status = 'fetching' AND root_slug IN (SELECT value FROM json_each(?))
            """,
            bindings: [.text(context.rootsJSON)]
        )
    }
}
