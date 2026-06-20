// Gate for the crawl POLICY layer (D3b foundation): the token-bucket arithmetic and
// the retry/backoff math + loop, all deterministic (injected now/jitter/sleep + a
// scripted in-memory client — no real time, no network), faithful to the JS
// rate-limiter.js + fetch-with-retry.js.

import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("Crawl policy — RateLimiter token bucket + RetryPolicy backoff/loop")
struct RetryPolicyTests {

    private func response(_ code: Int, _ headerFields: HTTPFields = [:]) -> HTTPClientResponse {
        HTTPClientResponse(
            status: HTTPResponse.Status(code: code), headerFields: headerFields,
            body: ResponseBody(buffered: []))
    }

    private func getRequest() -> HTTPClientRequest {
        HTTPClientRequest(HTTPRequest(method: .get, scheme: "https", authority: "x", path: "/"))
    }

    /// A scripted in-memory client: returns/throws the next entry per `send` (the last
    /// entry repeats). Single-threaded test use ⇒ `@unchecked Sendable` + unguarded counter.
    private final class ScriptedClient: HTTPClient, @unchecked Sendable {
        let script: [Result<HTTPClientResponse, HTTPClientError>]
        nonisolated(unsafe) private(set) var sendCount = 0
        init(_ script: [Result<HTTPClientResponse, HTTPClientError>]) { self.script = script }
        func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
            let index = Swift.min(sendCount, script.count - 1)
            sendCount += 1
            return try script[index].get()
        }
    }

    // MARK: - token bucket

    @Test("token bucket spends burst, then requires a time-proportional refill wait")
    func tokenBucket() {
        var bucket = TokenBucket(rate: 5, burst: 2)
        #expect(bucket.tryConsume(elapsedSeconds: 0) == nil)  // 2 → 1
        #expect(bucket.tryConsume(elapsedSeconds: 0) == nil)  // 1 → 0
        #expect(bucket.tryConsume(elapsedSeconds: 0) == 0.2)  // dry → wait 1/rate
        #expect(bucket.tryConsume(elapsedSeconds: 0.2) == nil)  // refilled 1 → consume
    }

    // MARK: - classification

    @Test("recoverable 403 needs X-RateLimit-Remaining:0 or Retry-After")
    func recoverableForbidden() {
        var remaining = HTTPFields()
        remaining[RetryPolicy.rateLimitRemaining] = "0"
        #expect(RetryPolicy.isRecoverableForbidden(status: 403, headerFields: remaining))
        var retry = HTTPFields()
        retry[RetryPolicy.retryAfter] = "30"
        #expect(RetryPolicy.isRecoverableForbidden(status: 403, headerFields: retry))
        #expect(!RetryPolicy.isRecoverableForbidden(status: 403, headerFields: [:]))
        #expect(!RetryPolicy.isRecoverableForbidden(status: 500, headerFields: remaining))
    }

    @Test("malformed URL / unsupported scheme are terminal; others retryable")
    func terminalClassification() {
        #expect(RetryPolicy.isTerminal(.malformedURL))
        #expect(RetryPolicy.isTerminal(.unsupportedScheme("ftp")))
        #expect(!RetryPolicy.isTerminal(.deadlineExceeded))
        #expect(!RetryPolicy.isTerminal(.connectionFailed("reset")))
    }

    // MARK: - backoff math

    @Test("retryDelay: exponential base, capped at 8000, plus jitter")
    func delayBase() {
        let zero = HTTPFields()
        #expect(RetryPolicy.retryDelayMillis(headerFields: zero, attempt: 0, jitterMillis: 0, nowMillis: 0) == 1000)
        #expect(RetryPolicy.retryDelayMillis(headerFields: zero, attempt: 3, jitterMillis: 0, nowMillis: 0) == 8000)
        #expect(RetryPolicy.retryDelayMillis(headerFields: zero, attempt: 9, jitterMillis: 50, nowMillis: 0) == 8050)
    }

    @Test("retryDelay honors Retry-After and X-RateLimit-Reset (capped 60s)")
    func delayUpstream() {
        var retry = HTTPFields()
        retry[RetryPolicy.retryAfter] = "5"
        #expect(RetryPolicy.retryDelayMillis(headerFields: retry, attempt: 0, jitterMillis: 0, nowMillis: 0) == 5000)
        var reset = HTTPFields()
        reset[RetryPolicy.rateLimitReset] = "100"  // epoch 100s
        let delay = RetryPolicy.retryDelayMillis(headerFields: reset, attempt: 0, jitterMillis: 0, nowMillis: 90_000)
        #expect(delay == 10_000)  // 100000ms − 90000ms, under the 60s cap, beats base
    }

    // MARK: - the loop

    @Test("fetchWithRetry retries a 429 then returns the 200")
    func retriesThenSucceeds() async throws {
        let client = ScriptedClient([.success(response(429)), .success(response(200))])
        let result = try await RetryPolicy.fetchWithRetry(
            getRequest(), using: client, nowMillis: { 0 }, jitter: { 0 }, sleep: { _ in })
        #expect(client.sendCount == 2)
        #expect(result.status.code == 200)
    }

    @Test("fetchWithRetry stops after maxRetries, returning the last response")
    func exhaustsRetries() async throws {
        let client = ScriptedClient([.success(response(503))])
        let result = try await RetryPolicy.fetchWithRetry(
            getRequest(), using: client, nowMillis: { 0 }, jitter: { 0 }, sleep: { _ in })
        #expect(client.sendCount == 4)  // 1 initial + 3 retries
        #expect(result.status.code == 503)
    }

    @Test("a terminal transport fault throws immediately, no retry")
    func terminalThrows() async throws {
        let client = ScriptedClient([.failure(.malformedURL)])
        await #expect(throws: FetchError.transport(.malformedURL)) {
            _ = try await RetryPolicy.fetchWithRetry(getRequest(), using: client, sleep: { _ in })
        }
        #expect(client.sendCount == 1)
    }
}
