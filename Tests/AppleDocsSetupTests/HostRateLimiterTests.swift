import AppleDocsSources
import Foundation
import Testing

@Suite("Host-bucketed rate limiter (Bun lib/per-host-rate-limiter.js)")
struct HostRateLimiterTests {
    @Test func `throttles secondary hosts politely while leaving the primary host at full rate`() async {
        let limiter = HostRateLimiter(
            primaryHosts: ["developer.apple.com"],
            primaryRate: 500,
            primaryBurst: 10,
            secondaryRate: 50,
            secondaryBurst: 1
        )
        let clock = ContinuousClock()
        let start = clock.now
        for _ in 0 ..< 8 {
            await limiter.acquire(url: "https://developer.apple.com/tutorials/data/documentation/swiftui.json")
        }
        #expect(clock.now - start < .milliseconds(25))

        let secondaryStart = clock.now
        for _ in 0 ..< 5 {
            await limiter.acquire(url: "https://raw.githubusercontent.com/swiftlang/swift-evolution/main/x.md")
        }
        #expect(clock.now - secondaryStart >= .milliseconds(75))
    }

    @Test func `distinct secondary hosts have independent buckets`() async {
        let limiter = HostRateLimiter(
            primaryHosts: [],
            primaryRate: 500,
            primaryBurst: 10,
            secondaryRate: 20,
            secondaryBurst: 2
        )
        let clock = ContinuousClock()
        let start = clock.now
        await limiter.acquire(url: "https://api.github.com/repos/a/b")
        await limiter.acquire(url: "https://api.github.com/repos/a/c")
        await limiter.acquire(url: "https://www.swift.org/documentation")
        await limiter.acquire(url: "https://www.swift.org/getting-started")
        #expect(clock.now - start < .milliseconds(25))
    }

    @Test func `UpstreamHTTPClient passes custom headers through to the transport`() async throws {
        let transport = RecordingTransport()
        transport.set("https://api.github.com/repos/swiftlang/swift-evolution/git/trees/main", body: "{}")
        let client = UpstreamHTTPClient(transport: transport)
        _ = try await client.get(
            url: "https://api.github.com/repos/swiftlang/swift-evolution/git/trees/main",
            headers: ["Authorization": "Bearer test-token", "X-GitHub-Api-Version": "2022-11-28"]
        )
        let sent = try #require(transport.requests.first)
        #expect(sent.headers["Authorization"] == "Bearer test-token")
        #expect(sent.headers["X-GitHub-Api-Version"] == "2022-11-28")
    }
}
