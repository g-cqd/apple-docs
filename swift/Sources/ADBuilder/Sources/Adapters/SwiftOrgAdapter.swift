// SwiftOrgAdapter — the Swift.org documentation source (port of src/sources/swift-org.js). The
// NORMALIZE path is fully native + pure: HtmlNormalize.parse over ADHTML's real parser (replacing the
// JS regex parse-html.js) with the REAL cross-source LinkResolver (createLinkResolver's port —
// curated swift-org paths internalize to /docs/swift-org/<path>/), then the " | Swift.org" brand
// suffix strip and the entry-point cross-links (`applyArchiveCrossLinks`: a "Related Documentation"
// topics section + see_also relationships from the EntryPointRegistry). `discover` is a curated path
// list (syncMode `flat`); `fetch`/`check` are a plain rate-limited GET / conditional HEAD over the
// `HTTPClient` seam.
import Foundation
import HTTPTypes
import HTTPTypesFoundation

public struct SwiftOrgAdapter: SourceAdapter {
    public static let type = "swift-org"
    public static let displayName = "Swift.org Documentation"
    public static let syncMode = SyncMode.flat

    static let rootSlug = "swift-org"
    static let userAgent = "apple-docs/2.0"
    static let bodyLimit = 16 << 20
    static let curatedPathSet = Set(curatedPaths)

    /// The cross-source entry points other adapters contribute (swift-book +
    /// the swift-docc archives). Injectable for tests; defaults to the native
    /// registry (the JS module-global equivalent).
    public var entryPointRegistry: EntryPointRegistry = .native

    public init() {}

