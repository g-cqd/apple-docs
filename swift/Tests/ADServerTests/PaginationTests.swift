// Regression coverage for the shared MCP pagination primitives
// (Sources/ADServer/Pagination.swift) — the Swift port of the deleted JS
// `src/mcp/pagination.js` family. Exercises the pure algorithms directly
// (no StorageConnection/DB needed); the document-shaped strategies
// (section-bucket / match-excerpt, which DO need a real corpus to render
// Markdown) are covered by the live stdio MCP functional check instead.

import ADJSON
import Testing

@testable import ad_server

@Suite struct PaginationValidateArgsTests {
    @Test func pageWithoutMaxCharsIsRejected() {
        #expect(Pagination.validateArgs(maxChars: nil, page: 2) != nil)
    }

    @Test func maxCharsBelowMinimumIsRejected() {
        #expect(Pagination.validateArgs(maxChars: 100, page: nil) != nil)
        #expect(Pagination.validateArgs(maxChars: Pagination.minMaxChars, page: nil) == nil)
    }

    @Test func validCombinationsAccepted() {
        #expect(Pagination.validateArgs(maxChars: nil, page: nil) == nil)
        #expect(Pagination.validateArgs(maxChars: 1000, page: 1) == nil)
    }
}

@Suite struct PaginationArrayTests {
    private func page(_ items: [JSONValue], maxChars: Int, page requested: Int) throws(Pagination.Failure)
        -> JSONValue
    {
        try Pagination.paginateArray(items: items, maxChars: maxChars, page: requested) {
            slice, pageIndex, totalPages in
            .object([
                "items": .array(Array(slice)),
                "pageInfo": Pagination.pageInfoJSON(page: pageIndex, totalPages: totalPages, totalItems: items.count)
            ])
        }
    }

    private func fields(_ value: JSONValue) -> (items: [JSONValue], pageInfo: OrderedDictionary<String, JSONValue>)? {
        guard case .object(let obj) = value, case .array(let items)? = obj["items"],
            case .object(let pageInfo)? = obj["pageInfo"]
        else { return nil }
        return (items, pageInfo)
    }

    @Test func fitsOnOnePageWhenBudgetIsGenerous() throws {
        let items = (1 ... 5).map { JSONValue.int(Int64($0)) }
        let result = try page(items, maxChars: 4096, page: 1)
        let parsed = try #require(fields(result))
        #expect(parsed.items.count == 5)
        #expect(parsed.pageInfo["page"] == .int(1))
        #expect(parsed.pageInfo["totalPages"] == .int(1))
        #expect(parsed.pageInfo["hasNextPage"] == .bool(false))
        #expect(parsed.pageInfo["hasPreviousPage"] == .bool(false))
        #expect(parsed.pageInfo["totalItems"] == .int(5))
    }

    @Test func splitsAcrossPagesUnderATightBudget() throws {
        let items = (1 ... 50).map { JSONValue.string("item-\($0)-with-some-padding-to-take-up-space") }
        let first = try page(items, maxChars: 400, page: 1)
        #expect(Pagination.serializedLength(first) <= 400)
        let parsed = try #require(fields(first))
        guard case .int(let totalPages)? = parsed.pageInfo["totalPages"] else {
            Issue.record("expected totalPages")
            return
        }
        #expect(totalPages > 1)
        #expect(parsed.pageInfo["hasNextPage"] == .bool(true))
        #expect(parsed.pageInfo["hasPreviousPage"] == .bool(false))

        // Every page individually stays within budget, and every item is
        // accounted for exactly once across all pages.
        var seenCount = 0
        for pageNumber in 1 ... Int(totalPages) {
            let onePage = try page(items, maxChars: 400, page: pageNumber)
            #expect(Pagination.serializedLength(onePage) <= 400)
            let onePageFields = try #require(fields(onePage))
            seenCount += onePageFields.items.count
        }
        #expect(seenCount == items.count)
    }

    @Test func rejectsPageBeyondTotalPages() {
        let items = [JSONValue.int(1), JSONValue.int(2)]
        #expect(throws: Pagination.Failure.self) {
            _ = try page(items, maxChars: 4096, page: 99)
        }
    }

    @Test func emptyArrayYieldsOnePage() throws {
        let result = try page([], maxChars: 4096, page: 1)
        let parsed = try #require(fields(result))
        #expect(parsed.items.isEmpty)
        #expect(parsed.pageInfo["totalPages"] == .int(1))
        #expect(parsed.pageInfo["totalItems"] == .int(0))
    }

    @Test func itemTooLargeForBudgetIsRejected() {
        // A single item's own serialized page already exceeds `maxChars` —
        // no amount of pagination can shrink it further.
        let items = [JSONValue.string(String(repeating: "x", count: 5000))]
        #expect(throws: Pagination.Failure.self) {
            _ = try page(items, maxChars: Pagination.minMaxChars, page: 1)
        }
    }
}

@Suite struct PaginationTextTests {
    private func page(_ text: String, maxChars: Int, page requested: Int) throws(Pagination.Failure)
        -> JSONValue
    {
        try Pagination.paginateText(text, maxChars: maxChars, page: requested) {
            slice, pageIndex, totalPages in
            .object([
                "content": .string(slice),
                "pageInfo": Pagination.pageInfoJSON(page: pageIndex, totalPages: totalPages)
            ])
        }
    }

    @Test func shortTextFitsOnOnePage() throws {
        let result = try page("Hello, world.", maxChars: 4096, page: 1)
        guard case .object(let obj) = result, case .string(let content)? = obj["content"] else {
            Issue.record("expected content string")
            return
        }
        #expect(content == "Hello, world.")
    }

    @Test func longTextSplitsAtWordBoundariesUnderBudget() throws {
        let words = (1 ... 400).map { "word\($0)" }
        let text = words.joined(separator: " ")
        let firstPage = try page(text, maxChars: 600, page: 1)
        #expect(Pagination.serializedLength(firstPage) <= 600)
        guard case .object(let obj) = firstPage, case .string(let content)? = obj["content"] else {
            Issue.record("expected content string")
            return
        }
        // The boundary-snap never splits a word in half: every token in the
        // first page's content is a complete "wordN" from the source list.
        for token in content.split(separator: " ") {
            #expect(words.contains(String(token)))
        }
    }

    @Test func maxCharsTooSmallForAnyContentIsRejected() {
        // `Pagination.paginateText` has no built-in floor (that is
        // `Pagination.validateArgs`'s job, enforced separately by the tool
        // handlers) — a budget this tiny can't fit even the JSON wrapper
        // around a single character, let alone real content.
        #expect(throws: Pagination.Failure.self) {
            _ = try page("some content that needs a real budget to fit", maxChars: 10, page: 1)
        }
    }

    @Test func rejectsPageBeyondTotalPages() throws {
        let text = Array(repeating: "word", count: 400).joined(separator: " ")
        #expect(throws: Pagination.Failure.self) {
            _ = try page(text, maxChars: 600, page: 9999)
        }
    }
}
