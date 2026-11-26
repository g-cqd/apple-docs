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
        let db = context.store.connection
        let rows = try dequeuePendingBatch(
            rootSlug: context.rootSlug,
            maxDepth: options.maxDepth,
            limit: wanted + state.inFlight.count,
            on: db
        )
        let adapter = context.adapter
        let client = context.client
        let inFlight = state.inFlight
        for row in rows.filter({ !inFlight.contains($0.path) }).prefix(wanted) {
            let key = try? DocumentKey(row.path)
            let etag: String? =
                if let key { try readCheckpoint(key: "etag:\(key.rawValue)", on: db) } else { nil }
            let pending = PendingFetch(path: row.path, depth: row.depth, key: key, etag: etag)
            state.inFlight.insert(row.path)
            state.dispatched += 1
            group.addTask { await fetchOne(pending, adapter: adapter, client: client) }
        }
    }
}
