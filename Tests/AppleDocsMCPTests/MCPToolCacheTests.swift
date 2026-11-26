import AemiJSONCore
import OrderedCollections
import Synchronization
import Testing

@testable import AppleDocsMCP

@Suite("MCP tool result cache (Bun mcp/cache.js)")
struct MCPToolCacheTests {
    @Test func `caches per tool and canonical arguments, evicts LRU, and keys on the corpus stamp`() throws {
        let stamp = Mutex("1:100")
        let cache = MCPToolCache(sizes: ["read_doc": 2], stamp: { stamp.withLock { $0 } }, now: { 0 })
        let first = cache.key(tool: "read_doc", arguments: .object(["path": .string("a"), "page": .int(1)]))
        let reordered = cache.key(tool: "read_doc", arguments: .object(["page": .int(1), "path": .string("a")]))
        #expect(first == reordered)
        #expect(cache.key(tool: "list_apple_fonts", arguments: .object([:])) == nil)

        let key = try #require(first)
        cache.store(.string("A"), for: key, tool: "read_doc", negative: false)
        #expect(cache.lookup(key, tool: "read_doc") == .string("A"))

        for path in ["b", "c"] {
            let other = try #require(cache.key(tool: "read_doc", arguments: .object(["path": .string(path)])))
            cache.store(.string(path), for: other, tool: "read_doc", negative: false)
        }
        #expect(cache.lookup(key, tool: "read_doc") == nil)  // evicted (capacity 2)

        let stamped = try #require(cache.key(tool: "read_doc", arguments: .object(["path": .string("c")])))
        stamp.withLock { $0 = "1:200" }
        #expect(cache.key(tool: "read_doc", arguments: .object(["path": .string("c")])) != stamped)
    }

    @Test func `negative results expire after their TTL`() throws {
        let clock = Mutex<UInt64>(0)
        let cache = MCPToolCache(
            sizes: ["search_docs": 4],
            negativeTTLMilliseconds: 30_000,
            stamp: { "s" },
            now: { clock.withLock { $0 } }
        )
        let key = try #require(cache.key(tool: "search_docs", arguments: .object(["query": .string("zz")])))
        cache.store(.object(["results": .array([])]), for: key, tool: "search_docs", negative: true)
        clock.withLock { $0 = 29_999 }
        #expect(cache.lookup(key, tool: "search_docs") != nil)
        clock.withLock { $0 = 30_000 }
        #expect(cache.lookup(key, tool: "search_docs") == nil)
    }
}
