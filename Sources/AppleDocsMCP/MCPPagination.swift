import AemiJSONCore
import AppleDocsContent
import AppleDocsOutput
import OrderedCollections

/// Port of Bun's `mcp/pagination.js` + `pagination/page-builder.js`: array pagination and document
/// pagination (single page, matches, section bucketing with oversized-section splitting, text window), all
/// budgeted against `JSON.stringify(payload).length` of the *rich* envelope, before projection.
enum MCPPagination {
    typealias Object = OrderedDictionary<String, JSONValue>
    static let minMaxChars = 512
    static let maxPlanIterations = 12
    static let minSectionFragmentChars = 160

    /// Thrown inside planning when one item cannot fit (Bun `PaginationItemTooLargeError`).
    struct ItemTooLarge: Error {
        let itemIndex: Int
    }

    static func length(_ value: JSONValue) -> Int { JavaScriptJSON.length(value) }

    static func outOfRange(_ page: Int, _ total: Int) -> MCPPaginationError {
        MCPPaginationError(message: "Page \(page) is out of range. Valid pages: 1-\(total).")
    }

    /// `paginateArrayField(payload, field, {maxChars, page, strategy})`.
    static func paginateArrayField(
        _ payload: JSONValue,
        field: String,
        maxChars: Int,
        page: Int,
        strategy: String = "items",
        preparing prepare: (inout Object) -> Void = { _ in }
    ) throws(MCPPaginationError) -> JSONValue {
        guard case .object(let base) = payload else { return payload }
        let items: [JSONValue] = if case .array(let list)? = base[field] { list } else { [] }
        let pages = try itemPages(items: items, maxChars: maxChars) { slice, index, total in
            var object = base
            prepare(&object)
            object[field] = .array(slice)
            object["pageInfo"] = itemPageInfo(index, total, maxChars, strategy, items.count, slice.count)
            return .object(object)
        }
        guard page >= 1, page <= pages.count else { throw outOfRange(page, pages.count) }
        return pages[page - 1]
    }

    /// ``arrayPlan(items:maxChars:build:)`` reporting a single oversized item as Bun's validation message.
    static func itemPages(
        items: [JSONValue],
        maxChars: Int,
        build: ([JSONValue], Int, Int) -> JSONValue
    ) throws(MCPPaginationError) -> [JSONValue] {
        do {
            return try arrayPlan(items: items, maxChars: maxChars, build: build)
        } catch {
            throw MCPPaginationError(
                message:
                    "A single item exceeds the maxChars budget (\(maxChars)). Increase maxChars or narrow the query."
            )
        }
    }

    /// Item-strategy `pageInfo` (array and match pagination).
    static func itemPageInfo(
        _ page: Int,
        _ total: Int,
        _ maxChars: Int,
        _ strategy: String,
        _ totalItems: Int,
        _ pageItems: Int
    ) -> JSONValue {
        .object([
            "page": .int(Int64(page)), "totalPages": .int(Int64(total)), "maxChars": .int(Int64(maxChars)),
            "hasNextPage": .bool(page < total), "hasPreviousPage": .bool(page > 1), "strategy": .string(strategy),
            "totalItems": .int(Int64(totalItems)), "pageItems": .int(Int64(pageItems))
        ])
    }

    /// The document payload with its note dropped, `content` replaced, and `sections` emptied (page bodies).
    static func pageBody(_ base: Object, content: JSONValue) -> Object {
        var object = base
        object.removeValue(forKey: "note")
        object["content"] = content
        object["sections"] = .array([])
        return object
    }

    /// `buildArrayPaginationPlan`: re-plans until the assumed page count is stable.
    static func arrayPlan(
        items: [JSONValue],
        maxChars: Int,
        build: ([JSONValue], Int, Int) -> JSONValue
    ) throws(ItemTooLarge) -> [JSONValue] {
        var assumed = 1
        var pages: [JSONValue] = []
        for _ in 0 ..< maxPlanIterations {
            pages = try arrayPages(items: items, totalPages: assumed, maxChars: maxChars, build: build)
            if pages.count == assumed { break }
            assumed = pages.count
        }
        return pages
    }

    /// `buildArrayPages`: greedy binary search for the longest slice that fits each page.
    static func arrayPages(
        items: [JSONValue],
        totalPages: Int,
        maxChars: Int,
        build: ([JSONValue], Int, Int) -> JSONValue
    ) throws(ItemTooLarge) -> [JSONValue] {
        try rangePages(count: items.count, totalPages: totalPages, maxChars: maxChars) { range, page, total in
            build(Array(items[range]), page, total)
        }
    }

    /// The greedy page split over item ranges (`buildArrayPages`), for builders that index precomputed data.
    static func rangePages(
        count: Int,
        totalPages: Int,
        maxChars: Int,
        build: (Range<Int>, Int, Int) -> JSONValue
    ) throws(ItemTooLarge) -> [JSONValue] {
        if count == 0 {
            let empty = build(0 ..< 0, 1, 1)
            if length(empty) > maxChars { throw ItemTooLarge(itemIndex: 0) }
            return [empty]
        }
        var pages: [JSONValue] = []
        var start = 0
        var pageIndex = 1
        while start < count {
            var low = start + 1
            var high = count
            var best = start
            while low <= high {
                let mid = (low + high) / 2
                if length(build(start ..< mid, pageIndex, totalPages)) <= maxChars {
                    best = mid
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            if best == start { throw ItemTooLarge(itemIndex: start) }
            pages.append(build(start ..< best, pageIndex, totalPages))
            start = best
            pageIndex += 1
        }
        return pages
    }
}
