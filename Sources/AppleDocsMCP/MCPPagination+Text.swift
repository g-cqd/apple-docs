import AemiJSONCore
import AppleDocsOutput
import OrderedCollections

/// Text-window pagination, match pagination and narrowing, and Bun's text-shaping helpers (`text-utils.js`).
extension MCPPagination {
    static func paginateTextWindow(_ base: Object, maxChars: Int, page: Int) throws(MCPPaginationError) -> JSONValue {
        let content: String = if case .string(let text)? = base["content"] { text } else { "" }
        let text = JSText(content)
        let build: (String, Int, Int) -> JSONValue = { slice, index, total in
            withPageInfo(
                pageBody(base, content: .string(slice)),
                PageInfo(
                    page: index,
                    totalPages: total,
                    maxChars: maxChars,
                    strategy: "text-window",
                    totalSections: 0,
                    pageSections: 0
                )
            )
        }
        var assumed = 1
        var pages: [JSONValue] = []
        for _ in 0 ..< maxPlanIterations {
            pages = try textPages(text, totalPages: assumed, maxChars: maxChars, build: build)
            if pages.count == assumed { break }
            assumed = pages.count
        }
        guard page >= 1, page <= pages.count else { throw outOfRange(page, pages.count) }
        return pages[page - 1]
    }

    private static func textPages(
        _ text: JSText,
        totalPages: Int,
        maxChars: Int,
        build: (String, Int, Int) -> JSONValue
    ) throws(MCPPaginationError) -> [JSONValue] {
        if text.length == 0 {
            let empty = build("", 1, 1)
            guard length(empty) <= maxChars else {
                throw MCPPaginationError(
                    message: "A single page exceeds the maxChars budget (\(maxChars)). Increase maxChars."
                )
            }
            return [empty]
        }
        var pages: [JSONValue] = []
        var start = 0
        var pageIndex = 1
        while start < text.length {
            start = skipWhitespace(text, start)
            if start >= text.length { break }
            var low = start + 1
            var high = text.length
            var best = start
            while low <= high {
                let mid = (low + high) / 2
                let slice = sliceAtBoundary(text, start, mid)
                if length(build(slice.text.string, pageIndex, totalPages)) <= maxChars {
                    best = slice.end
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            guard best != start else {
                throw MCPPaginationError(
                    message: "The requested maxChars budget (\(maxChars)) is too small to return any content."
                )
            }
            pages.append(build(text.slice(start, best).trimmed().string, pageIndex, totalPages))
            start = best
            pageIndex += 1
        }
        return pages
    }

    static func paginateMatches(_ base: Object, maxChars: Int, page: Int) throws(MCPPaginationError) -> JSONValue {
        try paginateArrayField(.object(base), field: "matches", maxChars: maxChars, page: page, strategy: "matches") {
            $0.removeValue(forKey: "note")
            $0["content"] = .null
        }
    }

    /// `buildMatchedDocumentPayload`: replaces content with up to `maxMatches` excerpts around `match`.
    static func matched(
        _ payload: JSONValue,
        match: String,
        caseSensitive: Bool = false,
        contextChars: Int = 140,
        maxMatches: Int = 5
    ) -> JSONValue {
        guard case .object(var object) = payload else { return payload }
        let sections: [JSONValue] = if case .array(let list)? = object["sections"] { list } else { [] }
        let needle = JSText(caseSensitive ? match : match.lowercased())
        let matchLength = JSText(match).length
        var matches: [JSONValue] = []
        for section in sections where matches.count < maxMatches {
            let record = DocumentSectionRecordJS(json: section)
            guard record.text.length > 0 else { continue }
            let scan = caseSensitive ? record.text : JSText(record.text.string.lowercased())
            var offset = 0
            while offset < scan.length {
                let index = scan.indexOf(needle, from: offset)
                if index < 0 { break }
                matches.append(
                    .object([
                        "sectionKind": MCPPayloadProjection.member(section, "sectionKind") ?? .null,
                        "heading": MCPPayloadProjection.member(section, "heading") ?? .null,
                        "excerpt": .string(excerpt(record.text, index, matchLength, contextChars))
                    ])
                )
                if matches.count >= maxMatches { break }
                offset = index + max(needle.length, 1)
            }
        }
        object["content"] = .null
        object["matches"] = .array(matches)
        object["sections"] = .array([])
        let plural = matches.count == 1 ? "" : "es"
        object["note"] = .string(
            matches.isEmpty
                ? "No matches found for \"\(match)\"." : "Showing \(matches.count) match\(plural) for \"\(match)\"."
        )
        return .object(object)
    }

    static func excerpt(_ text: JSText, _ index: Int, _ matchLength: Int, _ context: Int) -> String {
        let start = max(0, index - context)
        let end = min(text.length, index + matchLength + context)
        let body = text.slice(start, end).trimmed().string
        return (start > 0 ? "..." : "") + body + (end < text.length ? "..." : "")
    }
}
