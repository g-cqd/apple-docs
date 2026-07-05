// The `match` excerpt builder — a Swift port of the deleted JS
// `buildMatchedDocumentPayload` (`src/mcp/pagination.js` at commit `200a744`,
// the parent of `9078247` which deleted `src/mcp/*`) + its `excerptAroundMatch`
// helper (`src/mcp/pagination/text-utils.js`). Used by both `read_doc` and
// `search_docs`'s `read=true` mode (Tools+Lookup.swift) to narrow a document
// down to `...context...`-wrapped windows around each occurrence of a
// substring, instead of returning the full content.
//
// Named `MatchExcerpts` (plural) — distinct from `MatchExcerpt`
// (Tools+Inputs.swift), the `@Schemable` input struct describing ONE
// `match: {query, context, max, caseSensitive}` request.

import ADJSON
import ADStorage

enum MatchExcerpts {
    /// The resolved (default-filled) `match` request — `contextChars`/
    /// `maxMatches` mirror JS's `contextChars = 140`/`maxMatches = 5`
    /// defaults; the tool handler pre-validates both against the schema's
    /// advertised bounds (20-2000 / 1-50) before calling `build`.
    struct Options {
        var query: String
        var contextChars: Int
        var maxMatches: Int
        var caseSensitive: Bool
    }

    struct Result {
        /// `[{sectionKind, heading, excerpt}]`, already in wire shape.
        var matches: [JSONValue]
        var note: String
    }

    /// `buildMatchedDocumentPayload`'s scan loop: walks `sections` in order,
    /// searching each `contentText` for `query` (case-folded unless
    /// `caseSensitive`), emitting up to `maxMatches` excerpt windows. `query`
    /// may be empty (the schema has no `minLength`) — JS's
    /// `String.indexOf('', n) === n` makes an empty needle "match" at every
    /// position; `find` mirrors that exactly.
    static func build(sections: [DocumentSectionRow], options: Options) -> Result {
        let needle = Array((options.caseSensitive ? options.query : options.query.lowercased()).utf16)
        let matchLength = options.query.utf16.count
        var matches: [JSONValue] = []

        sectionLoop: for section in sections {
            let haystackText = section.contentText ?? ""
            if haystackText.isEmpty { continue }
            let haystack = Array(haystackText.utf16)
            let scan = options.caseSensitive ? haystack : Array(haystackText.lowercased().utf16)

            var offset = 0
            while offset < scan.count {
                guard let index = find(needle, in: scan, from: offset) else { break }
                matches.append(
                    .object([
                        "sectionKind": section.sectionKind.map(JSONValue.string) ?? .null,
                        "heading": section.heading.map(JSONValue.string) ?? .null,
                        "excerpt": .string(
                            excerpt(
                                around: haystack, index: index, matchLength: matchLength,
                                contextChars: options.contextChars))
                    ]))
                if matches.count >= options.maxMatches { break sectionLoop }
                offset = index + max(needle.count, 1)
            }
        }

        let note =
            matches.isEmpty
            ? "No matches found for \"\(options.query)\"."
            : "Showing \(matches.count) match\(matches.count == 1 ? "" : "es") for \"\(options.query)\"."
        return Result(matches: matches, note: note)
    }

    /// `scan.indexOf(needle, offset)`: the first occurrence at/after
    /// `offset`, or nil. An empty `needle` "matches" at `offset` itself
    /// (guaranteed `<= haystack.count` by the caller's `while offset <
    /// scan.count` loop condition), exactly like JS's empty-string `indexOf`.
    private static func find(_ needle: [UInt16], in haystack: [UInt16], from offset: Int) -> Int? {
        if needle.isEmpty { return offset }
        guard offset + needle.count <= haystack.count else { return nil }
        var i = offset
        while i + needle.count <= haystack.count {
            if Array(haystack[i ..< i + needle.count]) == needle { return i }
            i += 1
        }
        return nil
    }

    /// `excerptAroundMatch(text, index, matchLength, contextChars)`: a window
    /// of `contextChars` on each side of the match (by UTF-16 offset),
    /// trimmed, with `...` markers where the window was truncated.
    private static func excerpt(around text: [UInt16], index: Int, matchLength: Int, contextChars: Int)
        -> String
    {
        let start = max(0, index - contextChars)
        let end = min(text.count, index + matchLength + contextChars)
        let core = Pagination.trimmedUTF16(text, start, end)
        let prefix = start > 0 ? "..." : ""
        let suffix = end < text.count ? "..." : ""
        return prefix + core + suffix
    }
}

/// The `match` sub-object's own schema-advertised bounds (`context` 20-2000,
/// `max` 1-50) — advisory-only under ADJSON's `@SchemaNumber` (see
/// `QueryParse.swift`), so rejected here instead of silently clamped.
func validateMatchBounds(_ match: MatchExcerpt) -> String? {
    validateBound(match.context, 20 ... 2000, field: "match.context")
        ?? validateBound(match.max, 1 ... 50, field: "match.max")
}
