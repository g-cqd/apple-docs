// SourceAdapter — the crawl source contract (port of src/sources/base.js +
// registry.js). Each documentation source (apple-docc, hig, guidelines, wwdc,
// swift-evolution, …) conforms; the pipeline drives them uniformly:
//
//   discover → (per key) check / fetch → normalize → persist
//
// PURE boundary: `normalize` is a pure transform `(key, payload) → NormalizedPage`
// (no I/O, no ADWrite), so adapters + their parsers are testable in isolation while
// the storage siblings churn. Network-touching steps (discover/fetch/check) take a
// `SourceContext` carrying the `HTTPClient` transport + the `RateLimiter` (both
// ADBuilder types, so no HTTPTypes import is needed here).

/// The raw payload a `fetch` returns and `normalize` consumes — heterogeneous across
/// sources (DocC JSON, HTML, Markdown, an archive), modeled as a closed enum so the
/// registry can hold adapters without existential payload erasure.
public enum SourcePayload: Sendable, Equatable {
    case json([UInt8])
    case html(String)
    case markdown(String)
    case bytes([UInt8])
}

/// How a source is synced (JS `syncMode`).
public enum SyncMode: String, Sendable {
    case crawl
    case flat
    case manual
}

/// `discover()` result: the storage keys to (re)fetch + any roots to upsert.
public struct DiscoveryResult: Sendable, Equatable {
    public var keys: [String]
    public var roots: [DiscoveredRoot]
    public init(keys: [String], roots: [DiscoveredRoot] = []) {
        self.keys = keys
        self.roots = roots
    }
}

/// A documentation root an adapter contributes (→ `CrawlPersist.upsertRoot`).
public struct DiscoveredRoot: Sendable, Equatable {
    public var slug: String
    public var displayName: String
    public var kind: String
    public var source: String
    public var seedPath: String?
    public var sourceType: String?
    public init(
        slug: String, displayName: String, kind: String, source: String,
        seedPath: String? = nil, sourceType: String? = nil
    ) {
        self.slug = slug
        self.displayName = displayName
        self.kind = kind
        self.source = source
        self.seedPath = seedPath
        self.sourceType = sourceType
    }
}

/// `fetch()` result: the key, its raw payload, and the HTTP validators for the
/// incremental check (`ETag` / `Last-Modified`).
public struct FetchResult: Sendable, Equatable {
    public var key: String
    public var payload: SourcePayload
    public var etag: String?
    public var lastModified: String?
    public init(key: String, payload: SourcePayload, etag: String? = nil, lastModified: String? = nil) {
        self.key = key
        self.payload = payload
        self.etag = etag
        self.lastModified = lastModified
    }
}

/// `check()` result: whether the resource changed since `previousState`. `newState`
/// is the opaque validator (etag / hash) the adapter persists for the next check.
public struct CheckResult: Sendable, Equatable {
    public enum Status: String, Sendable { case unchanged, modified, deleted, error }
    public var status: Status
    public var changed: Bool
    public var newState: String?
    public var deleted: Bool
    public init(status: Status, changed: Bool, newState: String? = nil, deleted: Bool = false) {
        self.status = status
        self.changed = changed
        self.newState = newState
        self.deleted = deleted
    }
}

/// A cross-source entry point an adapter contributes (JS `EntryPoint`): a page that
/// should be linked TO from the declared `parents`.
public struct EntryPoint: Sendable, Equatable {
    public var slug: String
    public var key: String
    public var title: String
    public var summary: String?
    public var parents: [String]
    public init(slug: String, key: String, title: String, summary: String? = nil, parents: [String]) {
        self.slug = slug
        self.key = key
        self.title = title
        self.summary = summary
        self.parents = parents
    }
}

/// The crawl context threaded into the network-touching adapter steps: the transport
/// seam + the per-origin rate limiter (+ more as the pipeline grows: dataDir, config).
public struct SourceContext: Sendable {
    public let client: any HTTPClient
    public let rateLimiter: RateLimiter
    public init(client: any HTTPClient, rateLimiter: RateLimiter) {
        self.client = client
        self.rateLimiter = rateLimiter
    }
}

/// One documentation source. `discover`/`fetch`/`check` are async (network);
/// `normalize`/`extractReferences` are pure. Protocol extensions supply the JS
/// defaults (`requiresNetwork`/`syncMode`/`entryPoints`/`extractReferences`).
///
/// `init()` is required so the registry can vend a FRESH instance per crawl (the JS
/// `new AdapterClass()`): a stateful adapter (e.g. swift-book's `chapterIndex`, built
/// in `discover` and read in `normalize`) must not share state across crawls.
public protocol SourceAdapter: Sendable {
    init()

    /// The canonical source-type tag (the registry key), e.g. `"apple-docc"`.
    static var type: String { get }
    static var displayName: String { get }
    static var requiresNetwork: Bool { get }
    static var syncMode: SyncMode { get }
    static var entryPoints: [EntryPoint] { get }

    func discover(_ context: SourceContext) async throws -> DiscoveryResult
    func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult
    func check(_ key: String, previousState: String?, _ context: SourceContext) async throws -> CheckResult
    /// Pure transform — the heart of every adapter.
    func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage
    func extractReferences(_ key: String, _ payload: SourcePayload) -> [String]
}

extension SourceAdapter {
    public static var requiresNetwork: Bool { true }
    public static var syncMode: SyncMode { .crawl }
    public static var entryPoints: [EntryPoint] { [] }
    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] { [] }

    /// Instance-side accessor for the static `type` (convenience for the registry).
    public var type: String { Self.type }
}

/// The adapter registry (port of registry.js): source-type → adapter FACTORY. Built
/// from the adapter metatypes; `adapter(for:)` vends a fresh instance (the JS `new
/// AdapterClass()`), so stateful adapters never share state across crawls.
public struct SourceRegistry: Sendable {
    public enum RegistryError: Error, Sendable, Equatable {
        case unknownSourceType(String)
    }

    private let factories: [String: @Sendable () -> any SourceAdapter]

    public init(_ adapterTypes: [any SourceAdapter.Type]) {
        var byType: [String: @Sendable () -> any SourceAdapter] = [:]
        for adapterType in adapterTypes { byType[adapterType.type] = { adapterType.init() } }
        self.factories = byType
    }

    /// Resolve a FRESH adapter instance by source type, or throw `unknownSourceType`.
    public func adapter(for sourceType: String) throws -> any SourceAdapter {
        guard let make = factories[sourceType] else {
            throw RegistryError.unknownSourceType(sourceType)
        }
        return make()
    }

    public var types: [String] { Array(factories.keys).sorted() }
}
