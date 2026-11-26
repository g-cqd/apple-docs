import AemiHTTP
import AppleDocsCommands
import AppleDocsWeb
import Foundation
import Testing

@Suite("HTTP serving pipeline: metrics, compression, validators, caching")
struct WebServingPipelineTests {
    @Test func `metrics registry bounds labels and renders Prometheus text`() {
        let registry = HTTPMetricsRegistry(routes: ["/doc", "/api/search", "/assets"])
        registry.record(method: .get, path: "/doc/swiftui/view?x=1", status: .ok, duration: .milliseconds(3))
        registry.record(method: .get, path: "/doc/swiftui/text", status: .ok, duration: .milliseconds(30))
        registry.record(method: .get, path: "/random/\(UUID().uuidString)", status: .notFound, duration: .zero)
        registry.record(method: .get, path: "/api/searchable", status: .notFound, duration: .zero)

        let text = registry.renderPrometheus()
        #expect(text.contains(#"apple_docs_http_requests_total{method="GET",route="/doc",status="200"} 2"#))
        #expect(text.contains(#"apple_docs_http_requests_total{method="GET",route="other",status="404"} 2"#))
        #expect(text.contains(#"apple_docs_http_request_duration_seconds_bucket{route="/doc",le="0.005"} 1"#))
        #expect(text.contains(#"apple_docs_http_request_duration_seconds_bucket{route="/doc",le="+Inf"} 2"#))
        #expect(text.contains(#"apple_docs_http_request_duration_seconds_count{route="/doc"} 2"#))
        #expect(text.contains("# TYPE apple_docs_http_requests_total counter"))
        #expect(!text.contains("random"))
    }

    @Test func `serving chain compresses, validates, dates, caches, and exposes metrics`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }
        let registry = HTTPMetricsRegistry(routes: ["/", "/doc", "/assets"])
        let chain = PlatformHTTPServer.servingChain(
            for: responder,
            options: PlatformHTTPServer.Options(exposeMetrics: true),
            metrics: registry
        )

        var gzipHeaders = HTTPFields()
        _ = gzipHeaders.setValue("gzip", for: .acceptEncoding)
        let page = await chain.respond(to: HTTPRequest(method: .get, path: "/", headerFields: gzipHeaders))
        #expect(page.head.status == .ok)
        #expect(page.head.headerFields[.contentEncoding] == "gzip")
        #expect(page.head.headerFields[.vary]?.lowercased().contains("accept-encoding") == true)
        #expect(page.head.headerFields[.date] != nil)
        #expect(page.head.headerFields[.cacheControl] == "public, max-age=300")
        let etag = try #require(page.head.headerFields[.etag])

        var conditional = gzipHeaders
        _ = conditional.setValue(etag, for: .ifNoneMatch)
        let revalidated = await chain.respond(to: HTTPRequest(method: .get, path: "/", headerFields: conditional))
        #expect(revalidated.head.status == .notModified)
        #expect(revalidated.body.isEmpty)

        let asset = await chain.respond(to: HTTPRequest(method: .get, path: "/assets/app.js"))
        #expect(asset.head.headerFields[.cacheControl] == "public, max-age=86400")
        let missing = await chain.respond(to: HTTPRequest(method: .get, path: "/doc/none/here"))
        #expect(missing.head.headerFields[.cacheControl] == "no-store")

        let metrics = await chain.respond(to: HTTPRequest(method: .get, path: "/metrics"))
        #expect(metrics.head.status == .ok)
        #expect(metrics.head.headerFields[.contentType]?.hasPrefix("text/plain") == true)
        let body = String(decoding: metrics.body, as: UTF8.self)
        #expect(body.contains(#"apple_docs_http_requests_total{method="GET",route="/",status="200"} 1"#))
        #expect(body.contains(#"route="/",status="304"} 1"#))

        let hidden = PlatformHTTPServer.servingChain(
            for: responder,
            options: PlatformHTTPServer.Options(exposeMetrics: false),
            metrics: registry
        )
        let notExposed = await hidden.respond(to: HTTPRequest(method: .get, path: "/metrics"))
        #expect(notExposed.head.status == .notFound)
    }
}
