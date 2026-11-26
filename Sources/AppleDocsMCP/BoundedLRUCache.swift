/// Fixed-capacity O(1) Least Recently Used (LRU) response cache protected by a Swift actor
/// (no GCD, no unbounded memory growth — Threat Model T-04).
public actor BoundedLRUCache<Key: Hashable & Sendable, Value: Sendable> {
    private let capacity: Int
    private var entries: [Key: Value] = [:]
    private var order: [Key] = []

    /// Creates a cache retaining at most `capacity` entries (clamped to `>= 1`).
    public init(capacity: Int = 256) {
        self.capacity = max(1, capacity)
        self.entries.reserveCapacity(self.capacity)
        self.order.reserveCapacity(self.capacity)
    }

    /// Returns the cached value for `key` and marks it most-recently-used, or `nil` on miss.
    public func get(_ key: Key) -> Value? {
        guard let value = entries[key] else { return nil }
        touch(key)
        return value
    }

    /// Inserts or updates `value` for `key`, evicting the least-recently-used key when full.
    public func set(_ key: Key, value: Value) {
        if entries[key] != nil {
            entries[key] = value
            touch(key)
            return
        }
        if entries.count >= capacity, let oldest = order.first {
            order.removeFirst()
            entries.removeValue(forKey: oldest)
        }
        entries[key] = value
        order.append(key)
    }

    /// Removes all cached entries.
    public func removeAll() {
        entries.removeAll(keepingCapacity: true)
        order.removeAll(keepingCapacity: true)
    }

    /// Current number of cached items.
    public var count: Int { entries.count }

    private func touch(_ key: Key) {
        if let idx = order.firstIndex(of: key) {
            order.remove(at: idx)
        }
        order.append(key)
    }
}
