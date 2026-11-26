import AppleDocsCore

/// Bun's FTS5 `MATCH` builders (`search/fts-query-builder.js`).
///
/// - Queries containing a `"` or a bare `AND`/`OR`/`NOT` are explicit FTS5 syntax and pass through verbatim (the
///   search cascade falls back to a quoted prefix phrase when SQLite rejects them).
/// - Otherwise each whitespace-separated word becomes a prefix term, split on `.`, `_`, `:`, `/`, `\` with the
///   concatenated form added, plus exact CamelCase sub-words: `AVAudioSession.RouteSelection` matches either
///   segment or the joined token.
public enum FTSQueryBuilder: Sendable {
    /// `buildFtsQuery(q)` for the trimmed query.
    public static func buildLexicalQuery(_ query: String) -> String {
        let trimmed = DocumentPlainText.trim(query)
        if hasExplicitOperator(trimmed) || trimmed.containsScalar("\"") { return trimmed }
        var words: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in trimmed.unicodeScalars {
            if DocumentPlainText.isJSWhitespace(scalar) {
                if !current.isEmpty { words.append(String(current)) }
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        if !current.isEmpty { words.append(String(current)) }
        let groups = words.compactMap(wordGroup)
        return groups.isEmpty ? "\"\"" : groups.joined(separator: " ")
    }

    /// `sanitizeTrigramQuery(q)`: `[\w\s]+` passes through; anything else becomes one quoted phrase.
    public static func sanitizeTrigramQuery(_ query: String) -> String {
        let trimmed = DocumentPlainText.trim(query)
        guard !trimmed.isEmpty else { return "\"\"" }
        if trimmed.unicodeScalars.allSatisfy({ ASCIIWords.isWord($0) || DocumentPlainText.isJSWhitespace($0) }) {
            return trimmed
        }
        return "\"" + trimmed.replacingScalars("\"", with: "\"\"") + "\""
    }

    /// `/\b(AND|OR|NOT)\b/` over ASCII word runs.
    private static func hasExplicitOperator(_ query: String) -> Bool {
        ASCIIWords.runs(query).contains { $0.word == "AND" || $0.word == "OR" || $0.word == "NOT" }
    }

    /// `buildWordGroup(word)`.
    private static func wordGroup(_ word: String) -> String? {
        let separators: Set<Unicode.Scalar> = [".", "_", ":", "/", "\\"]
        let segments = word.unicodeScalars.split(whereSeparator: separators.contains)
            .map { String(String.UnicodeScalarView($0)) }
        guard !segments.isEmpty else { return nil }
        var prefixTerms: [String] = []
        var exactTerms: [String] = []
        for segment in segments {
            let lower = segment.lowercased()
            if !prefixTerms.contains(lower) { prefixTerms.append(lower) }
            for subword in camelSubwords(segment) {
                let subLower = subword.lowercased()
                if !exactTerms.contains(subLower) { exactTerms.append(subLower) }
            }
        }
        if segments.count > 1 {
            let joined = segments.joined().lowercased()
            if !prefixTerms.contains(joined) { prefixTerms.append(joined) }
        }
        exactTerms.removeAll { prefixTerms.contains($0) }
        let alternatives = prefixTerms.map { "\"\($0)\"*" } + exactTerms.map { "\"\($0)\"" }
        guard !alternatives.isEmpty else { return nil }
        return alternatives.count == 1 ? alternatives[0] : "(" + alternatives.joined(separator: " OR ") + ")"
    }

    /// `s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')`, kept only when it splits.
    private static func camelSubwords(_ token: String) -> [String] {
        var parts: [String] = []
        var current = String.UnicodeScalarView()
        var previousLowerOrDigit = false
        for scalar in token.unicodeScalars {
            if ASCIIWords.isUpper(scalar), previousLowerOrDigit, !current.isEmpty {
                parts.append(String(current))
                current = String.UnicodeScalarView()
                previousLowerOrDigit = false
                current.append(scalar)
                continue
            }
            current.append(scalar)
            previousLowerOrDigit = ASCIIWords.isLower(scalar) || (0x30 ... 0x39).contains(scalar.value)
        }
        if !current.isEmpty { parts.append(String(current)) }
        return parts.count > 1 ? parts : []
    }
}
