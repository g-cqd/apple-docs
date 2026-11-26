/// Request pacing shared by every request of a client: up to `burst` requests at once, then `requestsPerSecond` on
/// average (Bun's `lib/rate-limiter.js` token bucket, implemented as the equivalent generic cell rate algorithm).
/// Callers are served in arrival order.
public actor RequestRateLimiter {
    private let interval: Duration
    private let tolerance: Duration
    /// Theoretical arrival time of the next request.
    private var theoreticalArrival: ContinuousClock.Instant
    private let clock = ContinuousClock()

    public init(requestsPerSecond: Double, burst: Int) {
        let nanoseconds = Int64((1e9 / max(0.001, requestsPerSecond)).rounded(.up))
        self.interval = .nanoseconds(nanoseconds)
        self.tolerance = .nanoseconds(nanoseconds * Int64(max(1, burst) - 1))
        self.theoreticalArrival = ContinuousClock.now
    }

    /// Waits until a request may start.
    public func acquire() async {
        let now = clock.now
        let base = max(theoreticalArrival, now)
        let allowedAt = base - tolerance
        theoreticalArrival = base + interval
        if allowedAt > now {
            try? await Task.sleep(until: allowedAt, clock: clock)
        }
    }
}
