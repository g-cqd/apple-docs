// Gate for the first real adapter (D3b): the Swift Evolution proposal header parser +
// the full normalize path (SourceAdapter → MarkdownSections → NormalizedPage), proving
// the adapter stack end-to-end. Pure — no network.

import Testing

@testable import ADBuilder

@Suite("SwiftEvolutionAdapter — proposal header + normalize")
struct SwiftEvolutionAdapterTests {

    private static let sample = """
        # Async Functions

        * Proposal: [SE-0296](0296-async-await.md)
        * Authors: [John Doe](https://example.com/jd), [Jane Roe](https://example.com/jr)
        * Review Manager: [Manager Name](https://example.com/mgr)
        * Status: **Implemented (Swift 5.5)**

        ## Introduction

        Async/await lets you write asynchronous code that reads like synchronous code.

        ## Motivation

        Completion handlers are error-prone.
        """

    @Test("parseProposalHeader extracts SE number, status, version, authors, manager")
    func header() {
        let header = SwiftEvolutionAdapter.parseProposalHeader(Self.sample)
        #expect(header.seNumber == "SE-0296")
        #expect(header.status == "Implemented (Swift 5.5)")
        #expect(header.swiftVersion == "5.5")
        #expect(header.authors == "John Doe, Jane Roe")
        #expect(header.reviewManager == "Manager Name")
    }

    @Test("normalize prefixes the title with the SE number and sets document metadata")
    func normalize() throws {
        let page = try SwiftEvolutionAdapter().normalize(
            "swift-evolution/0296-async-await", .markdown(Self.sample))
        #expect(page.document.title == "SE-0296: Async Functions")
        #expect(page.document.sourceType == "swift-evolution")
        #expect(page.document.kind == "proposal")
        #expect(page.document.framework == "swift-evolution")
        #expect(
            page.document.url
                == "https://github.com/swiftlang/swift-evolution/blob/main/proposals/0296-async-await.md")
        #expect(page.document.headings == "Introduction Motivation")
        #expect(page.sections.contains { $0.heading == "Motivation" })
    }

    @Test("network steps throw notImplemented until the GitHub client lands")
    func networkPending() async {
        let context = SourceContext(client: URLSessionHTTPClient(), rateLimiter: RateLimiter())
        await #expect(throws: AdapterError.self) {
            _ = try await SwiftEvolutionAdapter().discover(context)
        }
    }
}
