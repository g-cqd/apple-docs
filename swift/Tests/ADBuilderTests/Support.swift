// Shared test support for ADBuilder: an in-memory HTTPClient stub (handler-driven, no
// network) and a response builder, used by the GitHubClient + adapter gates.

import HTTPTypes
import Synchronization

@testable import ADBuilder

/// A handler-driven `HTTPClient` stub — each `send` returns `handler(request)`. The request log is
/// `Mutex`-guarded so concurrent `send`s (adapters fetch in parallel; the thread sanitizer flagged the
/// former unguarded append) don't race — which also makes the stub a checked `Sendable`.
final class StubHTTPClient: HTTPClient {
    let handler: @Sendable (HTTPClientRequest) -> HTTPClientResponse
    private let requestLog = Mutex<[HTTPClientRequest]>([])

    /// The requests seen so far, in order (a snapshot taken under the lock).
    var requests: [HTTPClientRequest] { requestLog.withLock { $0 } }

    init(_ handler: @escaping @Sendable (HTTPClientRequest) -> HTTPClientResponse) {
        self.handler = handler
    }

    func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        requestLog.withLock { $0.append(request) }
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
