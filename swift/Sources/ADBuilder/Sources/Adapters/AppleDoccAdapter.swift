// AppleDoccAdapter — the DOMINANT source: developer.apple.com DocC documentation (~350k pages).
// Port of src/sources/apple-docc.js PLUS the `discoverRoots` half of src/pipeline/discover.js.
//
// A REFERENCE-FOLLOWING (`.crawl`) source: the crawl driver owns the BFS over the `crawl_state`
// frontier; this adapter supplies discover / fetch / normalize / extractReferences. `discover`
// fetches Apple's technologies index and materializes EVERY documentation root from it (the JS
// `discoverRoots`: sections → groups → technologies, each group name mapped through `KIND_MAP`,
// each `tech.destination.identifier` canonicalized via `normalizeIdentifier` + `extractRootSlug`
// into a root slug) and seeds each root at its slug. Only the DocC framework roots are emitted;
// the explicit `design` (HIG) and `app-store-review` roots the JS `discoverRoots` also registers
// belong to OTHER adapters here (HigAdapter / the guidelines source) and Apple's index points to
// HIG via an `https://` destination that `normalizeIdentifier` rejects, so the loop naturally
// yields DocC roots only.
//
// fetch/check GET/HEAD the tutorials-data DocC JSON (the JS `api.js resolveUrl`); normalize /
// extractReferences delegate to the shared DocC helpers with NO key/URL overrides — the base
// normalizer already emits the `developer.apple.com/documentation/…` page URL for the `apple-docc`
// source type (`DocC.buildURL`), and apple-docc keys ARE the canonical documentation paths.
//
// Stateless (like HigAdapter / SwiftEvolutionAdapter) — a `struct`; every step derives from the key.

import ADBase
import ADJSONCore
import Foundation
import HTTPTypes
import HTTPTypesFoundation

public struct AppleDoccAdapter: SourceAdapter {
    public static let type = "apple-docc"
    public static let displayName = "Apple Developer Documentation"
    public static let syncMode = SyncMode.crawl

    /// The DocC data base (JS `APPLE_DOCS_API_BASE` default) — DocC keys live under `/documentation/`.
    static let tutorialsBase = "https://developer.apple.com/tutorials/data"
    static let userAgent = "apple-docs-mcp/1.0"
    static let bodyLimit = 64 << 20

    /// `KIND_MAP` (discover.js) — the technologies-index group name → root kind (`unknown` fallback).
    static let kindMap: [String: String] = [
        "App Frameworks": "framework",
        "App Services": "framework",
        "Developer Tools": "tooling",
        "Graphics and Games": "framework",
        "Media": "framework",
        "Release Notes": "release-notes",
        "System": "framework",
        "Web": "framework",
        "Design": "technology",
        "Technology Overviews": "technology",
        "Sample Code": "tutorial"
    ]

    public init() {}

    // MARK: - discover (build ALL DocC roots from the technologies index — the JS `discoverRoots`)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        // The single technologies index is essential (nothing to crawl without it), so a fetch/parse
        // failure propagates — matching the JS `discoverRoots` awaiting `fetchTechnologies`.
        let index = try await Self.fetchTechnologies(context)

        var keys: [String] = []
        var roots: [DiscoveredRoot] = []
        var seen = Set<String>()  // dedupe by slug (the JS `db.upsertRoot` → unique `getRoots()`).

        // sections → groups → technologies.
        index["sections"]
            .forEachElement { section in
                section["groups"]
                    .forEachElement { group in
                        let kind = Self.kindMap[group["name"].string ?? ""] ?? "unknown"
                        group["technologies"]
                            .forEachElement { tech in
                                // `normalizeIdentifier(tech.destination?.identifier)` — nil for non-page identifiers
                                // (full `https://` URLs, e.g. HIG's destination → rejected → not a DocC root here).
                                guard let id = Identifier.normalize(tech["destination"]["identifier"].string) else {
                                    return
                                }
                                let slug = Self.extractRootSlug(id)
                                guard !slug.isEmpty, seen.insert(slug).inserted else { return }
                                // `source` = the adapter type (JS `upsertRoot(slug, title, kind, 'apple-index')`;
                                // the roots `source_type` is derived downstream). Seed each root at its slug — the
                                // JS `keys: roots.map(root => root.slug)`, and DocC roots carry no explicit seed_path
                                // (`seedPath = root.seed_path ?? rootSlug` = the slug).
                                roots.append(
                                    DiscoveredRoot(
                                        slug: slug, displayName: tech["title"].string ?? "", kind: kind,
                                        source: Self.type))
                                keys.append(slug)
                            }
                    }
            }
        // Optional scope knob for the ~350k crawl: `AD_APPLEDOCC_SCOPE=swiftui,foundation` restricts the
        // discovered roots to the listed slugs, so a first pass can validate the BFS frontier on a framework
        // subset before widening to every root. Unset (or empty) ⇒ every DocC root (the JS default).
        if let scope = ProcessInfo.processInfo.environment["AD_APPLEDOCC_SCOPE"],
            !scope.trimmingCharacters(in: .whitespaces).isEmpty
        {
            let wanted = Set(scope.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
            roots = roots.filter { wanted.contains($0.slug) }
            keys = roots.map(\.slug)
        }
        return DiscoveryResult(keys: keys, roots: roots)
    }

    // MARK: - fetch (the page's DocC data JSON)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        guard let url = URL(string: Self.dataUrl(key)) else {
            throw AdapterError.unexpectedPayload("apple-docc: malformed data URL for \(key)")
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
            throw AdapterError.unexpectedPayload("apple-docc expects json, got \(payload)")
        }
        guard let page = DocC.normalizeDocC(jsonBytes: bytes, key: key, sourceType: Self.type) else {
            throw AdapterError.unexpectedPayload("apple-docc: unparseable JSON for \(key)")
        }
        return page
    }

    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
        guard case .json(let bytes) = payload else { return [] }
        return DocC.extractReferences(jsonBytes: bytes)
    }

    // MARK: - URL scheme + helpers (ports of api.js `resolveUrl` / `fetchTechnologies` + normalizer.js)

    /// The DocC data URL for a key (JS `resolveUrl`): `design/…` keys ride the base directly, any
    /// other key gets the `/documentation/` prefix.
    static func dataUrl(_ key: String) -> String {
        if key.hasPrefix("design/") { return "\(tutorialsBase)/\(key).json" }
        return "\(tutorialsBase)/documentation/\(key).json"
    }

    /// The technologies index URL (JS `fetchTechnologies`).
    static var technologiesUrl: String { "\(tutorialsBase)/documentation/technologies.json" }

    /// `extractRootSlug(canonicalPath)` (apple/normalizer.js) — the leading path segment (up to the
    /// first `/`); a slash-less path is its own slug.
    static func extractRootSlug(_ path: String) -> String { String(path.prefix { $0 != "/" }) }

    /// GET + parse the technologies index (JS `fetchTechnologies`). The returned `JSON` retains its
    /// backing document, so it is safe to hand back to `discover` for the sections walk.
    static func fetchTechnologies(_ context: SourceContext) async throws -> JSON {
        guard let url = URL(string: technologiesUrl) else {
            throw AdapterError.unexpectedPayload("apple-docc: malformed technologies URL")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        guard (200 ..< 300).contains(response.status.code) else {
            throw AdapterError.httpStatus(response.status.code, technologiesUrl)
        }
        let bytes = try await response.body.collect(upTo: bodyLimit)
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 64)) else {
            throw AdapterError.unexpectedPayload("apple-docc: unparseable technologies index")
        }
        return document.root
    }
}
