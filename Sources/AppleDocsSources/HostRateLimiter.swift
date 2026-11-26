import Foundation

/// Hostname-bucketed request pacer (Bun `lib/per-host-rate-limiter.js`): high-throughput primary
/// origins (`developer.apple.com`, `docs-assets.developer.apple.com`) run at `primaryRate`, while
/// secondary origins (`api.github.com`, `raw.githubusercontent.com`, `swift.org`, etc.) each get
/// an independent polite bucket in a bounded LRU map.
public actor HostRateLimiter {
    private let primaryHosts: Set<String>
    private let primaryBucket: RequestRateLimiter
    private let secondaryRate: Double
    private let secondaryBurst: Int
    private let maxBuckets: Int
    private var order: [String] = []
    private var buckets: [String: RequestRateLimiter] = [:]

    public init(
        primaryHosts: Set<String> = ["developer.apple.com", "docs-assets.developer.apple.com"],
        primaryRate: Double = 500,
        primaryBurst: Int? = nil,
        secondaryRate: Double = 20,
        secondaryBurst: Int = 10,
        maxBuckets: Int = 256
    ) {
        self.primaryHosts = Set(primaryHosts.map { $0.lowercased() })
        self.primaryBucket = RequestRateLimiter(
            requestsPerSecond: primaryRate,
            burst: primaryBurst ?? max(1, Int(primaryRate))
        )
        self.secondaryRate = max(0.001, secondaryRate)
        self.secondaryBurst = max(1, secondaryBurst)
        self.maxBuckets = max(1, maxBuckets)
    }

    /// Waits on the bucket governing `url`'s hostname.
    public func acquire(url: String) async {
        let bucket = bucketFor(url: url)
        await bucket.acquire()
    }

    private func bucketFor(url: String) -> RequestRateLimiter {
        let host = (URL(string: url)?.host ?? "*").lowercased()
        if primaryHosts.contains(host) {
            return primaryBucket
        }
        if let existing = buckets[host] {
            if let idx = order.firstIndex(of: host) { order.remove(at: idx) }
            order.append(host)
            return existing
        }
        let created = RequestRateLimiter(requestsPerSecond: secondaryRate, burst: secondaryBurst)
        buckets[host] = created
        order.append(host)
        if order.count > maxBuckets {
            let oldest = order.removeFirst()
            buckets.removeValue(forKey: oldest)
        }
        return created
    }
}
