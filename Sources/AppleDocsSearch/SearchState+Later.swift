import AemiJSONCore
import AppleDocsCore
import AppleDocsStorage

/// Relaxation (`runRelaxationCascade`) and semantic candidates for ``SearchState``.
extension SearchState {
    /// Retries a query that found nothing: stopwords pruned, then OR-ed, then its highest-signal token as trigram.
    mutating func runRelaxation() -> String? {
        guard results.isEmpty, query.utf16.count >= 4, !query.unicodeScalars.contains("\"") else { return nil }
        let tokens = SearchRelaxation.tokenize(query)
        guard tokens.count >= 3 else { return nil }
        let pruned = SearchRelaxation.pruneStopwords(tokens)
        var tier: String?
        if !pruned.isEmpty {
            let before = results.count
            add(runFTS(FTSQueryBuilder.buildLexicalQuery(pruned.joined(separator: " "))), quality: "relaxed")
            if results.count > before { tier = "pruned" }
        }
        if results.isEmpty, pruned.count >= 2 {
            let orQuery = pruned.map { "\"" + $0.lowercased().replacingScalars("\"", with: "") + "\"" }
                .joined(separator: " OR ")
            let before = results.count
            add(runFTS(orQuery), quality: "relaxed-or")
            if results.count > before { tier = "pruned-or" }
        }
        if results.isEmpty, let signal = SearchRelaxation.highSignalToken(pruned.isEmpty ? tokens : pruned),
            signal.utf16.count >= 3
        {
            let before = results.count
            add(runTrigram(signal), quality: "relaxed-token")
            if results.count > before { tier = "trigram" }
        }
        return tier
    }

    /// Semantic candidates that pass the filters, as result items (`fuseSemanticResults` input).
    func semanticHits(_ semantic: CorpusSearch.Semantic) -> [SemanticFusion.SemanticHit] {
        let candidates = SemanticCandidates.candidates(
            query: semantic.embed(query),
            store: semantic.store,
            topK: CorpusSearch.semanticTopK,
            on: connection
        )
        guard !candidates.isEmpty,
            let records = try? SearchRepository.records(ids: candidates.map(\.documentID), on: connection)
        else { return [] }
        var byID: [Int64: SearchRecord] = [:]
        for record in records { if let id = record.id { byID[id] = record } }
        return candidates.compactMap { candidate in
            guard let record = byID[candidate.documentID] else { return nil }
            let platforms = record.platforms.flatMap { try? AemiJSON.parse(Array($0.utf8)).root }
            guard filters.matches(record, platforms: platforms) else { return nil }
            return SemanticFusion.SemanticHit(
                item: SearchResultItem(record: record, matchQuality: "semantic"),
                score: candidate.score,
                bits: candidate.bits
            )
        }
    }
}
