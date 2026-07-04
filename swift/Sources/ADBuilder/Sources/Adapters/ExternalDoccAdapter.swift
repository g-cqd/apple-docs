// ExternalDoccAdapter — DocC archives Apple references from OUTSIDE developer.apple.com. Port of
// src/sources/external-docc.js. `technologies.json` links a few documentation sets hosted on
// third-party origins — CareKit (GitHub Pages), the Private Cloud Compute Security Guide
// (security.apple.com) and Swift's DocC manual (swift.org). They share the DocC JSON schema, so
// each becomes its own root, normalised exactly like the Apple corpus except the rendered URL
// points back at the upstream host.
//
// Key form = the canonical doc path (`carekit`, `carekit/octask`) — the archive slug EQUALS the
// doc-path root segment, so references resolve to slug-scoped keys with no remapping (only a
// `urlBuilder` override; no `keyMapper`), unlike SwiftDoccAdapter's `<slug>/documentation/…` keys.
//
// A `flat` (self-enumerating) source. `discover` = a live probe of `technologies.json` for external
// DocC destinations BEYOND the always-on curated set (docc-url shape recognition + a real-payload
// probe), then per archive an ADAPTER-INTERNAL enumeration: `index/index.json` when present, else a
// bounded internal BFS (`enumerateBfs`, capped at `maxBfsPages`) — this BFS is internal to discover,
// NOT the driver's crawl_state BFS (discover still returns the full flat key list).
//
// A `final class` (like AppleArchiveAdapter): the archive table is seeded with the curated set in
// `init` and GROWN by `discover`'s detection, then read by `fetch`/`check`/`normalize` on the same
// instance (the registry vends a fresh instance per crawl, so no cross-crawl state leaks).

// swiftlint:disable large_tuple type_body_length

import ADJSONCore
import Foundation
import HTTPTypes
import HTTPTypesFoundation

