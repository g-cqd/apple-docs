// Shared MCP response pagination — a Swift port of the deleted JS
// `src/mcp/pagination.js` + `src/mcp/pagination/page-builder.js` +
// `src/mcp/pagination/text-utils.js` (last live at commit `200a744`, the
// parent of `9078247` which deleted `src/mcp/*`; `git show 200a744:<path>`
// still reads them). Two paginators — array (item-boundary bin-packing) and
// text (UTF-16-boundary-snapped windows) — both binary-search against a
// serialized-JSON-length budget and both converge `totalPages` via the same
// bounded fixed-point loop JS uses (`buildArrayPaginationPlan`/
// `buildTextPaginationPlan`): a page embeds `"totalPages":N`, so the digit
// count can itself shift where a page boundary falls, hence the re-run.
//
// The public `pageInfo` shape mirrors what actually reaches an MCP client —
// NOT the richer internal shape these JS functions build. JS's own
// `projectPageInfo` (src/output/projection.js) allowlists ONLY
// `page/totalPages/hasNextPage/hasPreviousPage/totalItems` before a payload
// crosses the public-output boundary; `maxChars`, `strategy`,
// `totalSections`/`pageSections`/`pageItems` are internal-only and never
// serialize to a client. This module builds the allowlisted shape directly
// rather than modeling (and then stripping) the internal one.
//
// `DocumentPagination.swift` layers the read_doc/search_docs(read=true)
// document-shaped orchestration (text-window / section-bucket / matched-
// array strategy dispatch) on top of the primitives here.

import ADJSON

enum Pagination {
    /// `MIN_PAGINATED_MAX_CHARS` (pagination.js) — the schema's
    /// `@SchemaNumber(512...)` bound is advisory only (the ADJSON macro has no
    /// runtime enforcement; see `QueryParse.swift`), so this is the
    /// runtime-enforced floor `validateArgs` rejects below.
    static let minMaxChars = 512

    /// `MAX_PLAN_ITERATIONS` (page-builder.js) — the shared retry budget for
    /// both the totalPages fixed-point convergence and (in the document
    /// paginator) the oversized-section-splitting retries.
    static let maxPlanIterations = 12

    /// Every rejection this module raises, mirroring the JS `ValidationError`/
    /// `PaginationItemTooLargeError` messages exactly (both JS classes end up
    /// as the same MCP tool-error string, so one Swift error type suffices —
    /// see `MCPToolResult.failure` in ADMCP, the convention every other
    /// rejection in `Tools.swift` already uses).
    enum Failure: Error, Sendable {
        case pageOutOfRange(page: Int, totalPages: Int)
        case onlyPageOneAvailable
        case maxCharsTooSmall(maxChars: Int)
        case emptyPageTooLarge(maxChars: Int)
        case itemTooLarge(maxChars: Int, itemIndex: Int)

        var message: String {
            switch self {
                case .pageOutOfRange(let page, let totalPages):
                    "Page \(page) is out of range. Valid pages: 1-\(totalPages)."
                case .onlyPageOneAvailable:
                    "Page 1 is the only available page for this response."
                case .maxCharsTooSmall(let maxChars):
                    "The requested maxChars budget (\(maxChars)) is too small to return any content."
                case .emptyPageTooLarge(let maxChars):
                    "A single page exceeds the maxChars budget (\(maxChars)). Increase maxChars."
                case .itemTooLarge(let maxChars, _):
                    "A single item exceeds the maxChars budget (\(maxChars)). Increase maxChars or narrow the query."
            }
        }
    }

    /// `validatePaginationArgs` (server/helpers.js) + the `paginatedMaxChars`
    /// zod floor: `page` without `maxChars` is rejected, and `maxChars` under
    /// `minMaxChars` is rejected — both REJECT (not clamp), matching JS's
    /// zod-at-decode-time behavior instead of `QueryParse.swift`'s advisory
    /// server-side clamps.
    static func validateArgs(maxChars: Int?, page: Int?) -> String? {
        if let maxChars, maxChars < minMaxChars {
            return "maxChars must be at least \(minMaxChars)."
        }
        if page != nil, maxChars == nil {
            return "The page parameter requires maxChars."
        }
        return nil
    }

