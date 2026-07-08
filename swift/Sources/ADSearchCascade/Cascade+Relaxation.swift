// The relaxation cascade (R1–R3) — split from Cascade.swift to keep that
// enum's body within the type-length gate. Mirrors src/search/cascade.js
// `runRelaxationCascade` + src/commands/search.js's tier bookkeeping.

import ADContent
import ADStorage

extension Cascade {
    /// Relaxation cascade R1–R3 — reached only when the strict + deep tiers produced NOTHING and the
    /// trimmed query is >= 4 UTF-16 units (no `"`) tokenizing to >= 3 tokens: R1 pruned-AND, R2
    /// pruned-OR, R3 trigram on a single high-signal token. Mirrors src/commands/search.js.
    /// Returns the tier name that contributed rows (`pruned` / `pruned-or` / `trigram` — the JS
    /// `relaxationTier`), or nil when nothing was relaxed-matched.
    @discardableResult
    static func appendRelaxationTiers(
        _ results: inout [ResultHit], _ seen: inout Set<String>, _ p: PreparedSearch,
        _ conn: StorageConnection
    ) -> String? {
        let q = p.q
        let filters = p.activeFilters
        func addRows(_ rows: [SearchRow], quality: (SearchRow) -> String) {
            for row in rows {
                if !Filters.matches(row, filters) { continue }
                if seen.insert(row.path).inserted {
                    var hit = ResultHit(row, matchQuality: quality(row))
                    hit.origIndex = results.count
                    results.append(hit)
                }
            }
        }
        guard results.isEmpty, q.utf16.count >= 4, !q.contains("\"") else { return nil }
        let tokens = Relaxation.tokenize(q)
        guard tokens.count >= 3 else { return nil }
        let pruned = Relaxation.pruneStopwords(tokens)
        // Each tier stamps its JS tier name iff it actually contributed rows (the JS
        // `if (results.length > before) relaxationTier = '<tier>'`); at most one fires
        // since R2/R3 gate on `results.isEmpty`.
        var tier: String?
        // R1 — pruned AND
        if pruned.count >= 1 {
            let before = results.count
            var params = p.ftsParams
            params.query = FtsQuery.build(pruned.joined(separator: " "))
            addRows(fanout(filters.frameworks, params) { conn.ftsRows($0) }) { _ in "relaxed" }
            if results.count > before { tier = "pruned" }
        }
        // R2 — pruned OR (lowercased, quote-stripped, OR-joined)
        if results.isEmpty, pruned.count >= 2 {
            let before = results.count
            var params = p.ftsParams
            params.query =
                pruned.map { "\"\(stripQuotes(JsString.lowercase($0)))\"" }.joined(separator: " OR ")
            addRows(fanout(filters.frameworks, params) { conn.ftsRows($0) }) { _ in "relaxed-or" }
            if results.count > before { tier = "pruned-or" }
        }
        // R3 — trigram on a single high-signal token
        if results.isEmpty {
            let pool = pruned.isEmpty ? tokens : pruned
            if let signal = Relaxation.pickHighSignalToken(pool), signal.utf16.count >= 3 {
                let before = results.count
                var params = p.trigramParams
                params.query = FtsQuery.trigram(signal)
                addRows(fanout(filters.frameworks, params) { conn.trigramRows($0) }) { _ in "relaxed-token" }
                if results.count > before { tier = "trigram" }
            }
        }
        return tier
    }
}
