// Gate for the registry-driven crawl flow: resolve an adapter by source type, fetch over the stub
// transport, and normalize to a NormalizedPage — the dispatch path the crawl driver runs. (The
// persist half of the vertical — NormalizedPage → SQLite rows — is gated in ADBuilderPipelineTests.)

import HTTPTypes
import Testing

@testable import ADBuilder

struct CrawlDriverTests {
    @Test func registryResolvesAndDrivesSwiftOrg() async throws {
        let registry = SourceRegistry([SwiftOrgAdapter.self, SwiftEvolutionAdapter.self, SwiftBookAdapter.self])
        #expect(registry.types.contains("swift-org"))

        let adapter = try registry.adapter(for: "swift-org")
        let html = """
            <html><head><title>Install | Swift.org</title></head>
            <body><main><h1>Install</h1><p>Get Swift.</p><h2>Linux</h2><p>apt.</p></main></body></html>
            """
        let context = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200, body: html, headerFields: [.eTag: "\"v1\""]) },
            rateLimiter: instantRateLimiter())

        let fetched = try await adapter.fetch("swift-org/install", context)
        #expect(fetched.etag == "\"v1\"")

        let page = try adapter.normalize(fetched.key, fetched.payload)
        #expect(page.document.title == "Install")
        #expect(page.document.sourceType == "swift-org")
        #expect(page.document.url == "https://swift.org/install")
        #expect(page.sections.contains { $0.heading == "Linux" && $0.contentText == "apt." })
    }

    @Test func registryRejectsUnknownSourceType() {
        let registry = SourceRegistry([SwiftOrgAdapter.self])
        #expect(throws: SourceRegistry.RegistryError.unknownSourceType("nope")) {
            _ = try registry.adapter(for: "nope")
        }
    }
}