    /// The public `pageInfo` object (`projectPageInfo`'s allowlist):
    /// navigational fields only. `totalItems` is included only by the
    /// array-shaped strategies (list_frameworks/browse/search_docs.results/
    /// matches) — the text-window/section-bucket strategies never set it
    /// (JS's `withDocumentPageInfo` only carries `totalSections`/
    /// `pageSections`, both projection-dropped, so there is nothing to keep).
    static func pageInfoJSON(page: Int, totalPages: Int, totalItems: Int? = nil) -> JSONValue {
        var out: OrderedDictionary<String, JSONValue> = [
            "page": .int(Int64(page)), "totalPages": .int(Int64(totalPages)),
            "hasNextPage": .bool(page < totalPages), "hasPreviousPage": .bool(page > 1)
        ]
        if let totalItems { out["totalItems"] = .int(Int64(totalItems)) }
        return .object(out)
    }

    /// The exact byte length the dispatcher's wire encoding produces for
    /// `value` (`MCPDispatcher.toolsCallResult` calls `JSONValue.encoded()`
    /// with its default `.rfc8259` options), read back as a UTF-16 count — the
    /// same budget unit as JS's `serializePayload(payload).length`
    /// (`JSON.stringify(payload).length`, a UTF-16 `String.length`). Using the
    /// SAME options the dispatcher actually serializes with means a page that
    /// "fits" here really does fit in the bytes a client receives.
    static func serializedLength(_ value: JSONValue) -> Int {
        guard let bytes = try? value.encodedBytes() else { return .max }
        return String(decoding: bytes, as: UTF8.self).utf16.count
    }

    // MARK: - Array pagination (paginateArrayField / buildArrayPaginationPlan)

    /// Bin-packs `items` into pages under `maxChars`: each page is the LARGEST
    /// prefix of the remaining items whose `buildPage` payload still
    /// serializes within budget (a binary search per page), re-converging
    /// `totalPages` up to `maxPlanIterations` times because the embedded
    /// `"totalPages":N` digit count can itself shift a boundary. Generic over
    /// `Element` so the SAME bin-packer drives both plain JSON-array
    /// pagination (list_frameworks' roots, browse's pages/children,
    /// search_docs' results/matches) and the document paginator's
    /// section-bucket strategy (`DocumentPagination.swift`), whose units are
    /// typed section rows re-rendered to Markdown per page, not pre-built JSON.
    static func paginateArray<Element>(
        items: [Element], maxChars: Int, page: Int,
        buildPage: (_ slice: ArraySlice<Element>, _ pageIndex: Int, _ totalPages: Int) -> JSONValue
    ) throws(Failure) -> JSONValue {
        var assumedTotalPages = 1
        var pages: [JSONValue] = []
        for _ in 0 ..< maxPlanIterations {
            pages = try buildArrayPages(
                items: items, totalPages: assumedTotalPages, maxChars: maxChars, buildPage: buildPage)
            if pages.count == assumedTotalPages { break }
            assumedTotalPages = pages.count
        }
        guard page >= 1, page <= pages.count else {
            throw Failure.pageOutOfRange(page: page, totalPages: pages.count)
        }
        return pages[page - 1]
    }

