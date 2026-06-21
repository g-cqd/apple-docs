// The reproducible half of "run the interim transport live": drive the REAL `URLSessionHTTPClient.send`
// against a `URLProtocol` stub that intercepts URLSession and returns a canned status + headers + body,
// then assert the mapping onto `HTTPClientResponse` — the verbatim status (never collapsed), the
// `etag`/`lastModified` validators read from the response headers, and the buffered body via
// `collect(upTo:)`. This proves the URLSession conformer end-to-end with no external network (the existing
// HTTPClientTests only exercise the value types + the handler-driven stub, never the URLSession path).

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("URLSessionHTTPClient → HTTPClientResponse mapping (URLProtocol stub)", .serialized)
struct URLSessionHTTPClientMappingTests {
    /// A `URLProtocol` that answers every request with `Self.canned` — intercepting URLSession so the
    /// real `URLSessionHTTPClient.send` path runs without a network. The suite is `.serialized`, so the
    /// single shared slot is set + cleared within one test at a time.
    final class StubURLProtocol: URLProtocol {
        struct Canned: Sendable {
            var status: Int
            var headers: [String: String]
            var body: Data
        }
        nonisolated(unsafe) static var canned: Canned?

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func stopLoading() {}
        override func startLoading() {
            guard let canned = Self.canned, let url = request.url,
                let response = HTTPURLResponse(
                    url: url, statusCode: canned.status, httpVersion: "HTTP/1.1",
                    headerFields: canned.headers)
            else {
                client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !canned.body.isEmpty { client?.urlProtocol(self, didLoad: canned.body) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    /// A `URLSessionHTTPClient` over an ephemeral session wired to the stub protocol.
    private func makeClient() -> URLSessionHTTPClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSessionHTTPClient(session: URLSession(configuration: configuration))
    }

    private func getRequest() -> HTTPClientRequest {
        HTTPClientRequest(
            HTTPRequest(method: .get, scheme: "https", authority: "example.test", path: "/doc"))
    }

    @Test("200 maps status, ETag, Last-Modified, and the buffered body")
    func mapsOK() async throws {
        StubURLProtocol.canned = .init(
            status: 200,
            headers: [
                "ETag": "\"v1\"",
                "Last-Modified": "Mon, 01 Jan 2026 00:00:00 GMT",
                "Content-Type": "text/html; charset=utf-8"
            ],
            body: Data("<h1>hi</h1>".utf8))
        defer { StubURLProtocol.canned = nil }

        let response = try await makeClient().send(getRequest())

        #expect(response.status.code == 200)
        #expect(response.etag == "\"v1\"")
        #expect(response.lastModified == "Mon, 01 Jan 2026 00:00:00 GMT")
        let body = try await response.body.collect(upTo: 1 << 20)
        #expect(body == Array("<h1>hi</h1>".utf8))
    }

    @Test("304 surfaces the not-modified status (never collapsed) with the ETag and an empty body")
    func mapsNotModified() async throws {
        StubURLProtocol.canned = .init(status: 304, headers: ["ETag": "\"v1\""], body: Data())
        defer { StubURLProtocol.canned = nil }

        let response = try await makeClient().send(getRequest())

        #expect(response.status.code == 304)
        #expect(response.etag == "\"v1\"")
        let body = try await response.body.collect(upTo: 1 << 20)
        #expect(body.isEmpty)
    }

    @Test("a 404 is surfaced as a response, not thrown as a transport fault")
    func mapsNotFound() async throws {
        StubURLProtocol.canned = .init(status: 404, headers: [:], body: Data("not found".utf8))
        defer { StubURLProtocol.canned = nil }

        let response = try await makeClient().send(getRequest())

        #expect(response.status.code == 404)
        #expect(response.etag == nil)
        let body = try await response.body.collect(upTo: 1 << 20)
        #expect(body == Array("not found".utf8))
    }
}
