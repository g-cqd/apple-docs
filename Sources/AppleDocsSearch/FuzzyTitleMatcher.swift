import AppleDocsCore
import AppleDocsStorage

/// Bun's typo-tolerant title tier (`lib/fuzzy.js` `fuzzyMatchTitles`): trigram candidates from `documents_trigram`
/// (the 8 rarest query trigrams when the vocabulary is available), then bounded Levenshtein over UTF-16 units.
enum FuzzyTitleMatcher {
    static let rarestTrigramCount = 8

    struct Match {
        let id: Int64
        let distance: Int
    }

    static func matches(_ query: String, limit: Int, maxDistance: Int = 2, on connection: SQLiteConnection) -> [Match] {
        let lowerQuery = Array(query.lowercased().utf16)
        let trigrams = trigramSet(lowerQuery)
        guard trigrams.count >= 2 else { return [] }
        let selected = rarest(trigrams, on: connection)
        let orQuery = selected.map { "\"" + $0.replacingScalars("\"", with: "\"\"") + "\"" }.joined(separator: " OR ")
        let rows =
            (try? connection.query(
                """
                SELECT d.id, d.title, bm25(documents_trigram) AS score
                FROM documents_trigram JOIN documents d ON documents_trigram.rowid = d.id
                WHERE documents_trigram MATCH ?
                ORDER BY score
                LIMIT ?
                """,
                bindings: [.text(orQuery), .integer(Int64(max(limit * 5, 100)))]
            )) ?? []
        var found: [Match] = []
        for row in rows {
            guard let id = try? row.integer(at: 0), let title = try? row.optionalText(at: 1), !title.isEmpty else {
                continue
            }
            let distance = levenshtein(lowerQuery, Array(title.lowercased().utf16), maxDistance: maxDistance)
            if distance <= maxDistance { found.append(Match(id: id, distance: distance)) }
        }
        return Array(JSArraySort.sorted(found) { Double($0.distance - $1.distance) }.prefix(limit))
    }

    /// Distinct 3-unit slices in first-seen order (`trigrams` over a JavaScript string).
    private static func trigramSet(_ units: [UInt16]) -> [String] {
        guard units.count >= 3 else { return [] }
        var seen: Set<String> = []
        var ordered: [String] = []
        for start in 0 ... (units.count - 3) {
            let trigram = String(decoding: units[start ..< start + 3], as: UTF16.self)
            if seen.insert(trigram).inserted { ordered.append(trigram) }
        }
        return ordered
    }

    /// `selectRarestTrigrams`: with more than 8 trigrams, the 8 with the fewest documents (vocabulary counts).
    private static func rarest(_ trigrams: [String], on connection: SQLiteConnection) -> [String] {
        guard trigrams.count > rarestTrigramCount else { return trigrams }
        let placeholders = SQLiteConnection.placeholders(trigrams.count)
        guard
            let rows = try? connection.query(
                "SELECT term, doc FROM documents_trigram_vocab WHERE term IN (\(placeholders))",
                bindings: trigrams.map(SQLiteValue.text)
            ), !rows.isEmpty
        else { return trigrams }
        var counts: [String: Int64] = [:]
        for row in rows {
            if let term = try? row.text(at: 0), let doc = try? row.integer(at: 1) { counts[term] = doc }
        }
        let present = trigrams.filter { (counts[$0] ?? 0) > 0 }
        guard present.count >= rarestTrigramCount else { return trigrams }
        return Array(
            JSArraySort.sorted(present) { Double((counts[$0] ?? 0) - (counts[$1] ?? 0)) }.prefix(rarestTrigramCount)
        )
    }

    /// Levenshtein distance with early exit once every cell of a row exceeds `maxDistance`.
    static func levenshtein(_ lhs: [UInt16], _ rhs: [UInt16], maxDistance: Int) -> Int {
        if abs(lhs.count - rhs.count) > maxDistance { return maxDistance + 1 }
        if lhs.isEmpty { return rhs.count }
        if rhs.isEmpty { return lhs.count }
        var previous = Array(0 ... rhs.count)
        var current = [Int](repeating: 0, count: rhs.count + 1)
        for row in 1 ... lhs.count {
            current[0] = row
            var rowMinimum = row
            for column in 1 ... rhs.count {
                current[column] =
                    lhs[row - 1] == rhs[column - 1]
                    ? previous[column - 1] : 1 + min(previous[column], current[column - 1], previous[column - 1])
                rowMinimum = min(rowMinimum, current[column])
            }
            if rowMinimum > maxDistance { return maxDistance + 1 }
            swap(&previous, &current)
        }
        return previous[rhs.count]
    }
}
