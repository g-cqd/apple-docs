import AppleDocsCore

/// Builds safe SQLite FTS5 `MATCH` expressions from user queries.
///
/// - Splits qualified Swift/Obj-C identifiers on `.`, `_`, `:`, `/`, `\` into OR'd prefix terms
///   plus their concatenated form (so `AVAudioSession.RouteSelection` matches both segments and
///   concatenated tokens).
/// - Splits CamelCase words into exact sub-word alternatives alongside the whole-word prefix.
/// - Escapes double quotes safely and produces `""` on empty input so FTS5 never raises a syntax error.
public enum FTSQueryBuilder: Sendable {
    /// Trims leading and trailing whitespace characters without Foundation overhead.
    public static func trimWhitespace(_ value: String) -> String {
        var start = value.startIndex
        while start < value.endIndex, value[start].isWhitespace {
            start = value.index(after: start)
        }
        var end = value.endIndex
        while end > start {
            let before = value.index(before: end)
            guard value[before].isWhitespace else { break }
            end = before
        }
        return String(value[start ..< end])
    }

    /// Builds a Porter/Unicode61 FTS5 `MATCH` expression for `query`.
    public static func buildLexicalQuery(_ query: String) -> String {
        let trimmed = trimWhitespace(query)
        guard !trimmed.isEmpty else { return "\"\"" }
        // Explicit FTS5 syntax passes through (Bun parity) only when its quotes balance; otherwise the quotes are
        // dropped and the text is treated as plain words, so user input can never leave a string unterminated.
        if containsExplicitOperators(trimmed), trimmed.utf8.count(where: { $0 == UInt8(ascii: "\"") }) % 2 == 0 {
            return trimmed
        }
        return plainWordsQuery(trimmed.replacingScalars("\"", with: " "))
    }

    /// The word-group query for `text`, ignoring any FTS5 syntax it contains (the engine's fallback when explicit
    /// syntax is rejected by SQLite).
    public static func plainWordsQuery(_ text: String) -> String {
        let operators: Set<Substring> = ["AND", "OR", "NOT"]
        let tokens: [Substring] = text.replacingScalars("\"", with: " ")
            .split { (character: Character) -> Bool in
                character.isWhitespace
            }
        let words: [String] = tokens.filter { !operators.contains($0) }.map(String.init)
        let groups = words.compactMap(buildWordGroup)
        return groups.isEmpty ? "\"\"" : groups.joined(separator: " ")
    }

    /// Sanitizes a query string for an FTS5 trigram `MATCH` clause.
    public static func sanitizeTrigramQuery(_ query: String) -> String {
        let trimmed = trimWhitespace(query)
        guard !trimmed.isEmpty else { return "\"\"" }
        let isPlain = trimmed.unicodeScalars.allSatisfy { scalar in
            CharacterSetCheck.isWordOrSpace(scalar)
        }
        if isPlain { return trimmed }
        let escaped = trimmed.replacingScalars("\"", with: "\"\"")
        return "\"\(escaped)\""
    }

    private static func containsExplicitOperators(_ query: String) -> Bool {
        if query.containsScalar("\"") { return true }
        let tokens = query.split(whereSeparator: { $0.isWhitespace })
        return tokens.contains { $0 == "AND" || $0 == "OR" || $0 == "NOT" }
    }

    private static func buildWordGroup(_ word: String) -> String? {
        let separators: Set<Character> = [".", "_", ":", "/", "\\"]
        // Only segments the unicode61 tokenizer turns into tokens: a punctuation-only prefix term (`"("*`) is an
        // FTS5 syntax error.
        let segments = word.split(whereSeparator: { separators.contains($0) }).map(String.init)
            .filter { $0.contains { $0.isLetter || $0.isNumber } }
        guard !segments.isEmpty else { return nil }

        var prefixTerms: [String] = []
        var seenPrefix: Set<String> = []
        var exactTerms: [String] = []
        var seenExact: Set<String> = []

        for segment in segments {
            let lower = segment.lowercased()
            if seenPrefix.insert(lower).inserted {
                prefixTerms.append(lower)
            }
            for subword in camelSubwords(segment) {
                let subLower = subword.lowercased()
                if seenExact.insert(subLower).inserted {
                    exactTerms.append(subLower)
                }
            }
        }

        if segments.count > 1 {
            let joined = segments.joined().lowercased()
            if seenPrefix.insert(joined).inserted {
                prefixTerms.append(joined)
            }
        }

        let filteredExact = exactTerms.filter { !seenPrefix.contains($0) }
        let alternatives =
            prefixTerms.map { "\"\(escapeFTS($0))\"*" } + filteredExact.map { "\"\(escapeFTS($0))\"" }
        guard !alternatives.isEmpty else { return nil }
        if alternatives.count == 1 { return alternatives[0] }
        return "(\(alternatives.joined(separator: " OR ")))"
    }

    private static func camelSubwords(_ token: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var previousWasLowerOrDigit = false
        for character in token {
            let isUpper = character.isASCII && character.isUppercase
            if isUpper, previousWasLowerOrDigit, !current.isEmpty {
                parts.append(current)
                current = ""
            }
            current.append(character)
            previousWasLowerOrDigit = character.isASCII && (character.isLowercase || character.isNumber)
        }
        if !current.isEmpty { parts.append(current) }
        return parts.count > 1 ? parts : []
    }

    private static func escapeFTS(_ token: String) -> String {
        token.replacingScalars("\"", with: "\"\"")
    }
}

private enum CharacterSetCheck {
    static func isWordOrSpace(_ scalar: Unicode.Scalar) -> Bool {
        let value = scalar.value
        let isAlphaNum =
            (value >= 0x30 && value <= 0x39)
            || (value >= 0x41 && value <= 0x5A)
            || (value >= 0x61 && value <= 0x7A)
            || value == 0x5F
        return isAlphaNum || value == 0x20 || value == 0x09
    }
}