public final class ExternalDoccAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "external-docc"
    public static let displayName = "External DocC Archives"
    public static let syncMode = SyncMode.flat

    /// One external DocC archive (the JS `CURATED_ARCHIVES` / detected-archive value).
    struct Archive: Sendable {
        let displayName: String
        let kind: String
        /// Base URL — case matters (GitHub Pages is case-sensitive).
        let baseUrl: String
    }

    /// Always-on archives (deterministic inclusion), in the JS object-literal order.
    static let curatedArchives: [(slug: String, archive: Archive)] = [
        (
            "carekit",
            Archive(
                displayName: "CareKit", kind: "framework",
                baseUrl: "https://carekit-apple.github.io/CareKit")
        ),
        (
            "private-cloud-compute",
            Archive(
                displayName: "Private Cloud Compute Security Guide",
                kind: "guide", baseUrl: "https://security.apple.com")
        ),
        ("docc", Archive(displayName: "DocC", kind: "tooling", baseUrl: "https://www.swift.org"))
    ]

    static let userAgent = "apple-docs-mcp/1.0"
    static let bodyLimit = 64 << 20
    static let maxBfsPages = 5000
    /// `fetchTechnologies` target (JS `${TUTORIALS_BASE}/documentation/technologies.json`). Hardcoded
    /// like AppleArchiveAdapter's base (the JS `APPLE_DOCS_API_BASE` env override is not honored).
    static let technologiesURL = "https://developer.apple.com/tutorials/data/documentation/technologies.json"

    // slug -> Archive, seeded with the curated set so fetch/check/normalize resolve even before
    // discover runs (e.g. an incremental update of an already-stored curated page). `discover` may
    // add probe-confirmed detections. `order` preserves curated-first, then detection order (the JS
    // `Object.entries` insertion order) so discover emits roots + keys deterministically.
    private var archives: [String: Archive]
    private var archiveOrder: [String]

    public init() {
        var byslug: [String: Archive] = [:]
        var order: [String] = []
        for (slug, archive) in Self.curatedArchives {
            byslug[slug] = archive
            order.append(slug)
        }
        self.archives = byslug
        self.archiveOrder = order
    }

    // MARK: - discover (detect beyond curated, then enumerate every archive)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        // Probe-gated detection beyond the curated set is non-fatal (the JS logs + carries on with
        // just the curated archives when technologies.json can't be fetched/parsed).
        try? await detectFromTechnologies(context)

        var keys: [String] = []
        var roots: [DiscoveredRoot] = []
        for slug in archiveOrder {
            guard let archive = archives[slug] else { continue }
            // JS `upsertRoot(slug, displayName, kind, type, seedPath=slug, sourceType=type)`. The DB
            // ownership skip (a slug already owned by another source_type) is driver-side here — the
            // Swift SourceContext carries no `db`, matching SwiftDoccAdapter's port.
            roots.append(
                DiscoveredRoot(
                    slug: slug, displayName: archive.displayName, kind: archive.kind,
                    source: Self.type, seedPath: slug, sourceType: Self.type))
            keys.append(contentsOf: await enumerate(slug, archive, context))
        }
        return DiscoveryResult(keys: keys, roots: roots)
    }

    // MARK: - fetch (the archive's data JSON) — mirrors SwiftDoccAdapter.fetch

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let (_, archive) = try resolveArchive(key)
        guard let url = URL(string: Self.dataURL(archive.baseUrl, key)) else {
            throw AdapterError.unexpectedPayload("external-docc: malformed data URL for \(key)")
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

    // MARK: - check (conditional HEAD on the data URL) — mirrors SwiftDoccAdapter.check

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        guard let (_, archive) = try? resolveArchive(key),
            let url = URL(string: Self.dataURL(archive.baseUrl, key))
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
                case 200 ..< 300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - normalize / extractReferences (shared DocC normalizer + archive URL override)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .json(let bytes) = payload else {
            throw AdapterError.unexpectedPayload("external-docc expects json, got \(payload)")
        }
        let (_, archive) = try resolveArchive(key)
        let baseUrl = archive.baseUrl
        // Only a `urlBuilder` override — the rendered page lives at the UPSTREAM host. No `keyMapper`:
        // the slug equals the doc-path root segment, so refs already resolve to slug-scoped keys.
        guard
            let page = DocC.normalizeDocC(
                jsonBytes: bytes, key: key, sourceType: Self.type,
                keyMapper: nil, urlBuilder: { Self.pageURL(baseUrl, $0) })
        else {
            throw AdapterError.unexpectedPayload("external-docc: unparseable JSON for \(key)")
        }
        return page
    }

    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
        guard case .json(let bytes) = payload, let (slug, _) = try? resolveArchive(key) else { return [] }
        // Keep only same-archive references (the JS `.filter(ref => extractRootSlug(ref) === slug)`).
        return DocC.extractReferences(jsonBytes: bytes).filter { Self.extractRootSlug($0) == slug }
    }

    // MARK: - detection (technologies.json → probe-confirmed external DocC archives)

    /// Add DocC archives Apple references beyond the curated set (probe-gated). Throws when
    /// technologies.json can't be fetched/parsed — `discover` swallows it.
    func detectFromTechnologies(_ context: SourceContext) async throws {
        let bytes = try await fetchTechnologiesBytes(context)
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512)) else {
            throw AdapterError.unexpectedPayload("external-docc: technologies.json did not parse")
        }
        // First-seen candidates (the walk is synchronous; the probe awaits, so collect then probe —
        // behaviour-equivalent to the JS inline probe since `seen`/`archives` dedupe by slug).
        var seen = Set<String>()
        var candidates: [(slug: String, baseUrl: String, entryKey: String, title: String?)] = []
        document.root["sections"]
            .forEachElement { section in
                section["groups"]
                    .forEachElement { group in
                        group["technologies"]
                            .forEachElement { tech in
                                guard let id = tech["destination"]["identifier"].string,
                                    let parsed = Self.parseDoccArchiveUrl(id),
                                    archives[parsed.slug] == nil, !seen.contains(parsed.slug)
                                else { return }
                                seen.insert(parsed.slug)
                                candidates.append(
                                    (parsed.slug, parsed.baseUrl, parsed.entryKey, tech["title"].string))
                            }
                    }
            }
        for candidate in candidates where await probe(candidate.baseUrl, candidate.entryKey, context) {
            archives[candidate.slug] = Archive(
                displayName: candidate.title ?? candidate.slug, kind: "framework",
                baseUrl: candidate.baseUrl)
            archiveOrder.append(candidate.slug)
        }
    }

    /// Confirm a detected URL is a REAL DocC archive by fetching its entry data URL (never throws —
    /// any failure/non-DocC payload ⇒ `false`, the JS try/catch). Probe uses one retry (PROBE_OPTS).
    func probe(_ baseUrl: String, _ entryKey: String, _ context: SourceContext) async -> Bool {
        guard let url = URL(string: Self.dataURL(baseUrl, entryKey)) else { return false }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        do {
            let response = try await RetryPolicy.fetchWithRetry(
                HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
                rateLimiter: context.rateLimiter, config: RetryConfig(maxRetries: 1))
            guard (200 ..< 300).contains(response.status.code) else { return false }
            let bytes = try await response.body.collect(upTo: Self.bodyLimit)
            guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512))
            else { return false }
            return Self.isDoccPayload(document.root)
        } catch {
            return false
        }
    }

    // MARK: - per-archive enumeration (index first, bounded internal BFS fallback)

    /// Prefer `index/index.json` (one request, complete); fall back to a bounded BFS for archives
    /// that ship without one (CareKit's older DocC has no linkable index).
    func enumerate(_ slug: String, _ archive: Archive, _ context: SourceContext) async -> [String] {
        let fromIndex = await enumerateIndex(slug, archive, context)
        if !fromIndex.isEmpty { return fromIndex }
        return await enumerateBfs(slug, archive, context)
    }

    /// `index/index.json` → slug-scoped keys (deduped, first-seen order). `[]` on any failure.
    func enumerateIndex(_ slug: String, _ archive: Archive, _ context: SourceContext) async -> [String] {
        guard let url = URL(string: Self.indexURL(archive.baseUrl)) else { return [] }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        do {
            let response = try await RetryPolicy.fetchWithRetry(
                HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
                rateLimiter: context.rateLimiter, config: RetryConfig(maxRetries: 1))
            guard (200 ..< 300).contains(response.status.code) else { return [] }
            let bytes = try await response.body.collect(upTo: Self.bodyLimit)
            guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512))
            else { return [] }
            var keys: [String] = []
            var seen = Set<String>()
            // Reuse SwiftDoccAdapter's index walk (identical `interfaceLanguages.swift` tree).
            for path in SwiftDoccAdapter.collectIndexPaths(document.root) {
                guard let key = Self.indexPathToKey(path), !key.isEmpty,
                    Self.extractRootSlug(key) == slug, seen.insert(key).inserted
                else { continue }
                keys.append(key)
            }
            return keys
        } catch {
            return []
        }
    }

    /// A bounded internal BFS from the slug seed (JS `enumerateBfs`, capped at `maxBfsPages`). A
    /// missing child is non-fatal — it is dropped from the visited set. Returns visited in first-seen
    /// (insertion) order, matching the JS `[...visited]`.
    func enumerateBfs(_ slug: String, _ archive: Archive, _ context: SourceContext) async -> [String] {
        var visited = Set<String>()
        var order: [String] = []
        var queue: [String] = [slug]
        var head = 0
        while head < queue.count, visited.count < Self.maxBfsPages {
            let key = queue[head]
            head += 1
            if visited.contains(key) { continue }
            visited.insert(key)
            order.append(key)
            guard let url = URL(string: Self.dataURL(archive.baseUrl, key)) else {
                visited.remove(key)
                order.removeLast()
                continue
            }
            var get = HTTPRequest(url: url)
            get.method = .get
            get.headerFields[.userAgent] = Self.userAgent
            do {
                let response = try await RetryPolicy.fetchWithRetry(
                    HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
                    rateLimiter: context.rateLimiter, config: RetryConfig(maxRetries: 1))
                guard (200 ..< 300).contains(response.status.code) else {
                    visited.remove(key)
                    order.removeLast()
                    continue
                }
                let bytes = try await response.body.collect(upTo: Self.bodyLimit)
                guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512))
                else {
                    visited.remove(key)
                    order.removeLast()
                    continue
                }
                for ref in DocC.extractReferences(document.root)
                where Self.extractRootSlug(ref) == slug && !visited.contains(ref) {
                    queue.append(ref)
                }
            } catch {
                visited.remove(key)  // a missing child is non-fatal — drop it
                order.removeLast()
            }
        }
        return order
    }

    // MARK: - archive resolution + pure helpers (ports of the JS helpers)

    /// `resolveArchive(key)` — the archive owning `key`'s root slug, throwing on an unknown slug.
    func resolveArchive(_ key: String) throws -> (slug: String, archive: Archive) {
        let slug = Self.extractRootSlug(key)
        guard let archive = archives[slug] else {
            throw AdapterError.unexpectedPayload("external-docc: unknown archive slug '\(slug)'")
        }
        return (slug, archive)
    }

    /// `extractRootSlug` — the first path segment (before the first `/`); `""` for an empty key.
    static func extractRootSlug(_ path: String) -> String { String(path.prefix { $0 != "/" }) }

    static func dataURL(_ baseUrl: String, _ key: String) -> String {
        "\(baseUrl)/data/documentation/\(key).json"
    }
    static func pageURL(_ baseUrl: String, _ key: String) -> String { "\(baseUrl)/documentation/\(key)" }
    static func indexURL(_ baseUrl: String) -> String { "\(baseUrl)/index/index.json" }

    /// `'/documentation/carekit/octask' → 'carekit/octask'` (our storage-key form): the
    /// case-insensitive `/documentation/` prefix stripped, trailing slashes dropped, lowercased.
    /// `nil` when the path isn't a `/documentation/…` path.
    static func indexPathToKey(_ path: String) -> String? {
        let lower = path.lowercased()
        let prefix = "/documentation/"
        guard lower.hasPrefix(prefix) else { return nil }
        var rest = String(lower.dropFirst(prefix.count))
        guard !rest.isEmpty else { return nil }  // /(.+)/ — at least one char after the prefix
        while rest.hasSuffix("/") { rest.removeLast() }
        return rest
    }

    /// A minimal DocC JSON shape check, used to confirm a detected URL is real (JS `isDoccPayload`):
    /// an object with a `schemaVersion` OBJECT and any of `identifier.url` / `metadata` / `kind`.
    static func isDoccPayload(_ data: JSON) -> Bool {
        guard data.isObject else { return false }
        guard data["schemaVersion"].isObject else { return false }
        return data["identifier"]["url"].isTruthy || data["metadata"].isTruthy || data["kind"].isTruthy
    }

    /// Recognise an external DocC archive from a URL alone (JS `parseDoccArchiveUrl`, docc-url.js) —
    /// HTTPS-only, not developer.apple.com, a `/documentation/<path>` shape with no operator segment.
    /// `baseUrl` keeps its prefix case (GitHub Pages is case-sensitive); `slug`/`entryKey` lowercased.
    static func parseDoccArchiveUrl(_ rawUrl: String) -> (slug: String, baseUrl: String, entryKey: String)? {
        guard let url = URL(string: rawUrl), let scheme = url.scheme, scheme.lowercased() == "https"
        else { return nil }
        guard let host = url.host()?.lowercased(), !host.isEmpty else { return nil }
        // developer.apple.com is the primary corpus (apple-docc adapter) — never re-handle it here.
        if host == "developer.apple.com" || host.hasSuffix(".developer.apple.com") { return nil }

        let pathname = url.path(percentEncoded: true)
        guard let segRange = pathname.range(of: "/documentation/") else { return nil }
        // Everything before `/documentation/` is the archive path prefix (empty for a root-hosted
        // archive, `/CareKit` for the GitHub Pages project site). Case is preserved.
        let prefix = String(pathname[..<segRange.lowerBound])
        var rest = String(pathname[segRange.upperBound...])
        while rest.hasSuffix("/") { rest.removeLast() }
        rest = rest.lowercased()
        guard !rest.isEmpty else { return nil }

        let segments = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for seg in segments {
            if seg.isEmpty { return nil }
            if isOperatorSegment(seg) { return nil }
        }
        var authority = host
        if let port = url.port { authority += ":\(port)" }
        return (slug: segments[0], baseUrl: "https://\(authority)\(prefix)", entryKey: rest)
    }

    /// `/^\.[.\-+*/<>=!&|^~%_]/` — a doc segment that is clearly a Swift operator, not a page.
    static func isOperatorSegment(_ segment: String) -> Bool {
        var it = segment.unicodeScalars.makeIterator()
        guard it.next() == "." else { return false }
        guard let second = it.next() else { return false }
        let ops: Set<Unicode.Scalar> = [
            ".", "-", "+", "*", "/", "<", ">", "=", "!", "&", "|", "^", "~", "%", "_"
        ]
        return ops.contains(second)
    }

    // MARK: - technologies.json fetch

    /// GET technologies.json bytes (JS `fetchTechnologies`, default retries), throwing on non-2xx.
    private func fetchTechnologiesBytes(_ context: SourceContext) async throws -> [UInt8] {
        guard let url = URL(string: Self.technologiesURL) else {
            throw AdapterError.unexpectedPayload("external-docc: malformed technologies URL")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        guard (200 ..< 300).contains(response.status.code) else {
            throw AdapterError.httpStatus(response.status.code, Self.technologiesURL)
        }
        return try await response.body.collect(upTo: Self.bodyLimit)
    }
}
