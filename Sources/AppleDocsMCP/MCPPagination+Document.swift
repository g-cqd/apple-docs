import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import AppleDocsOutput
import OrderedCollections

/// Document pagination (`paginateDocumentPayload`) and match narrowing (`buildMatchedDocumentPayload`).
extension MCPPagination {
    struct PageInfo {
        let page: Int
        let totalPages: Int
        let maxChars: Int
        let strategy: String
        let totalSections: Int
        let pageSections: Int
    }

    /// `withDocumentPageInfo`.
    static func withPageInfo(_ payload: Object, _ info: PageInfo) -> JSONValue {
        var object = payload
        object["pageInfo"] = .object([
            "page": .int(Int64(info.page)), "totalPages": .int(Int64(info.totalPages)),
            "maxChars": .int(Int64(info.maxChars)), "hasNextPage": .bool(info.page < info.totalPages),
            "hasPreviousPage": .bool(info.page > 1), "strategy": .string(info.strategy),
            "totalSections": .int(Int64(info.totalSections)), "pageSections": .int(Int64(info.pageSections))
        ])
        return .object(object)
    }

    static func paginateDocument(
        _ payload: JSONValue,
        maxChars: Int,
        page: Int
    ) throws(MCPPaginationError) -> JSONValue {
        guard case .object(let base) = payload else { return payload }
        let sections: [JSONValue] = if case .array(let list)? = base["sections"] { list } else { [] }
        var sanitized = base
        sanitized["sections"] = .array([])
        let hasMatches = base["matches"].map(MCPPayloadProjection.isTruthy) ?? false
        let single = withPageInfo(
            sanitized,
            PageInfo(
                page: 1,
                totalPages: 1,
                maxChars: maxChars,
                strategy: hasMatches ? "matches" : "document",
                totalSections: sections.count,
                pageSections: sections.count
            )
        )
        if length(single) <= maxChars {
            guard page == 1 else {
                throw MCPPaginationError(message: "Page 1 is the only available page for this response.")
            }
            return single
        }
        if hasMatches { return try paginateMatches(base, maxChars: maxChars, page: page) }
        if sections.isEmpty { return try paginateTextWindow(base, maxChars: maxChars, page: page) }
        guard let pages = sectionPlan(base, sections: sections, maxChars: maxChars) else {
            return try paginateTextWindow(base, maxChars: maxChars, page: page)
        }
        guard page >= 1, page <= pages.count else { throw outOfRange(page, pages.count) }
        return pages[page - 1]
    }

    /// Section bucketing, splitting an oversized section until it fits; `nil` falls back to text windows.
    private static func sectionPlan(_ base: Object, sections: [JSONValue], maxChars: Int) -> [JSONValue]? {
        var units = sections.map(DocumentSectionRecordJS.init)
        // Sections render once per plan; candidate pages only re-assemble them (Bun re-renders every probe).
        var rendered = units.map { BunMarkdownRenderer.renderSection($0.record) }
        var assumed = 1
        var strategy = "sections"
        var result: [JSONValue]?
        for _ in 0 ..< maxPlanIterations {
            do {
                let unitCount = units.count
                let pages = try rangePages(count: units.count, totalPages: assumed, maxChars: maxChars) {
                    range,
                    index,
                    total in
                    documentPage(
                        base,
                        rendered: rendered[range],
                        info: PageInfo(
                            page: index,
                            totalPages: total,
                            maxChars: maxChars,
                            strategy: strategy,
                            totalSections: unitCount,
                            pageSections: range.count
                        )
                    )
                }
                result = pages
                if pages.count == assumed { break }
                assumed = pages.count
            } catch {
                let oversized = units[error.itemIndex]
                let current = oversized.text.length
                let target = max(minSectionFragmentChars, min(current / 2, Int(Double(maxChars) * 0.75)))
                let split = splitOversized(oversized, target: target)
                if split.count <= 1 { return nil }
                units.replaceSubrange(error.itemIndex ... error.itemIndex, with: split)
                rendered.replaceSubrange(
                    error.itemIndex ... error.itemIndex,
                    with: split.map { BunMarkdownRenderer.renderSection($0.record) }
                )
                assumed = max(assumed, 1)
                strategy = "section-fragments"
                result = nil
            }
        }
        return result
    }

    /// `buildDocumentPagePayload`: the page's sections re-rendered (front matter and title on page 1 only).
    private static func documentPage(_ base: Object, rendered: ArraySlice<String>, info: PageInfo) -> JSONValue {
        let metadata = base["metadata"]
        func field(_ key: String) -> String? {
            if case .string(let text)? = MCPPayloadProjection.member(metadata, key) { return text }
            return nil
        }
        let header = BunMarkdownRenderer.Header(
            key: field("path") ?? "",
            title: field("title"),
            framework: field("framework"),
            role: nil,
            roleHeading: field("roleHeading"),
            platformsJSON: nil
        )
        let content = BunMarkdownRenderer.assemble(
            header,
            renderedSections: Array(rendered),
            includeFrontMatter: info.page == 1,
            includeTitle: info.page == 1
        )
        return withPageInfo(pageBody(base, content: .string(content)), info)
    }
}
