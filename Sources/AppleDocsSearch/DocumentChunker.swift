public import AppleDocsCore

/// The texts embedded for one document — a port of Bun's `chunkDocument` (`search/chunker.js`): an anchor (title,
/// abstract, headings; at most 1,200 characters), then each eligible section's `heading. body` in sliding windows of
/// 880 characters overlapping by 160, at most 8 chunks. Lengths count UTF-16 code units like JavaScript; a window
/// that splits a surrogate pair yields U+FFFD where Bun keeps a lone surrogate.
public enum DocumentChunker {
    public static let maxChunks = 8
    static let anchorMax = 1_200
    static let windowChars = 880
    static let overlapChars = 160
    private static let skippedKinds: Set<String> = [
        "declaration", "parameters", "parameter", "returnvalue", "return value", "attributes", "availability"
    ]

    public static func chunks(
        title: String?,
        abstract: String?,
        headings: String?,
        sections: [DocumentSectionRecord]
    ) -> [String] {
        let anchorParts = [title, abstract, headings]
            .compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
        var chunks = [prefix(Array(anchorParts.joined(separator: ". ").utf16), anchorMax)]
        let hasAbstract = !(abstract ?? "").isEmpty
        for section in sections where chunks.count < maxChunks {
            let kind = section.sectionKind.lowercased()
            if skippedKinds.contains(kind) || kind.hasPrefix("rest") { continue }
            if kind == "abstract", hasAbstract { continue }
            let body = DocumentPlainText.trim(section.contentText)
            guard !body.isEmpty else { continue }
            let heading = section.heading.map { "\($0). " } ?? ""
            for piece in windows(Array((heading + body).utf16)) {
                guard chunks.count < maxChunks else { break }
                chunks.append(piece)
            }
        }
        return chunks
    }

    /// `slidingWindow(text, 880, 160)` over UTF-16 code units.
    private static func windows(_ units: [UInt16]) -> [String] {
        if units.count <= windowChars { return [string(units[...])] }
        let step = max(1, windowChars - overlapChars)
        var out: [String] = []
        var start = 0
        while start < units.count {
            out.append(string(units[start ..< min(start + windowChars, units.count)]))
            if start + windowChars >= units.count { break }
            start += step
        }
        return out
    }

    private static func prefix(_ units: [UInt16], _ limit: Int) -> String {
        string(units[..<min(limit, units.count)])
    }

    private static func string(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units, as: UTF16.self)
    }
}
