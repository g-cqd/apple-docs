// HigAdapter — Apple's Human Interface Guidelines (port of src/sources/hig.js). A
// REFERENCE-FOLLOWING (`.crawl`) source: `discover` seeds the single HIG root + its
// landing page, then the crawl driver BFS-follows the DocC references `extractReferences`
// yields (every same-root `design/…` page). HIG pages are DocC JSON served from
// developer.apple.com's `/tutorials/data/design/…` base (the JS `api.js resolveUrl`
// `design/` branch), so `fetch` GETs that data URL (like SwiftDoccAdapter) and
// `normalize`/`extractReferences` delegate to the shared DocC helpers with NO key/URL
// overrides — the base normalizer already emits the `developer.apple.com/design/…` page
// URL for the `hig` source type (`DocC.buildURL`), and references resolve to `design/…`
// storage keys via `Identifier.normalize` (which preserves the `design/` namespace).
//
// Stateless (like SwiftEvolutionAdapter) — a `struct`; every step derives from the key.

import Foundation
import HTTPTypes
import HTTPTypesFoundation

public struct HigAdapter: SourceAdapter {
    public static let type = "hig"
    public static let displayName = "Human Interface Guidelines"
    public static let syncMode = SyncMode.crawl

    /// The corpus root slug (`extractRootSlug(key)` of every HIG key) — the crawl driver
    /// enqueues only references sharing this root.
    static let rootSlug = "design"
    /// The BFS seed: the HIG landing page (the JS `design/human-interface-guidelines`).
    static let seedKey = "design/human-interface-guidelines"
    /// The DocC data base (JS `APPLE_DOCS_API_BASE` default) — HIG keys live under `/design/`.
    static let tutorialsBase = "https://developer.apple.com/tutorials/data"
    static let userAgent = "apple-docs-mcp/1.0"
    static let bodyLimit = 64 << 20

    public init() {}

    // MARK: - discover (seed the single HIG root — no network; the driver drives the BFS)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        // `source` = the adapter type (JS `upsertRoot(slug, …, HigAdapter.type)`); `seedPath`
        // is where the driver starts the reference-following crawl for this root.
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "design",
            source: Self.type, seedPath: Self.seedKey)
        return DiscoveryResult(keys: [Self.seedKey], roots: [root])
    }

    // MARK: - fetch (the page's DocC data JSON)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        guard let url = URL(string: Self.dataUrl(key)) else {
            throw AdapterError.unexpectedPayload("hig: malformed data URL for \(key)")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        return FetchResult(
            key: key, payload: .json(bytes), etag: response.etag, lastModified: response.lastModified)
    }

    // MARK: - check (conditional HEAD on the data URL)

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        guard let url = URL(string: Self.dataUrl(key)) else {
            return CheckResult(status: .error, changed: false)
        }
        try await context.rateLimiter.acquire()
        var head = HTTPRequest(url: url)
        head.method = .head
        head.headerFields[.userAgent] = Self.userAgent
        if let previousState { head.headerFields[.ifNoneMatch] = previousState }
        do {
            let response = try await context.client.send(HTTPClientRequest(head, deadline: .seconds(30)))
            switch response.status.code {
                case 304: return CheckResult(status: .unchanged, changed: false, newState: previousState)
                case 404: return CheckResult(status: .deleted, changed: false, deleted: true)
                case 200 ..< 300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - normalize / extractReferences (shared DocC helpers, no key/URL overrides)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .json(let bytes) = payload else {
            throw AdapterError.unexpectedPayload("hig expects json, got \(payload)")
        }
        guard let page = DocC.normalizeDocC(jsonBytes: bytes, key: key, sourceType: Self.type) else {
            throw AdapterError.unexpectedPayload("hig: unparseable JSON for \(key)")
        }
        return page
    }

    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
        guard case .json(let bytes) = payload else { return [] }
        return DocC.extractReferences(jsonBytes: bytes)
    }

    // MARK: - URL scheme (port of api.js `resolveUrl`)

    /// The DocC data URL for a key — `design/…` keys ride the base directly (the JS
    /// `resolveUrl` `design/` branch); any other key gets the `/documentation/` prefix.
    static func dataUrl(_ key: String) -> String {
        if key.hasPrefix("design/") { return "\(tutorialsBase)/\(key).json" }
        return "\(tutorialsBase)/documentation/\(key).json"
    }
}
