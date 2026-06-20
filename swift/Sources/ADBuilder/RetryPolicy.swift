// RetryPolicy — the retry/backoff POLICY over the `HTTPClient` transport (the port of
// src/lib/fetch-with-retry.js). The transport returns every HTTP status verbatim; this
// decides which to retry, how long to wait, and which transport faults are terminal.
//
// The math is pure + injectable (`nowMillis`, jitter, sleep) so the gate verifies it
// deterministically without real time or a network. Foundation-free: the exponential
// base is a bit-shift, not `pow`, and `nowMillis` (for X-RateLimit-Reset) is supplied
// by the caller. `public import` — `HTTPFields` is in the public helper signatures.
public import HTTPTypes

/// Retry knobs (the JS `fetchWithRetry` opts defaults).
public struct RetryConfig: Sendable {
    /// Statuses retried with backoff (JS `retryableStatuses`).
    public var retryableStatuses: Set<Int>
    /// Max retries after the first attempt (JS `maxRetries` = 3).
    public var maxRetries: Int
    /// Random jitter ceiling in ms (JS `jitterMs` = 250).
    public var jitterMillis: Double

    public init(
        retryableStatuses: Set<Int> = [408, 429, 500, 502, 503, 504],
        maxRetries: Int = 3, jitterMillis: Double = 250
    ) {
        self.retryableStatuses = retryableStatuses
        self.maxRetries = maxRetries
        self.jitterMillis = jitterMillis
    }
}

/// What `fetchWithRetry` surfaces when retries are exhausted or the fault is terminal.
public enum FetchError: Error, Sendable, Equatable {
    /// A terminal transport fault (malformed URL / unsupported scheme), or the last
    /// retryable fault after `maxRetries`.
    case transport(HTTPClientError)
}

public enum RetryPolicy {
    // X-RateLimit-* / Retry-After aren't swift-http-types standard names; build once.
    static let retryAfter = HTTPField.Name("retry-after")!
    static let rateLimitRemaining = HTTPField.Name("x-ratelimit-remaining")!
    static let rateLimitReset = HTTPField.Name("x-ratelimit-reset")!

    /// GitHub's recoverable 403 (abuse / secondary rate limit): `403` plus either
    /// `X-RateLimit-Remaining: 0` or any `Retry-After`. A plain 403 is terminal.
    public static func isRecoverableForbidden(status: Int, headerFields: HTTPFields) -> Bool {
        guard status == 403 else { return false }
        if headerFields[rateLimitRemaining] == "0" { return true }
        return headerFields[retryAfter] != nil
    }

    /// The JS `classifyFetchError` split: a malformed URL / unsupported scheme is a
    /// programmer error (terminal, never burns a retry); every other transport fault
    /// (DNS / connect / TLS / timeout) is retryable. Cancellation is neither.
    public static func isTerminal(_ error: HTTPClientError) -> Bool {
        switch error {
            case .malformedURL, .unsupportedScheme: return true
            default: return false
        }
    }

    /// `retryDelayMs`: exponential `min(1000·2^attempt, 8000)` ms, but honor the
    /// upstream `Retry-After` (seconds) and `X-RateLimit-Reset` (epoch seconds → ms,
    /// capped at 60 s) when either points further out, then add `jitterMillis`.
    public static func retryDelayMillis(
        headerFields: HTTPFields, attempt: Int, jitterMillis: Double, nowMillis: Double
    ) -> Double {
        let base = Swift.min(Double(1000 * (1 << Swift.min(attempt, 13))), 8000)
        var upstream: Double = 0
        if let value = headerFields[retryAfter], let seconds = Int(value), seconds > 0 {
            upstream = Double(seconds) * 1000
        }
        if let value = headerFields[rateLimitReset], let resetEpoch = Int(value) {
            let millis = Double(resetEpoch) * 1000 - nowMillis
            if millis > 0 { upstream = Swift.max(upstream, Swift.min(millis, 60_000)) }
        }
        return Swift.max(upstream, base) + jitterMillis
    }

    /// Drive a request through the rate limiter + retry loop. Returns the response once
    /// it is non-retryable or retries are exhausted — the CALLER inspects the status
    /// (404 / parse) per RFC §6.3-6.4. `nowMillis` / `jitter` / `sleep` are injected so
    /// the loop is deterministic under test.
    public static func fetchWithRetry(
        _ request: HTTPClientRequest,
        using client: some HTTPClient,
        rateLimiter: RateLimiter? = nil,
        config: RetryConfig = RetryConfig(),
        nowMillis: @Sendable () -> Double = { 0 },
        jitter: @Sendable () -> Double = { Double.random(in: 0 ..< 250) },
        sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async throws -> HTTPClientResponse {
        var attempt = 0
        while true {
            try await rateLimiter?.acquire()
            do {
                let response = try await client.send(request)
                let status = response.status.code
                let retryable =
                    config.retryableStatuses.contains(status)
                    || isRecoverableForbidden(status: status, headerFields: response.headerFields)
                guard retryable, attempt < config.maxRetries else { return response }
                let delay = retryDelayMillis(
                    headerFields: response.headerFields, attempt: attempt,
                    jitterMillis: jitter(), nowMillis: nowMillis())
                try await sleep(.milliseconds(Int(delay)))
                attempt += 1
            } catch let error as HTTPClientError {
                // Cancellation propagates; terminal faults surface; the rest retry.
                if case .cancelled = error { throw FetchError.transport(error) }
                guard !isTerminal(error), attempt < config.maxRetries else {
                    throw FetchError.transport(error)
                }
                let delay = retryDelayMillis(
                    headerFields: [:], attempt: attempt, jitterMillis: jitter(),
                    nowMillis: nowMillis())
                try await sleep(.milliseconds(Int(delay)))
                attempt += 1
            }
        }
    }
}
