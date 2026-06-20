// Gate for SwiftOrgAdapter: the pure normalize (HtmlNormalize over ADHTML + brand-suffix strip),
// the curated discover list, and fetch/check over the stub HTTPClient.

import HTTPTypes
import Testing

@testable import ADBuilder

struct SwiftOrgAdapterTests {
    private func context(_ handler: @escaping @Sendable (HTTPClientRequest) -> HTTPClientResponse)
        -> SourceContext
    { SourceContext(client: StubHTTPClient(handler), rateLimiter: instantRateLimiter()) }

    @Test func normalizeStripsBrandAndSetsFields() throws {
        let html = """
            <html><head><title>Install | Swift.org</title></head>
            <body><main><h1>Install</h1><p>Get Swift.</p><h2>Linux</h2><p>apt.</p></main></body></html>
            """
        let page = try SwiftOrgAdapter().normalize("swift-org/install", .html(html))
        #expect(page.document.title == "Install")
        #expect(page.document.sourceType == "swift-org")
        #expect(page.document.framework == "swift-org")
        #expect(page.document.url == "https://swift.org/install")
        #expect(page.sections.contains { $0.heading == "Linux" && $0.contentText == "apt." })
    }

    @Test func discoverReturnsCuratedKeys() async throws {
        let result = try await SwiftOrgAdapter().discover(context { _ in httpResponse(200) })
        #expect(result.keys.contains("swift-org/install/linux"))
        #expect(result.keys.allSatisfy { $0.hasPrefix("swift-org/") })
        #expect(result.roots.first?.slug == "swift-org")
    }

    @Test func fetchReturnsHtmlPayloadAndValidators() async throws {
        let ctx = context { _ in httpResponse(200, body: "<h1>Hi</h1>", headerFields: [.eTag: "\"v1\""]) }
        let result = try await SwiftOrgAdapter().fetch("swift-org/about", ctx)
        guard case .html(let html) = result.payload else {
            #expect(Bool(false), "expected .html payload")
            return
        }
        #expect(html == "<h1>Hi</h1>")
        #expect(result.etag == "\"v1\"")
    }

    @Test func checkMapsConditionalStatuses() async throws {
        let adapter = SwiftOrgAdapter()
        let unchanged = try await adapter.check(
            "swift-org/about", previousState: "\"v1\"", context { _ in httpResponse(304) })
        #expect(unchanged.status == .unchanged)

        let modified = try await adapter.check(
            "swift-org/about", previousState: nil,
            context { _ in httpResponse(200, headerFields: [.eTag: "\"v2\""]) })
        #expect(modified.changed)
        #expect(modified.newState == "\"v2\"")

        let deleted = try await adapter.check(
            "swift-org/about", previousState: nil, context { _ in httpResponse(404) })
        #expect(deleted.deleted)
    }

    @Test func normalizeResolvesRelativeLinksToAbsolute() throws {
        let html =
            "<main><h2>Links</h2><p>see <a href=\"/install/linux\">linux</a> and <a href=\"https://example.com\">ext</a></p></main>"
        let page = try SwiftOrgAdapter().normalize("swift-org/about", .html(html))
        let section = page.sections.first { $0.heading == "Links" }
        #expect(
            section?.contentText
                == "see [linux](https://swift.org/install/linux) and [ext](https://example.com)")
    }

    @Test func brandSuffixStrippingVariants() {
        #expect(SwiftOrgAdapter.stripBrandSuffix("About — Swift.org") == "About")
        #expect(SwiftOrgAdapter.stripBrandSuffix("Install - Swift.org") == "Install")
        #expect(SwiftOrgAdapter.stripBrandSuffix("No Brand Here") == "No Brand Here")
        #expect(SwiftOrgAdapter.stripBrandSuffix("Swift.org") == "Swift.org")  // bare brand kept
    }
}
