import AemiDigest
import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage

/// Per-root index gating (Bun `gateByRootIndex`): which roots changed, which pages the indexes add, and the index
/// validators to commit after the crawl.
struct RootIndexGate {
    struct PendingCommit {
        let slug: String
        let etag: String?
        let hash: String?
    }

    var unchanged: Set<String> = []
    var seededPages = 0
    /// Roots whose index could not be fetched (revalidated page by page), with the error.
    var failures: [String: String] = [:]
    var pending: [PendingCommit] = []

    static func hashCheckpoint(_ slug: String) -> String { "root_index_hash:\(slug)" }

    /// Fetches every root's index (bounded concurrency), then applies the outcomes in root order.
    static func evaluate(
        roots: [CorpusRootRecord],
        client: UpstreamHTTPClient,
        store: CorpusStore,
        concurrency: Int
    ) async throws -> RootIndexGate {
        let outcomes = await fetchAll(roots: roots, client: client, concurrency: concurrency)
        var gate = RootIndexGate()
        let db = store.connection
        try db.transaction {
            for root in roots {
                let outcome: DocCRootIndex.FetchOutcome
                switch outcomes[root.slug] {
                    case .success(let value)?: outcome = value
                    case .failure(let error)?:
                        gate.failures[root.slug] = String(describing: error)
                        continue  // revalidate page by page
                    case nil:
                        gate.failures[root.slug] = "no result"
                        continue
                }
                switch outcome {
                    case .unchanged where root.indexETag != nil:
                        gate.unchanged.insert(root.slug)
                    case .modified(let body, let etag):
                        let hash = ContentDigest.sha256Hex(body)
                        let stored = try db.queryOne(
                            "SELECT value FROM sync_checkpoint WHERE key = ?",
                            bindings: [.text(hashCheckpoint(root.slug))]
                        )
                        if try stored?.optionalText(at: 0) == hash {
                            gate.unchanged.insert(root.slug)  // rotated ETag over identical content
                            if let etag { try setIndexETag(etag, slug: root.slug, on: db) }
                            continue
                        }
                        for page in (try? DocCRootIndex.pages(fromIndex: body, rootSlug: root.slug)) ?? []
                        where try SyncOrchestrator.enqueue(
                            path: page.key,
                            rootSlug: root.slug,
                            depth: page.depth,
                            on: db
                        ) {
                            gate.seededPages += 1
                        }
                        gate.pending.append(PendingCommit(slug: root.slug, etag: etag, hash: hash))
                    case .unchanged, .missing:
                        break
                }
            }
        }
        return gate
    }

    /// Commits pending index validators; with `drainedOnly`, only for roots whose queue is empty.
    func commit(drainedOnly: Bool, store: CorpusStore) throws {
        let db = store.connection
        try db.transaction {
            for item in pending {
                if drainedOnly {
                    let open = try db.queryOne(
                        "SELECT COUNT(*) FROM crawl_state WHERE root_slug = ? AND status IN ('pending', 'fetching')",
                        bindings: [.text(item.slug)]
                    )
                    if try (open?.integer(at: 0) ?? 0) > 0 { continue }
                }
                if let etag = item.etag { try Self.setIndexETag(etag, slug: item.slug, on: db) }
                if let hash = item.hash {
                    try db.execute(
                        """
                        INSERT INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, datetime('now'))
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                        """,
                        bindings: [.text(Self.hashCheckpoint(item.slug)), .text(hash)]
                    )
                }
            }
        }
    }

    private static func setIndexETag(_ etag: String, slug: String, on db: SQLiteConnection) throws(SQLiteError) {
        try db.execute("UPDATE roots SET index_etag = ? WHERE slug = ?", bindings: [.text(etag), .text(slug)])
    }

    private typealias FetchResult = (slug: String, result: Result<DocCRootIndex.FetchOutcome, SourceError>)

    /// Fetches every root's index with at most `concurrency` requests in flight.
    private static func fetchAll(
        roots: [CorpusRootRecord],
        client: UpstreamHTTPClient,
        concurrency: Int
    ) async -> [String: Result<DocCRootIndex.FetchOutcome, SourceError>] {
        var results: [String: Result<DocCRootIndex.FetchOutcome, SourceError>] = [:]
        let width = max(1, concurrency)
        for start in stride(from: 0, to: roots.count, by: width) {
            let batch = roots[start ..< min(start + width, roots.count)]
            let fetched = await withTaskGroup(of: FetchResult.self, returning: [FetchResult].self) { group in
                for root in batch {
                    let slug = root.slug
                    let etag = root.indexETag
                    group.addTask { (slug, await fetchIndex(slug: slug, etag: etag, client: client)) }
                }
                var collected: [FetchResult] = []
                for await item in group { collected.append(item) }
                return collected
            }
            for item in fetched { results[item.slug] = item.result }
        }
        return results
    }

    private static func fetchIndex(
        slug: String,
        etag: String?,
        client: UpstreamHTTPClient
    ) async -> Result<DocCRootIndex.FetchOutcome, SourceError> {
        do {
            return .success(try await DocCRootIndex.fetch(rootSlug: slug, etag: etag, client: client))
        } catch {
            return .failure(error)
        }
    }
}
