import AemiJSONCore
import AppleDocsOutput
import OrderedCollections
import Synchronization

/// Per-tool LRU cache of projected tool results — a port of Bun's `mcp/cache.js`.
///
/// Keys are the tool name, the canonical (key-sorted) arguments, and a corpus stamp (schema version and database
/// modification time, re-read at most every 5 s), so a re-sync invalidates every entry. Negative results (not
/// found, no hits) expire after a TTL; positive ones live until evicted. `APPLE_DOCS_MCP_CACHE=off` disables it.
final class MCPToolCache: Sendable {
    /// Bun's default capacities.
    static let defaultSizes: [String: Int] = [
        "search_docs": 100, "read_doc": 200, "browse": 100, "list_frameworks": 16, "list_taxonomy": 16
    ]

    private struct Entry {
        let value: JSONValue
        let expiresAt: UInt64?
    }

    private let sizes: [String: Int]
    private let negativeTTLMilliseconds: UInt64
    private let stamp: @Sendable () -> String
    private let now: @Sendable () -> UInt64
    private let entries = Mutex<[String: OrderedDictionary<String, Entry>]>([:])

    init(
        sizes: [String: Int] = defaultSizes,
        negativeTTLMilliseconds: UInt64 = 30_000,
        stamp: @escaping @Sendable () -> String,
        now: @escaping @Sendable () -> UInt64
    ) {
        self.sizes = sizes
        self.negativeTTLMilliseconds = negativeTTLMilliseconds
        self.stamp = stamp
        self.now = now
    }

    /// The cache key for a call, or `nil` when the tool is not cached.
    func key(tool: String, arguments: JSONValue) -> String? {
        guard sizes[tool] != nil else { return nil }
        return "\(tool)\u{1F}\(stamp())\u{1F}\(JavaScriptJSON.stringify(Self.canonical(arguments)))"
    }

    func lookup(_ key: String, tool: String) -> JSONValue? {
        let time = now()
        return entries.withLock { all -> JSONValue? in
            guard var bucket = all[tool], let entry = bucket[key] else { return nil }
            bucket.removeValue(forKey: key)
            if let expiry = entry.expiresAt, time >= expiry {
                all[tool] = bucket
                return nil
            }
            bucket[key] = entry  // most recently used last
            all[tool] = bucket
            return entry.value
        }
    }

    func store(_ value: JSONValue, for key: String, tool: String, negative: Bool) {
        guard let capacity = sizes[tool] else { return }
        let expiry = negative ? now() + negativeTTLMilliseconds : nil
        entries.withLock { all in
            var bucket = all[tool] ?? [:]
            bucket.removeValue(forKey: key)
            bucket[key] = Entry(value: value, expiresAt: expiry)
            while bucket.count > capacity { bucket.removeFirst() }
            all[tool] = bucket
        }
    }

    /// Arguments with object keys sorted recursively (`cacheKey`'s stable stringify).
    static func canonical(_ value: JSONValue) -> JSONValue {
        switch value {
            case .object(let members):
                var sorted = OrderedDictionary<String, JSONValue>()
                for key in members.keys.sorted() { sorted[key] = members[key].map(canonical) }
                return .object(sorted)
            case .array(let items): return .array(items.map(canonical))
            default: return value
        }
    }
}
