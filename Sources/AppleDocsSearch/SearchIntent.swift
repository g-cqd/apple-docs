/// Bun's query intent (`search/intent.js`): drives ranking boosts.
public struct SearchIntent: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case symbol, error, howto, concept, wwdc, general
    }

    public let kind: Kind
    public let confidence: Double

    private static let howtoWords: Set<String> = [
        "how", "guide", "tutorial", "example", "implement", "create", "build", "use", "setup", "configure", "add",
        "make"
    ]
    private static let errorWords: Set<String> = [
        "error", "crash", "exception", "fail", "issue", "bug", "fix", "troubleshoot", "exc_bad", "abort", "segfault"
    ]
    private static let conceptWords: Set<String> = ["vs", "overview", "introduction", "explain"]

    public static func detect(_ query: String) -> SearchIntent {
        let trimmed = JSWhitespace.trim(query)
        guard !trimmed.isEmpty else { return SearchIntent(kind: .general, confidence: 0.5) }
        if ASCIIWords.hasCamelHump(trimmed) || isQualifiedName(trimmed) {
            return SearchIntent(kind: .symbol, confidence: 0.9)
        }
        if isSingleCapitalized(trimmed) { return SearchIntent(kind: .symbol, confidence: 0.7) }
        let runs = ASCIIWords.runs(trimmed)
        let words = runs.map { $0.word.lowercased() }
        if words.contains(where: errorWords.contains) { return SearchIntent(kind: .error, confidence: 0.8) }
        if words.contains(where: howtoWords.contains) { return SearchIntent(kind: .howto, confidence: 0.8) }
        if isConcept(runs) { return SearchIntent(kind: .concept, confidence: 0.7) }
        if runs.contains(where: { isWWDCToken($0.word) }) { return SearchIntent(kind: .wwdc, confidence: 0.8) }
        return SearchIntent(kind: .general, confidence: 0.5)
    }

    /// `/[.:]{2}|(?:[A-Z]\w+\.(?:[a-z]\w+|[A-Z]\w+))/`.
    private static func isQualifiedName(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        for index in scalars.indices.dropLast() where ".:".unicodeScalars.contains(scalars[index]) {
            if ".:".unicodeScalars.contains(scalars[index + 1]) { return true }
        }
        for dot in scalars.indices where scalars[dot] == "." {
            // After the dot: a letter followed by at least one word character.
            guard dot + 2 < scalars.count, ASCIIWords.isLetter(scalars[dot + 1]), ASCIIWords.isWord(scalars[dot + 2])
            else { continue }
            // Before the dot: an uppercase letter followed by at least one word character, all inside one run.
            var cursor = dot - 1
            while cursor >= 0, ASCIIWords.isWord(scalars[cursor]) {
                if ASCIIWords.isUpper(scalars[cursor]), cursor < dot - 1 { return true }
                cursor -= 1
            }
        }
        return false
    }

    /// `/^[A-Z][A-Za-z0-9]+$/`.
    private static func isSingleCapitalized(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count >= 2, ASCIIWords.isUpper(scalars[0]) else { return false }
        return scalars.dropFirst().allSatisfy { ASCIIWords.isWord($0) && $0 != "_" }
    }

    /// `/\b(what\s+is|difference\s+between|vs\.?|overview|introduction|explain)\b/i`.
    private static func isConcept(_ runs: [(word: String, whitespaceBefore: Bool)]) -> Bool {
        for (index, run) in runs.enumerated() {
            let word = run.word.lowercased()
            if conceptWords.contains(word) { return true }
            guard index + 1 < runs.count, runs[index + 1].whitespaceBefore else { continue }
            let next = runs[index + 1].word.lowercased()
            if (word == "what" && next == "is") || (word == "difference" && next == "between") { return true }
        }
        return false
    }

    /// `\bwwdc\b|\b20[12]\d\b`.
    private static func isWWDCToken(_ word: String) -> Bool {
        if word.lowercased() == "wwdc" { return true }
        let scalars = Array(word.unicodeScalars)
        return scalars.count == 4 && scalars[0] == "2" && scalars[1] == "0" && (scalars[2] == "1" || scalars[2] == "2")
            && (0x30 ... 0x39).contains(scalars[3].value)
    }
}
