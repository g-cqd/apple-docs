import AppleDocsCore
import AppleDocsStorage

/// Bun's search snippets (`content/render-snippet.js` over `getDocumentSnippetData`): a ~220-character window of
/// the document's plain text around the first query term, measured in UTF-16 units like JavaScript.
enum SearchSnippet {
    static let scanLimit = 16 * 1024

    static func render(text fullText: String, query: String, maxLength: Int = 220) -> String {
        guard !fullText.isEmpty else { return "" }
        var units = Array(fullText.utf16)
        if units.count > scanLimit { units = Array(units[..<scanLimit]) }
        let text = string(units[...])
        // `query.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}_-]+/gu, '')).filter(Boolean)`
        var terms: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in query.lowercased().unicodeScalars {
            if JSWhitespace.contains(scalar) {
                if !current.isEmpty { terms.append(String(current)) }
                current = String.UnicodeScalarView()
            } else if isLetterOrNumber(scalar) || scalar == "_" || scalar == "-" {
                current.append(scalar)
            }
        }
        if !current.isEmpty { terms.append(String(current)) }
        guard !terms.isEmpty else { return truncate(units, maxLength) }
        let lower = Array(text.lowercased().utf16)
        let hit = terms.compactMap { indexOf(Array($0.utf16), in: lower) }.min()
        guard let hit else { return truncate(units, maxLength) }
        let windowStart = max(0, hit - Int((Double(maxLength) * 0.35).rounded(.down)))
        let windowEnd = min(units.count, windowStart + maxLength)
        let slice = JSWhitespace.trim(string(units[windowStart ..< windowEnd]))
        return (windowStart > 0 ? "..." : "") + slice + (windowEnd < units.count ? "..." : "")
    }

    /// `\p{L}` / `\p{N}`.
    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                .decimalNumber, .letterNumber, .otherNumber:
                true
            default: false
        }
    }

    private static func truncate(_ units: [UInt16], _ maxLength: Int) -> String {
        if units.count <= maxLength { return string(units[...]) }
        return JSWhitespace.trim(string(units[..<max(0, maxLength - 3)])) + "..."
    }

    private static func indexOf(_ needle: [UInt16], in haystack: [UInt16]) -> Int? {
        guard !needle.isEmpty, needle.count <= haystack.count else { return needle.isEmpty ? 0 : nil }
        for start in 0 ... (haystack.count - needle.count) where haystack[start] == needle[0] {
            if haystack[start ..< start + needle.count].elementsEqual(needle) { return start }
        }
        return nil
    }

    private static func string(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units, as: UTF16.self)
    }
}
