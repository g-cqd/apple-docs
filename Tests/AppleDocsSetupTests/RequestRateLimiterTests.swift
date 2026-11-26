import AppleDocsSources
import Foundation
import Synchronization
import Testing

@Suite("Request rate limiter (Bun lib/rate-limiter.js token bucket)")
struct RequestRateLimiterTests {
    @Test func `grants the burst immediately, then one request per 1/rate seconds`() async {
        let limiter = RequestRateLimiter(requestsPerSecond: 100, burst: 5)
        let clock = ContinuousClock()
        let start = clock.now
        for _ in 0 ..< 5 { await limiter.acquire() }
        #expect(clock.now - start < .milliseconds(20))
        for _ in 0 ..< 10 { await limiter.acquire() }
        let elapsed = clock.now - start
        #expect(elapsed >= .milliseconds(90) && elapsed < .milliseconds(400), "\(elapsed)")
    }

    @Test func `the client waits for a token before every request`() async throws {
        let transport = RecordingTransport()
        transport.set("https://developer.apple.com/x", body: "{}")
        let client = UpstreamHTTPClient(
            transport: transport,
            policy: UpstreamHTTPClient.Policy(requestsPerSecond: 50, burst: 1)
        )
        let clock = ContinuousClock()
        let start = clock.now
        for _ in 0 ..< 6 { _ = try await client.get(url: "https://developer.apple.com/x") }
        #expect(clock.now - start >= .milliseconds(95))
        #expect(transport.requests.count == 6)
    }
}
