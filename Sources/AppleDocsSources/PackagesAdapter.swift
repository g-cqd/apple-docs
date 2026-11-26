import AemiJSONCore
public import AppleDocsCore
import Foundation

/// Swift Package Catalog (`apple/*`, `swiftlang/*` curated official set by default, or full
/// `SwiftPackageIndex/PackageList` on `--full` — Bun `sources/packages.js`).
public struct PackagesAdapter: SourceAdapter, Sendable {
    static let rootSlug = "packages"
    private static let packageListURL =
        "https://raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json"
    private static let readmeFilenames = ["README.md", "readme.md", "README.markdown"]
    private static let defaultBranches = ["main", "master"]

    // @dl:disable -- curated official apple/* and swiftlang/* Swift package inventory
    public static let officialPackages: [(owner: String, repo: String)] = [
        ("apple", "swift-argument-parser"),
        ("apple", "swift-async-algorithms"),
        ("apple", "swift-algorithms"),
        ("apple", "swift-collections"),
        ("apple", "swift-numerics"),
        ("apple", "swift-atomics"),
        ("apple", "swift-log"),
        ("apple", "swift-metrics"),
        ("apple", "swift-distributed-tracing"),
        ("apple", "swift-crypto"),
        ("apple", "swift-certificates"),
        ("apple", "swift-asn1"),
        ("apple", "swift-nio"),
        ("apple", "swift-nio-ssl"),
        ("apple", "swift-nio-http2"),
        ("apple", "swift-nio-transport-services"),
        ("apple", "swift-http-types"),
        ("apple", "swift-system"),
        ("apple", "swift-docc-plugin"),
        ("apple", "swift-format"),
        ("apple", "swift-openapi-generator"),
        ("apple", "swift-openapi-runtime"),
        ("apple", "swift-foundation"),
        ("swiftlang", "swift"),
        ("swiftlang", "swift-syntax"),
        ("swiftlang", "swift-package-manager"),
        ("swiftlang", "swift-docc"),
        ("swiftlang", "swift-testing"),
        ("swiftlang", "swift-evolution"),
        ("swiftlang", "swift-markdown")
    ]
    // @dl:enable

    // @dl:disable -- SourceAdapter conformance properties
    public init() {}

    public var kind: SourceKind { .packages }
    public var displayName: String { "Swift Package Catalog" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .packages,
            seedPath: "packages/apple/swift-collections"
        )
    }

    public var seedKeys: [DocumentKey] {
        Self.officialPackages.compactMap { try? DocumentKey("packages/\($0.owner)/\($0.repo)") }
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let (owner, repo) = try Self.parseKey(key)
        return GitHubClient.rawURL(owner: owner, repo: repo, branch: "main", filePath: "README.md")
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let envScope = ProcessInfo.processInfo.environment["APPLE_DOCS_PACKAGES_SCOPE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let useFull = envScope == "full" || (envScope != "official" && full)
        let limit = ProcessInfo.processInfo.environment["APPLE_DOCS_PACKAGES_LIMIT"].flatMap(Int.init)

        var seen: Set<String> = []
        var keys: [DocumentKey] = []
        func add(_ owner: String, _ repo: String) {
            if let limit, limit > 0, keys.count >= limit { return }
            let raw = "\(Self.rootSlug)/\(owner.lowercased())/\(repo.lowercased())"
            if seen.insert(raw).inserted, let key = try? DocumentKey(raw) {
                keys.append(key)
            }
        }
        for pkg in Self.officialPackages { add(pkg.owner, pkg.repo) }
        if !useFull {
            return SourceDiscovery(roots: [defaultRoot], keys: keys, isPartial: true)
        }

        let response = try await client.get(url: Self.packageListURL, headers: GitHubClient.rawHeaders())
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: Self.packageListURL)
        }
        let doc: JSONDocument
        do {
            doc = try AemiJSON.parse(response.body)
        } catch {
            throw .malformedPayload(url: Self.packageListURL, reason: "PackageList JSON parse error: \(error)")
        }
        for item in doc.root.array ?? [] {
            if let limit, limit > 0, keys.count >= limit { break }
            guard let urlText = item.string, let parsed = Self.parseGitHubRepoURL(urlText) else { continue }
            add(parsed.owner, parsed.repo)
        }
        return SourceDiscovery(roots: [defaultRoot], keys: keys, isPartial: false)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let (owner, repo) = try Self.parseKey(key)
        let prev = Self.parseCompositeETag(previousETag)

        if let prevETag = prev.readmeETag, let branch = prev.branch, let filename = prev.readmeFilename {
            let url = GitHubClient.rawURL(owner: owner, repo: repo, branch: branch, filePath: filename)
            switch try await client.conditionalGet(url: url, etag: prevETag, headers: GitHubClient.rawHeaders()) {
                case .notModified:
                    return .notModified
                case .ok(let response):
                    return buildOutcome(
                        key: key,
                        owner: owner,
                        repo: repo,
                        branch: branch,
                        filename: filename,
                        response: response
                    )
                case .gone:
                    break
            }
        }

        for branch in Self.defaultBranches {
            for filename in Self.readmeFilenames {
                let url = GitHubClient.rawURL(owner: owner, repo: repo, branch: branch, filePath: filename)
                if case .ok(let response) = try await client.conditionalGet(
                    url: url,
                    etag: nil,
                    headers: GitHubClient.rawHeaders()
                ) {
                    return buildOutcome(
                        key: key,
                        owner: owner,
                        repo: repo,
                        branch: branch,
                        filename: filename,
                        response: response
                    )
                }
            }
        }

        return Self.makeOutcome(
            ReadmeInputs(
                key: key,
                owner: owner,
                repo: repo,
                readmeBytes: nil,
                branch: "main",
                filename: nil,
                etag: nil
            )
        )
    }

    private func buildOutcome(
        key: DocumentKey,
        owner: String,
        repo: String,
        branch: String,
        filename: String,
        response: UpstreamFetchResponse
    ) -> SourceFetchOutcome {
        Self.makeOutcome(
            ReadmeInputs(
                key: key,
                owner: owner,
                repo: repo,
                readmeBytes: response.body,
                branch: branch,
                filename: filename,
                etag: response.etag
            )
        )
    }
}
