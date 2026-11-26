/// Bun's query relaxation helpers (`search/relaxation.js`).
enum SearchRelaxation {
    static let stopwords: Set<String> = [
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "for", "from", "get", "have", "how", "i",
        "if", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "should", "that", "the", "their", "then",
        "there", "these", "this", "to", "use", "using", "want", "was", "way", "we", "were", "what", "when", "where",
        "which", "while", "why", "will", "with", "you", "your"
    ]

    /// `query.split(/[^\w.]+/)` without empty and single-digit tokens.
    static func tokenize(_ query: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        for scalar in query.unicodeScalars {
            if ASCIIWords.isWord(scalar) || scalar == "." {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                tokens.append(current)
                current = ""
            }
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens.filter { !($0.count == 1 && $0.unicodeScalars.allSatisfy { (0x30 ... 0x39).contains($0.value) }) }
    }

    static func pruneStopwords(_ tokens: [String]) -> [String] {
        tokens.filter { ASCIIWords.hasCamelHump($0) || !stopwords.contains($0.lowercased()) }
    }

    static func highSignalToken(_ tokens: [String]) -> String? {
        if let camel = tokens.first(where: ASCIIWords.hasCamelHump) { return camel }
        var best: String?
        for token in tokens where token.utf16.count >= 4 {
            if best == nil || token.utf16.count > (best?.utf16.count ?? 0) { best = token }
        }
        return best
    }
}
