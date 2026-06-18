// Byte-exact port of the JS intent detector. Only `type` feeds rerank (and the
// output strips it), but confidence is ported too. `\w` is written as the
// explicit ASCII class [A-Za-z0-9_] to match JS regex semantics on Linux.

public enum IntentType: String, Sendable {
    case symbol, howto, error, concept, wwdc, general
}

public struct Intent: Sendable {
    public let type: IntentType
    public let confidence: Double
}

enum IntentDetector {
    // These compiled patterns are immutable and `Regex` matching is read-only /
    // thread-safe, but `Regex` is not marked `Sendable` — `nonisolated(unsafe)`
    // is the contained, correct annotation (recompiling 7 patterns per search
    // would ~double its cost). Same category as the sqlite3 handle exception.
    //
    // case-sensitive (no /i): symbol shape detectors.
    nonisolated(unsafe) private static let camelCase = #/[a-z][A-Z]/#
    nonisolated(unsafe) private static let qualifiedName =
        #/[.:]{2}|[A-Z][A-Za-z0-9_]+\.(?:[a-z][A-Za-z0-9_]+|[A-Z][A-Za-z0-9_]+)/#
    nonisolated(unsafe) private static let singleCapitalized = #/^[A-Z][A-Za-z0-9]+$/#

    // case-insensitive (/i) word patterns.
    nonisolated(unsafe) private static let errorWords =
        #/\b(error|crash|exception|fail|issue|bug|fix|troubleshoot|exc_bad|abort|segfault)\b/#
        .ignoresCase()
    nonisolated(unsafe) private static let howtoWords =
        #/\b(how|guide|tutorial|example|implement|create|build|use|setup|configure|add|make)\b/#
        .ignoresCase()
    nonisolated(unsafe) private static let conceptPatterns =
        #/\b(what\s+is|difference\s+between|vs\.?|overview|introduction|explain)\b/#.ignoresCase()
    nonisolated(unsafe) private static let wwdcPattern = #/\bwwdc\b|\b20[12]\d\b/#.ignoresCase()

    static func detect(_ query: String) -> Intent {
        let q = trimWS(query)
        if q.isEmpty { return Intent(type: .general, confidence: 0.5) }

        if q.contains(camelCase) || q.contains(qualifiedName) {
            return Intent(type: .symbol, confidence: 0.9)
        }
        if q.wholeMatch(of: singleCapitalized) != nil {
            return Intent(type: .symbol, confidence: 0.7)
        }
        if q.contains(errorWords) { return Intent(type: .error, confidence: 0.8) }
        if q.contains(howtoWords) { return Intent(type: .howto, confidence: 0.8) }
        if q.contains(conceptPatterns) { return Intent(type: .concept, confidence: 0.7) }
        if q.contains(wwdcPattern) { return Intent(type: .wwdc, confidence: 0.8) }
        return Intent(type: .general, confidence: 0.5)
    }
}
