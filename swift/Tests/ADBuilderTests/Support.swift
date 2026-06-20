// Shared test support for ADBuilder: an in-memory HTTPClient stub (handler-driven, no
// network) and a response builder, used by the GitHubClient + adapter gates.

import HTTPTypes

@testable import ADBuilder

/// A handler-driven `HTTPClient` stub — each `send` returns `handler(request)`. Single-
/// threaded test use ⇒ `@unchecked Sendable` + an unguarded request log.
final class StubHTTPClient: HTTPClient, @unchecked Sendable {
    let handler: @Sendable (HTTPClientRequest) -> HTTPClientResponse
    nonisolated(unsafe) private(set) var requests: [HTTPClientRequest] = []

    init(_ handler: @escaping @Sendable (HTTPClientRequest) -> HTTPClientResponse) {
        self.handler = handler
    }

    func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        requests.append(request)
        return handler(request)
    }
}

/// Build a buffered `HTTPClientResponse` for the stub.
func httpResponse(_ code: Int, body: String = "", headerFields: HTTPFields = [:]) -> HTTPClientResponse {
    HTTPClientResponse(
        status: HTTPResponse.Status(code: code), headerFields: headerFields,
        body: ResponseBody(buffered: Array(body.utf8)))
}

/// A non-blocking rate limiter for tests (huge burst ⇒ `acquire()` never waits).
func instantRateLimiter() -> RateLimiter { RateLimiter(rate: 1_000_000, burst: 1_000_000) }
