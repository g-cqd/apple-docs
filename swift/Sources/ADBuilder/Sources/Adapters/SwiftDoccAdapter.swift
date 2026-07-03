// SwiftDoccAdapter — DocC archives published outside developer.apple.com that share the DocC JSON
// schema (Swift Compiler, Swift Package Manager, the Swift 6 migration guide). Port of
// src/sources/swift-docc.js. Each archive is its own corpus root; keys are
// `<slug>/documentation/<archive-internal-path>` derived from the archive's own index.json.
//
// A `flat` (self-enumerating) source: `discover` walks each archive's `index/index.json` for its
// page paths — no BFS. `normalize`/`extractReferences` delegate to the shared DocC normalizer with
// the archive's URL + key OVERRIDES: URLs point at docs.swift.org and references are re-scoped to
// `<slug>/documentation/…` storage keys (the `keyMapper` / `urlBuilder` opts B1 exposes).

import Foundation
import HTTPTypes
import HTTPTypesFoundation
import ADJSONCore

public final class SwiftDoccAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "swift-docc"
    public static let displayName = "Swift Documentation Archives"
    public static let syncMode = SyncMode.flat

    /// One DocC archive (the JS `ARCHIVES` table value + its entry point).
    struct Archive: Sendable {
        let slug: String
        let displayName: String
        let kind: String
        let baseUrl: String
        let entryKey: String
        let entryTitle: String
        let entrySummary: String
        let parents: [String]
    }

    /// The archives, in the JS object-literal order (drives root + entry-point + key ordering).
    static let archives: [Archive] = [
        Archive(
            slug: "swift-compiler", displayName: "Swift Compiler", kind: "tooling",
            baseUrl: "https://docs.swift.org/compiler",
            entryKey: "swift-compiler/documentation/diagnostics",
            entryTitle: "Swift Compiler Diagnostics",
            entrySummary:
                "Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.",
            parents: ["swift-org/documentation", "swift-org/documentation/swift-compiler"]),
        Archive(
            slug: "swift-package-manager", displayName: "Swift Package Manager", kind: "tooling",
            baseUrl: "https://docs.swift.org/swiftpm",
            entryKey: "swift-package-manager/documentation/packagemanagerdocs",
            entryTitle: "Swift Package Manager",
            entrySummary:
                "Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.",
            parents: ["swift-org/documentation", "swift-org/getting-started"]),
        Archive(
            slug: "swift-migration-guide", displayName: "Swift 6 Concurrency Migration Guide",
            kind: "guide", baseUrl: "https://www.swift.org/migration",
            entryKey: "swift-migration-guide/documentation/migrationguide",
            entryTitle: "Swift 6 Concurrency Migration Guide",
            entrySummary:
                "How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.",
            parents: ["swift-org/documentation"]),
    ]

    public static let entryPoints: [EntryPoint] = archives.map {
        EntryPoint(
            slug: $0.slug, key: $0.entryKey, title: $0.entryTitle, summary: $0.entrySummary,
            parents: $0.parents)
    }

    static let userAgent = "apple-docs-mcp/1.0"
    static let bodyLimit = 64 << 20

    public init() {}

    // MARK: - discover (walk each archive index.json)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        var keys: [String] = []
        var roots: [DiscoveredRoot] = []
        for archive in Self.archives {
            // `source` = the adapter type (JS `upsertRoot(slug, …, SwiftDoccAdapter.type)`); the roots
            // source_type is then derived (nil → deriveRootSourceType), matching the JS.
            roots.append(
                DiscoveredRoot(
                    slug: archive.slug, displayName: archive.displayName, kind: archive.kind,
                    source: Self.type))
            // A per-archive index failure is non-fatal (the JS logs + yields no keys for that slug).
            let paths = (try? await Self.fetchIndexPaths(archive, context)) ?? []
            for path in paths { keys.append(Self.pathToKey(archive.slug, path)) }
        }
        return DiscoveryResult(keys: keys, roots: roots)
    }

    // MARK: - fetch (the archive's data JSON)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let (archive, path) = try Self.archiveAndPath(forKey: key)
        guard let url = URL(string: Self.dataUrl(archive, path)) else {
            throw AdapterError.unexpectedPayload("swift-docc: malformed data URL for \(key)")
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
        guard let (archive, path) = try? Self.archiveAndPath(forKey: key),
            let url = URL(string: Self.dataUrl(archive, path))
        else { return CheckResult(status: .error, changed: false) }
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
                case 200..<300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - normalize / extractReferences (shared DocC normalizer + archive overrides)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .json(let bytes) = payload else {
            throw AdapterError.unexpectedPayload("swift-docc expects json, got \(payload)")
        }
        let (archive, _) = try Self.archiveAndPath(forKey: key)
        let slug = archive.slug
        guard
            let page = DocC.normalizeDocC(
                jsonBytes: bytes, key: key, sourceType: Self.type,
                keyMapper: { Self.addArchivePrefix(slug, $0) },
                urlBuilder: { Self.keyToPath(slug, $0).map { Self.pageUrl(archive, $0) } })
        else {
            throw AdapterError.unexpectedPayload("swift-docc: unparseable JSON for \(key)")
        }
        return page
    }

    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
        guard case .json(let bytes) = payload, let (archive, _) = try? Self.archiveAndPath(forKey: key)
        else { return [] }
        let slug = archive.slug
        return DocC.extractReferences(jsonBytes: bytes).map { Self.addArchivePrefix(slug, $0) }
    }

    // MARK: - index walk + key/path helpers (ports of swift-docc.js)

    /// `collectIndexPaths(index)` — every `path` string under `interfaceLanguages.swift`, DFS pre-order.
    static func collectIndexPaths(_ index: JSON) -> [String] {
        let swift = index["interfaceLanguages"]["swift"]
        guard swift.isArray else { return [] }
        var out: [String] = []
        func walk(_ node: JSON) {
            guard node.isObject else { return }
            if let path = node["path"].string { out.append(path) }
            let children = node["children"]
            if children.isArray { children.forEachElement { walk($0) } }
        }
        swift.forEachElement { walk($0) }
        return out
    }

    /// `pathToKey(slug, internalPath)` — `<slug>/<lowercased internal path (no leading slash)>`.
    static func pathToKey(_ slug: String, _ internalPath: String) -> String {
        let trimmed = internalPath.hasPrefix("/") ? String(internalPath.dropFirst()) : internalPath
        return "\(slug)/\(trimmed.lowercased())"
    }

    /// `keyToPath(slug, key)` — the archive-internal path (`/…`), or nil when the key isn't the slug's.
    static func keyToPath(_ slug: String, _ key: String) -> String? {
        let prefix = "\(slug)/"
        guard key.hasPrefix(prefix) else { return nil }
        return "/\(key.dropFirst(prefix.count))"
    }

    /// `addArchivePrefix(slug, internalKey)` — restore the `<slug>/documentation/` scope on a resolved
    /// reference key (`''` and already-scoped keys pass through).
    static func addArchivePrefix(_ slug: String, _ internalKey: String) -> String {
        if internalKey.isEmpty { return internalKey }
        if internalKey.hasPrefix("\(slug)/") { return internalKey }
        return "\(slug)/documentation/\(internalKey)"
    }

    static func archive(forSlug slug: String) -> Archive? { archives.first { $0.slug == slug } }

    /// Resolve a key to its archive + internal path (`archiveForKey`), throwing on an unknown slug.
    static func archiveAndPath(forKey key: String) throws -> (Archive, String) {
        let slug = String(key.prefix { $0 != "/" })  // extractRootSlug
        guard let archive = archive(forSlug: slug) else {
            throw AdapterError.unexpectedPayload("swift-docc: unknown archive slug '\(slug)'")
        }
        guard let path = keyToPath(slug, key) else {
            throw AdapterError.unexpectedPayload("swift-docc: key '\(key)' not in archive '\(slug)'")
        }
        return (archive, path)
    }

    static func indexUrl(_ archive: Archive) -> String { "\(archive.baseUrl)/index/index.json" }
    static func dataUrl(_ archive: Archive, _ path: String) -> String { "\(archive.baseUrl)/data\(path).json" }
    static func pageUrl(_ archive: Archive, _ path: String) -> String { "\(archive.baseUrl)\(path)" }

    /// GET + parse one archive's index.json into its page paths.
    private static func fetchIndexPaths(_ archive: Archive, _ context: SourceContext) async throws
        -> [String]
    {
        guard let url = URL(string: indexUrl(archive)) else { return [] }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        guard (200..<300).contains(response.status.code) else {
            throw AdapterError.httpStatus(response.status.code, indexUrl(archive))
        }
        let bytes = try await response.body.collect(upTo: bodyLimit)
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 64)) else {
            return []
        }
        return collectIndexPaths(document.root)
    }
}