    /// `buildArrayPages` (page-builder.js): one pass at a fixed `totalPages`
    /// guess. Thrown `.itemTooLarge(itemIndex:)` carries the offending index
    /// so a caller (the section-bucket retry loop) can split just that item
    /// and retry, rather than failing the whole page outright.
    static func buildArrayPages<Element>(
        items: [Element], totalPages: Int, maxChars: Int,
        buildPage: (ArraySlice<Element>, Int, Int) -> JSONValue
    ) throws(Failure) -> [JSONValue] {
        if items.isEmpty {
            let empty = buildPage(items[...], 1, 1)
            guard serializedLength(empty) <= maxChars else { throw Failure.emptyPageTooLarge(maxChars: maxChars) }
            return [empty]
        }

        var pages: [JSONValue] = []
        var start = 0
        var pageIndex = 1
        while start < items.count {
            var low = start + 1
            var high = items.count
            var best = start
            while low <= high {
                let mid = (low + high) / 2
                let candidate = buildPage(items[start ..< mid], pageIndex, totalPages)
                if serializedLength(candidate) <= maxChars {
                    best = mid
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            guard best > start else { throw Failure.itemTooLarge(maxChars: maxChars, itemIndex: start) }
            pages.append(buildPage(items[start ..< best], pageIndex, totalPages))
            start = best
            pageIndex += 1
        }
        return pages
    }

    // MARK: - Text-window pagination (buildTextPaginationPlan)

    /// Splits `text` into pages under `maxChars` via the same binary-search +
    /// fixed-point convergence as the array paginator, but slicing a STRING
    /// at UTF-16 offsets snapped to a paragraph/line/word boundary
    /// (`sliceAtBoundary`) instead of an item count. Operates on
    /// `text.utf16` (a raw `[UInt16]` snapshot) rather than Swift's grapheme-
    /// cluster `String` view so the slice points match JS's `String.slice`
    /// (UTF-16-indexed) exactly, including its edge cases around multi-unit
    /// characters.
    static func paginateText(
        _ text: String, maxChars: Int, page: Int,
        buildPage: (_ slice: String, _ pageIndex: Int, _ totalPages: Int) -> JSONValue
    ) throws(Failure) -> JSONValue {
        let units = Array(text.utf16)
        var assumedTotalPages = 1
        var pages: [JSONValue] = []
        for _ in 0 ..< maxPlanIterations {
            pages = try buildTextPages(
                units: units, totalPages: assumedTotalPages, maxChars: maxChars, buildPage: buildPage)
            if pages.count == assumedTotalPages { break }
            assumedTotalPages = pages.count
        }
        guard page >= 1, page <= pages.count else {
            throw Failure.pageOutOfRange(page: page, totalPages: pages.count)
        }
        return pages[page - 1]
    }

    private static func buildTextPages(
        units: [UInt16], totalPages: Int, maxChars: Int,
        buildPage: (String, Int, Int) -> JSONValue
    ) throws(Failure) -> [JSONValue] {
        if units.isEmpty {
            let empty = buildPage("", 1, 1)
            guard serializedLength(empty) <= maxChars else { throw Failure.emptyPageTooLarge(maxChars: maxChars) }
            return [empty]
        }

        var pages: [JSONValue] = []
        var start = 0
        var pageIndex = 1
        while start < units.count {
            start = skipWhitespace(units, start)
            if start >= units.count { break }

            var low = start + 1
            var high = units.count
            var best = start
            while low <= high {
                let mid = (low + high) / 2
                let slice = sliceAtBoundary(units, start: start, end: mid)
                let candidate = buildPage(slice.text, pageIndex, totalPages)
                if serializedLength(candidate) <= maxChars {
                    best = slice.end
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            guard best > start else { throw Failure.maxCharsTooSmall(maxChars: maxChars) }
            pages.append(buildPage(trimmedUTF16(units, start, best), pageIndex, totalPages))
            start = best
            pageIndex += 1
        }
        return pages
    }

    // MARK: - UTF-16 text shaping (text-utils.js)
    //
    // Shared by the text paginator above and (via `DocumentPagination.swift`
    // and `MatchExcerpt.swift`) the section-splitting and match-excerpt code —
    // every JS helper in `pagination/text-utils.js` operates on UTF-16
    // `String.length`/`.slice`, so one faithful port here backs all three.

    /// `sliceTextAtBoundary(text, start, end)`: the candidate window for one
    /// binary-search trial. The raw `[start,end)` run when `end` reaches the
    /// text's end; otherwise snapped back to the last `"\n\n"`/`"\n"`/`" "`
    /// inside the window UNLESS that boundary sits within `min(24,
    /// windowLength/4)` of `start` (too close — the page would end up
    /// near-empty), in which case the raw window is kept as-is. Returns the
    /// (already `.trim()`-ed) text alongside the FEASIBLE end offset the
    /// caller commits to once the binary search accepts this trial.
    static func sliceAtBoundary(_ units: [UInt16], start: Int, end: Int) -> (text: String, end: Int) {
        if end >= units.count {
            return (trimmedUTF16(units, start, units.count), units.count)
        }
        let windowLength = end - start
        let boundary = lastBoundary(units, start: start, end: end)
        if boundary < 0 || boundary <= min(24, windowLength / 4) {
            return (trimmedUTF16(units, start, end), end)
        }
        return (trimmedUTF16(units, start, start + boundary), start + boundary)
    }

    /// The relative offset (within `[start,end)`) of the last `"\n\n"`, else
    /// the last `"\n"`, else the last `" "` — `Math.max` of JS's three
    /// `lastIndexOf` calls, each `-1` when its pattern is absent.
    private static func lastBoundary(_ units: [UInt16], start: Int, end: Int) -> Int {
        let doubleNewline = lastIndex(of: [0x0A, 0x0A], in: units, start: start, end: end)
        let newline = lastIndex(of: [0x0A], in: units, start: start, end: end)
        let space = lastIndex(of: [0x20], in: units, start: start, end: end)
        return max(max(doubleNewline, newline), space)
    }

    /// `slice.lastIndexOf(pattern)`, relative to `start`; `-1` when absent.
    private static func lastIndex(of pattern: [UInt16], in units: [UInt16], start: Int, end: Int) -> Int {
        guard pattern.count <= end - start else { return -1 }
        var i = end - pattern.count
        while i >= start {
            if Array(units[i ..< i + pattern.count]) == pattern { return i - start }
            i -= 1
        }
        return -1
    }

    /// `skipWhitespace(text, start)`: advances past a run of JS `\s`-class
    /// code units.
    static func skipWhitespace(_ units: [UInt16], _ start: Int) -> Int {
        var index = start
        while index < units.count, isJSWhitespaceCodePoint(units[index]) { index += 1 }
        return index
    }

    /// `text.slice(start, end).trim()` — trims the JS `\s` class from both
    /// ends of the UTF-16 window, then decodes it to a `String`.
    static func trimmedUTF16(_ units: [UInt16], _ start: Int, _ end: Int) -> String {
        var lo = start
        var hi = end
        while lo < hi, isJSWhitespaceCodePoint(units[lo]) { lo += 1 }
        while hi > lo, isJSWhitespaceCodePoint(units[hi - 1]) { hi -= 1 }
        return String(decoding: units[lo ..< hi], as: UTF16.self)
    }

    /// The exact code-point set the ECMA-262 `\s` regex class (and
    /// `String.prototype.trim`) matches: TAB/LF/VT/FF/CR, SPACE, NBSP,
    /// the Unicode `Zs` (Space_Separator) members, the LS/PS line
    /// terminators, and the ZWNBSP/BOM. (Deliberately NOT Unicode's
    /// `White_Space` property, which is a different set — e.g. it includes
    /// NEL U+0085, which JS's `\s` excludes, and excludes U+FEFF, which JS's
    /// `\s` includes.)
    static func isJSWhitespaceCodePoint(_ unit: UInt16) -> Bool {
        switch unit {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029,
                0x202F, 0x205F, 0x3000, 0xFEFF:
                true
            default:
                false
        }
    }
}
