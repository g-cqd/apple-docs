// RateLimiter — the token-bucket the crawler acquires before each request (the port
// of src/lib/rate-limiter.js). POLICY, layered on the `HTTPClient` transport: the
// transport just bounds connections; this bounds the per-origin REQUEST rate.
//
// The bucket refills `rate` tokens/sec up to `burst` capacity; `acquire()` consumes
// one, waiting (cooperatively, via the clock) for a refill when the bucket is dry. An
// `actor` serializes the bucket so concurrent crawl tasks can't double-spend. Ordering
// is approximately FIFO (actor reentrancy across the wait), which is fine for rate
// shaping — the AGGREGATE rate is what's bounded. Pure stdlib (ContinuousClock/Duration).

/// Pure token-bucket arithmetic (no clock, no concurrency) — the testable core.
struct TokenBucket: Sendable {
    let rate: Double
    let burst: Double
    private(set) var tokens: Double

    init(rate: Double, burst: Double) {
        self.rate = rate
        self.burst = burst
        self.tokens = burst
    }

    /// Refill by `elapsedSeconds`, then try to consume one token. Returns `nil` when a
    /// token was consumed, or the seconds to wait before the next attempt otherwise.
    mutating func tryConsume(elapsedSeconds: Double) -> Double? {
        tokens = Swift.min(burst, tokens + elapsedSeconds * rate)
        if tokens >= 1 {
            tokens -= 1
            return nil
        }
        return (1 - tokens) / rate
    }
}

public actor RateLimiter {
    private var bucket: TokenBucket
    private let clock = ContinuousClock()
    private var lastRefill: ContinuousClock.Instant

    /// - Parameters:
    ///   - rate: tokens per second (JS default 5).
    ///   - burst: bucket capacity (JS default 2).
    public init(rate: Double = 5, burst: Double = 2) {
        self.bucket = TokenBucket(rate: rate, burst: burst)
        self.lastRefill = clock.now
    }

    /// Acquire one token, waiting for a refill when the bucket is dry. Honors `Task`
    /// cancellation (the clock sleep is cancellable).
    public func acquire() async throws {
        while true {
            let now = clock.now
            let elapsed = Self.seconds(lastRefill.duration(to: now))
            lastRefill = now
            guard let wait = bucket.tryConsume(elapsedSeconds: elapsed) else { return }
            try await clock.sleep(for: .seconds(wait))
        }
    }

    static func seconds(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}
