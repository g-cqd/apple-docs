import AppleDocsCore
public import AppleDocsStorage

/// Bun's search pipeline (`commands/search.js`): exact title → FTS5 (title-tiered) → trigram → fuzzy → body →
/// relaxation, reranked by intent, fused with semantic candidates, then snippets and relationship counts.
public enum CorpusSearch {
    /// The semantic tier's inputs: a query embedder and the corpus vector store.
    public struct Semantic: Sendable {
        public let embed: @Sendable (String) -> [Float]
        public let store: ChunkVectorStore

        public init(embed: @escaping @Sendable (String) -> [Float], store: ChunkVectorStore) {
            self.embed = embed
            self.store = store
        }
    }

    static let semanticTopK = 50
    private static let tierLabels = ["exact", "prefix", "contains", "match"]

    public static func search(
        _ options: SearchOptions,
        semantic: Semantic? = nil,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> SearchOutcome {
        let query = JSWhitespace.trim(options.query)
        guard !query.isEmpty else {
            return SearchOutcome(
                results: [],
                total: 0,
                hasMore: false,
                query: "",
                intent: nil,
                relaxationTier: nil,
                tier: nil,
                trigramAvailable: false,
                bodyIndexAvailable: false
            )
        }
        var state = try SearchState(options: options, query: query, on: connection)
        state.runLexicalTiers(fast: options.fast, requestedWindow: options.limit + options.offset)
        if state.results.count < 5, query.utf16.count >= 4, options.fuzzy { state.runFuzzy() }
        if state.hasBody, state.results.count < min(options.limit + options.offset, 15) || options.noEager {
            state.add(state.runBody(), quality: "body")
        }
        let relaxationTier = state.runRelaxation()
        let intent = SearchIntent.detect(query)
        var results = SearchRanking.rerank(state.results, query: query, intent: intent)
        if let semantic, !options.fast {
            let hits = state.semanticHits(semantic)
            if !hits.isEmpty {
                results = SemanticFusion.fuse(
                    lexical: results,
                    semantic: hits,
                    requestedWindow: options.limit + options.offset
                )
            }
        }
        let total = results.count
        let lower = min(options.offset, total)
        var sliced = Array(results[lower ..< min(options.offset + options.limit, total)])
        decorate(&sliced, query: query, on: connection)
        return SearchOutcome(
            results: sliced,
            total: total,
            hasMore: total >= options.offset + options.limit && sliced.count == options.limit,
            query: options.query,
            intent: intent,
            relaxationTier: relaxationTier,
            tier: snapshotTier(on: connection),
            trigramAvailable: tableExists("documents_trigram", on: connection),
            bodyIndexAvailable: state.hasBody
        )
    }

    /// Snippets and relationship counts for the returned page (`getDocumentSnippetData`, `getRelatedDocCounts`).
    private static func decorate(_ items: inout [SearchResultItem], query: String, on connection: SQLiteConnection) {
        guard !items.isEmpty else { return }
        let snippets = SearchSnippetSource.texts(for: items.map(\.path), on: connection)
        let counts = SearchSnippetSource.relatedCounts(for: items.map(\.path), on: connection)
        for index in items.indices {
            if let text = snippets[items[index].path] {
                items[index].snippet = SearchSnippet.render(text: text, query: query)
            }
            items[index].relatedCount = counts[items[index].path] ?? 0
        }
    }

    static func tierLabel(_ tier: Int?) -> String {
        guard let tier, tierLabels.indices.contains(tier) else { return "match" }
        return tierLabels[tier]
    }

    private static func snapshotTier(on connection: SQLiteConnection) -> String? {
        if let row = (try? connection.queryOne("SELECT value FROM snapshot_meta WHERE key='snapshot_tier'")) ?? nil {
            return try? row.text(at: 0)
        }
        return tableExists("documents", on: connection) ? "full" : nil
    }

    static func tableExists(_ name: String, on connection: SQLiteConnection) -> Bool {
        ((try? connection.queryOne("SELECT 1 FROM sqlite_master WHERE name = ?", bindings: [.text(name)])) ?? nil)
            != nil
    }
}