    // MARK: - normalize (pure)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .html(let html) = payload else {
            throw AdapterError.unexpectedPayload("swift-org expects html, got \(payload)")
        }
        let pageURL = Self.pageURL(forKey: key)
        let resolver = LinkResolver(swiftOrgPaths: Self.curatedPathSet, sourceURL: pageURL)
        var page = HtmlNormalize.parse(
            html, key: key, sourceType: Self.type, kind: "article", framework: Self.rootSlug,
            url: pageURL, preserveStructure: true, linkResolver: { resolver.resolve($0) })
        if let title = page.document.title {
            page.document.title = Self.stripBrandSuffix(title)
        }
        Self.applyArchiveCrossLinks(&page, key: key, registry: entryPointRegistry)
        return page
    }

    /// Port of `applyArchiveCrossLinks(result, key)`: when the entry-point
    /// registry has entries whose `parents` include this page, append a
    /// `topics` "Related Documentation" section (contentJson =
    /// `[{title, type: null, items: [{identifier, key, title, abstract}]}]`,
    /// stringify byte-parity via JsJson) and one `see_also` relationship per
    /// link (sortOrder continuing after the existing relationships).
    static func applyArchiveCrossLinks(
        _ page: inout NormalizedPage, key: String, registry: EntryPointRegistry
    ) {
        let links = registry.entryPoints(forParent: key)
        guard !links.isEmpty else { return }

        // `sections.length === 0 ? 0 : max(sortOrder ?? 0) + 1`.
        let order = page.sections.isEmpty ? 0 : (page.sections.map(\.sortOrder).max() ?? 0) + 1

        let items: [JsJson] = links.map { link in
            .object([
                ("identifier", .string(link.key)),
                ("key", .string(link.key)),
                ("title", .string(link.title)),
                (
                    "abstract",
                    link.summary.map { summary in
                        .array([.object([("type", .string("text")), ("text", .string(summary))])])
                    } ?? .null
                ),
            ])
        }
        // `${l.title}: ${l.summary ?? ''}`.trim() joined with newlines.
        let contentText = links.map { link -> String in
            let line = "\(link.title): \(link.summary ?? "")"
            return line.trimmingCharacters(in: .whitespacesAndNewlines)
        }.joined(separator: "\n")

        let contentJson = JsJson.array([
            .object([
                ("title", .string("Related Documentation")),
                ("type", .null),
                ("items", .array(items)),
            ])
        ]).serialized()

        page.sections.append(
            NormalizedSection(
                sectionKind: "topics", heading: "Related Documentation", contentText: contentText,
                contentJson: contentJson, sortOrder: order))

        var relOrder = page.relationships.count
        for link in links {
            page.relationships.append(
                NormalizedRelationship(
                    fromKey: key, toKey: link.key, relationType: "see_also",
                    section: "Related Documentation", sortOrder: relOrder))
            relOrder += 1
        }
    }

    // MARK: - network (over the HTTPClient seam)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let keys = Self.curatedPaths.map { "\(Self.rootSlug)/\($0)" }
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection", source: Self.rootSlug)
        return DiscoveryResult(keys: keys, roots: [root])
    }

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        guard let url = URL(string: Self.pageURL(forKey: key)) else {
            throw AdapterError.unexpectedPayload("swift-org: malformed URL for \(key)")
        }
        var head = HTTPRequest(url: url)
        head.method = .get
        head.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(head, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        return FetchResult(
            key: key, payload: .html(String(decoding: bytes, as: UTF8.self)), etag: response.etag,
            lastModified: response.lastModified)
    }

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        try await context.rateLimiter.acquire()
        guard let url = URL(string: Self.pageURL(forKey: key)) else {
            return CheckResult(status: .error, changed: false)
        }
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

    // MARK: - helpers

    /// `https://swift.org/<path>` for a key (`swift-org/install/linux` → `…/install/linux`).
    static func pageURL(forKey key: String) -> String {
        let prefix = "\(rootSlug)/"
        let path = key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
        return "https://swift.org/\(path)"
    }

    /// Drop a trailing " | Swift.org" / " - Swift.org" / " — Swift.org" brand suffix.
    static func stripBrandSuffix(_ title: String) -> String {
        for separator in [" | ", " - ", " — "] {
            guard let range = title.range(of: separator, options: .backwards) else { continue }
            let tail = title[range.upperBound...].trimmingCharacters(in: .whitespaces)
            if tail.caseInsensitiveCompare("Swift.org") == .orderedSame {
                let headText = title[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
                return headText.isEmpty ? title : headText
            }
        }
        return title
    }

    /// Curated Swift.org HTML pages (the JS `CURATED_PATHS`). Pages that are now DocC redirects are
    /// excluded (handled by the swift-docc adapter).
    static let curatedPaths: [String] = [
        "documentation", "documentation/api-design-guidelines", "documentation/standard-library",
        "documentation/core-libraries", "documentation/cxx-interop", "documentation/docc",
        "documentation/server", "documentation/swift-compiler", "documentation/lldb",
        "documentation/tspl", "documentation/continuous-integration", "documentation/source-code",
        "documentation/source-compatibility", "documentation/monthly-non-darwin-release",
        "documentation/server/guides/allocations.html", "documentation/server/guides/building.html",
        "documentation/server/guides/deployment.html", "documentation/server/guides/llvm-sanitizers.html",
        "documentation/server/guides/memory-leaks-and-usage.html",
        "documentation/server/guides/packaging.html", "documentation/server/guides/passkeys.html",
        "documentation/server/guides/performance.html", "documentation/server/guides/testing.html",
        "documentation/server/guides/libraries/concurrency-adoption-guidelines.html",
        "documentation/server/guides/libraries/log-levels.html",
        "documentation/articles/value-and-reference-types.html",
        "documentation/articles/getting-started-with-vscode-swift.html",
        "documentation/articles/getting-started-with-cursor-swift.html",
        "documentation/articles/static-linux-getting-started.html",
        "documentation/articles/swift-sdk-for-android-getting-started.html",
        "documentation/articles/wasm-getting-started.html",
        "documentation/articles/zero-to-swift-emacs.html",
        "documentation/articles/zero-to-swift-nvim.html",
        "documentation/articles/wrapping-c-cpp-library-in-swift.html", "getting-started",
        "getting-started/cli-swiftpm", "getting-started/library-swiftpm", "getting-started/swiftui",
        "getting-started/vapor-web-server", "install", "install/linux", "install/macos",
        "install/windows", "community", "community/how-we-work", "contributing", "about",
        "platform-support", "code-of-conduct", "diversity", "mentorship", "packages", "sswg",
        "sswg/incubation-process.html", "support/security.html", "openapi",
    ]
}
