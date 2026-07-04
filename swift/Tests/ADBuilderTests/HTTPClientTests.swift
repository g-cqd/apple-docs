// The HTTP-client SEAM gate (D3b foundation): the value types + the streamed
// `ResponseBody` logic of the interim URLSession client. No live network — the live
// transport behavior is proven by the end-to-end crawl gate once the pipeline lands;
// this fixes the seam the crawler codes against (rfcs/adserve-http-client-requirements.md).

import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("HTTPClient seam — request/response value types + ResponseBody")
struct HTTPClientTests {
    @Test("collect(upTo:) buffers a fully-in-memory body")
    func collectBuffered() async throws {
        let body = ResponseBody(buffered: Array("hello world".utf8))
        let bytes = try await body.collect(upTo: 1024)
        #expect(bytes == Array("hello world".utf8))
    }

    @Test("collect(upTo:) concatenates a multi-chunk stream in order")
    func collectStreamed() async throws {
        let foo = Array("foo".utf8)[...]
        let bar = Array("bar".utf8)[...]
        let stream = AsyncThrowingStream<ArraySlice<UInt8>, any Error> { continuation in
            continuation.yield(foo)
            continuation.yield(bar)
            continuation.finish()
        }
        let bytes = try await ResponseBody(stream).collect(upTo: 1024)
        #expect(bytes == Array("foobar".utf8))
    }

    @Test("collect(upTo:) throws bodyTooLarge past the cap")
    func collectTooLarge() async throws {
        let body = ResponseBody(buffered: Array(repeating: UInt8(0), count: 100))
        await #expect(throws: HTTPClientError.bodyTooLarge(limit: 16)) {
            _ = try await body.collect(upTo: 16)
        }
    }

    @Test("async iteration yields the body chunks")
    func iterate() async throws {
        let body = ResponseBody(buffered: Array("abc".utf8))
        var collected: [UInt8] = []
        for try await chunk in body { collected.append(contentsOf: chunk) }
        #expect(collected == Array("abc".utf8))
    }

    @Test("request defaults: 30s deadline, follow ≤5 redirects, no body")
    func requestDefaults() throws {
        let head = HTTPRequest(
            method: .get, scheme: "https", authority: "developer.apple.com", path: "/")
        let request = HTTPClientRequest(head)
        #expect(request.body == nil)
        #expect(request.deadline == .seconds(30))
        #expect(request.redirect == .follow(max: 5))
    }

    @Test("Duration → seconds for the URLSession timeout")
    func durationSeconds() {
        #expect(URLSessionHTTPClient.seconds(.seconds(30)) == 30)
        #expect(URLSessionHTTPClient.seconds(.milliseconds(1500)) == 1.5)
    }
}
