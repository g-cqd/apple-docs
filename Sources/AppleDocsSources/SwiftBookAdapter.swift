public import AppleDocsCore
import Synchronization

/// The Swift Programming Language (`swiftlang/swift-book` `TSPL.docc/` — Bun `sources/swift-book.js`).
// @dl:disable -- adapter header + SourceAdapter conformance properties
public final class SwiftBookAdapter: SourceAdapter, Sendable {
    static let owner = "swiftlang"
    static let repo = "swift-book"
    static let branch = "main"
    static let rootSlug = "swift-book"
    static let contentPrefix = "TSPL.docc/"
    static let rootFile = "the-swift-programming-language"

    static let sectionTitles: [String: String] = [
        "guidedtour": "Welcome to Swift",
        "languageguide": "Language Guide",
        "referencemanual": "Language Reference",
        "revisionhistory": "Revision History"
    ]

    struct State: Sendable {
        var gitPathsByKey: [String: String] = [
            "swift-book/the-swift-programming-language": "The-Swift-Programming-Language",
            "swift-book/guidedtour": "GuidedTour/GuidedTour"
        ]
        var chapterKeysByName: [String: DocumentKey] = [:]
    }

    let state = Mutex(State())

    public init() {}

    public var kind: SourceKind { .swiftBook }
    public var displayName: String { "The Swift Programming Language" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .swiftBook,
            seedPath: "\(Self.rootSlug)/\(Self.rootFile)"
        )
    }

    public var seedKeys: [DocumentKey] {
        AdapterHelpers.singleSeed("\(Self.rootSlug)/\(Self.rootFile)")
    }

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let rel = try relativeGitPath(for: key)
        return GitHubClient.rawURL(
            owner: Self.owner,
            repo: Self.repo,
            branch: Self.branch,
            filePath: "\(Self.contentPrefix)\(rel).md"
        )
    }
    // @dl:enable

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let tree = try await GitHubClient.fetchTree(
            owner: Self.owner,
            repo: Self.repo,
            branch: Self.branch,
            client: client
        )
        var keys: [DocumentKey] = []
        var gitPaths: [String: String] = [:]
        var chapters: [String: DocumentKey] = [:]
        for entry in tree
        where entry.type == "blob" && entry.path.hasPrefix(Self.contentPrefix) && entry.path.hasSuffix(".md")
            && !entry.path.contains("/Snippets/")
        {
            let relative = String(entry.path.dropFirst(Self.contentPrefix.count).dropLast(".md".count))
            guard let key = try? DocumentKey("\(Self.rootSlug)/\(relative)") else { continue }
            keys.append(key)
            gitPaths[key.rawValue] = relative
            if let basename = relative.split(separator: "/").last.map({ $0.lowercased() }),
                basename != Self.rootFile
            {
                chapters[basename] = key
            }
        }
        state.withLock {
            $0.gitPathsByKey = gitPaths
            $0.chapterKeysByName = chapters
        }
        return SourceDiscovery(roots: [defaultRoot], keys: keys)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let rel = try relativeGitPath(for: key)
        let rawURL = try dataURL(for: key)
        return try await AdapterHelpers.fetchTransformed(
            url: rawURL,
            previousETag: previousETag,
            headers: GitHubClient.rawHeaders(),
            client: client
        ) { response in
            let markdown = String(decoding: response.body, as: UTF8.self)
            return (normalize(key: key, relativePath: rel, markdownBytes: response.body, markdown: markdown), [])
        }
    }

    private func relativeGitPath(for key: DocumentKey) throws(SourceError) -> String {
        let stripped = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        return state.withLock { $0.gitPathsByKey[key.rawValue] } ?? stripped
    }
}
