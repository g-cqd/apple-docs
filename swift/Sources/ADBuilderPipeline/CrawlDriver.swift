// CrawlDriver — the source-agnostic crawl loop. Resolves an adapter from the registry, discovers its
// keys, then fetch → normalize → persist each through the established seams (HTTPClient transport,
// ADHTML parser, CrawlPipeline persist boundary). Per-key failures are counted, not fatal, so one bad
// page never aborts a crawl. This is the orchestrator the `ad-build sync` verb drives.
//
// v1 scope: sequential, always-fetch. Follow-ups (each independent): the incremental `check` →
// crawl_state skip, bounded concurrency, and the post-crawl `IndexEmbeddings.run` pass. The
// content/raw hashes are SHA-256 of the raw payload (the JS raw hash); the JS content_hash uses the
// stable-stringified normalized doc, so cross-writer content-hash parity is a noted follow-up.

public import ADBuilder
public import ADDB

import ADWrite
import Crypto
import Foundation

public struct CrawlDriver: Sendable {
    /// Per-crawl outcome counts.
    public struct Stats: Sendable, Equatable {
        public var discovered = 0
        public var persisted = 0
        public var failed = 0
        public init() {}
    }

    private let registry: SourceRegistry
    public init(registry: SourceRegistry) { self.registry = registry }

    /// Crawl one source end-to-end into `db`. Discovers keys, then fetch → normalize → persist each.
    @discardableResult
    public func crawl(
        sourceType: String, into db: Database, rootId: Int64, context: SourceContext, now: String
    ) async throws -> Stats {
        let adapter = try registry.adapter(for: sourceType)
        let discovery = try await adapter.discover(context)

        var stats = Stats()
        stats.discovered = discovery.keys.count
        for key in discovery.keys {
            do {
                let fetched = try await adapter.fetch(key, context)
                let page = try adapter.normalize(fetched.key, fetched.payload)
                let hash = Self.sha256Hex(Self.rawBytes(fetched.payload))
                try CrawlPipeline.persist(
                    page, into: db, rootId: rootId, path: page.document.url ?? "/\(key)",
                    hashes: .init(content: hash, rawPayload: hash), now: now)
                stats.persisted += 1
            } catch {
                stats.failed += 1
            }
        }
        return stats
    }

    private static func rawBytes(_ payload: SourcePayload) -> [UInt8] {
        switch payload {
            case .html(let text), .markdown(let text): return Array(text.utf8)
            case .json(let bytes), .bytes(let bytes): return bytes
        }
    }

    private static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
    }
}
