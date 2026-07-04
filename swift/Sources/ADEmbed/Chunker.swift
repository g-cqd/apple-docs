// Deterministic, dependency-free document chunker for the body-aware semantic
// index — the bit-exact port of `chunkDocument` (apple-docs src/search/chunker.js).
// Chunk 0 is the ANCHOR (title + abstract + headings, capped at 1200 chars), byte-
// identical to the legacy whole-doc embed input; then heading-aware body chunks
// from the kept sections, long ones split by a char-based sliding window. Pure:
// same input → same chunk list.
//
// JS STRING SEMANTICS (the parity contract): `slice`/`length` operate on UTF-16
// code units, so the anchor cap and the sliding window slice over `Array(text.utf16)`
// and rebuild with `String(decoding:as:UTF16.self)` — the same UTF-16 discipline the
// parity-proven `read` pagination uses. `String.trim()` and the `\s` test use
// `ADFUnicode.UnicodeSets.isJsWhitespace` (the JS WhiteSpace ∪ LineTerminator set).

private import ADFUnicode

public enum Chunker {
    /// One source section feeding the chunker (a `document_sections` row's prose).
    public struct Section: Sendable {
        public let kind: String
        public let heading: String?
        public let contentText: String?
        public init(kind: String, heading: String? = nil, contentText: String? = nil) {
            self.kind = kind
            self.heading = heading
            self.contentText = contentText
        }
    }

    /// Anchor input length cap — matches the JS `ANCHOR_MAX` (the historical
    /// `embedText()` slice), so chunk 0's embedding equals the pre-chunking one.
    static let anchorMax = 1200

    /// Section kinds carrying declaration / parameter / REST-schema noise rather
    /// than prose; everything else (discussion, overview, topics, …) is kept.
    static let skipSectionKinds: Set<String> = [
        "declaration", "parameters", "parameter", "returnvalue", "return value", "attributes", "availability"
    ]

    /// The anchor string: `[title, abstract, headings].filter(Boolean).join('. ')`
    /// truncated to `anchorMax` UTF-16 units. Empty/absent fields drop out (JS
    /// `filter(Boolean)`).
    public static func anchorText(title: String?, abstractText: String?, headings: String?) -> String {
        let joined = [title, abstractText, headings]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ". ")
        return sliceUTF16(joined, 0, anchorMax)
    }

    /// Split a document into embeddable chunk texts; chunk 0 is the anchor (always
    /// present). Mirrors `chunkDocument(doc, { maxChunks, windowChars, overlapChars })`.
    public static func chunkDocument(
        title: String?, abstractText: String?, headings: String?, sections: [Section],
        maxChunks: Int = 8, windowChars: Int = 880, overlapChars: Int = 160
    ) -> [String] {
        var chunks = [anchorText(title: title, abstractText: abstractText, headings: headings)]
        let hasAbstract = !(abstractText ?? "").isEmpty

        for section in sections {
            if chunks.count >= maxChunks { break }
            let kind = asciiLowercased(section.kind)
            if skipSectionKinds.contains(kind) || kind.hasPrefix("rest") { continue }
            // The abstract already rides in the anchor — don't spend a chunk slot on it.
            if kind == "abstract", hasAbstract { continue }
            let body = jsTrim(section.contentText ?? "")
            if body.isEmpty { continue }
            let heading = section.heading.map { "\($0). " } ?? ""
            for piece in slidingWindow(heading + body, size: windowChars, overlap: overlapChars) {
                if chunks.count >= maxChunks { break }
                chunks.append(piece)
            }
        }
        return chunks
    }

    /// Overlapping windows over UTF-16 units. One window when the text already fits;
    /// otherwise windows of `size` stepping by `max(1, size - overlap)`. Mirrors JS
    /// `slidingWindow` (`slice`/`length` are UTF-16).
    static func slidingWindow(_ text: String, size: Int, overlap: Int) -> [String] {
        let units = Array(text.utf16)
        if units.count <= size { return [text] }
        let step = Swift.max(1, size - overlap)
        var out: [String] = []
        var i = 0
        while i < units.count {
            let end = Swift.min(i + size, units.count)
            out.append(String(decoding: units[i ..< end], as: UTF16.self))
            if i + size >= units.count { break }
            i += step
        }
        return out
    }

    /// JS `text.slice(start, end)` over UTF-16 units (end clamped to length).
    static func sliceUTF16(_ text: String, _ start: Int, _ end: Int) -> String {
        let units = Array(text.utf16)
        let lo = Swift.max(0, Swift.min(start, units.count))
        let hi = Swift.max(lo, Swift.min(end, units.count))
        return String(decoding: units[lo ..< hi], as: UTF16.self)
    }

    /// JS `String.prototype.trim()` — strip leading/trailing JS whitespace
    /// (WhiteSpace ∪ LineTerminator, all BMP, so a scalar walk matches).
    static func jsTrim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var lo = 0
        var hi = scalars.count
        while lo < hi, UnicodeSets.isJsWhitespace(scalars[lo].value) { lo += 1 }
        while hi > lo, UnicodeSets.isJsWhitespace(scalars[hi - 1].value) { hi -= 1 }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[lo ..< hi])
        return String(out)
    }

    /// ASCII lowercase — the section-kind vocabulary is ASCII, so this matches JS
    /// `toLowerCase()` for every real kind without pulling the full case-folding table.
    static func asciiLowercased(_ text: String) -> String {
        String(
            String.UnicodeScalarView(
                text.unicodeScalars.map { s in
                    (s.value >= 0x41 && s.value <= 0x5A) ? Unicode.Scalar(s.value + 0x20)! : s
                }))
    }
}
